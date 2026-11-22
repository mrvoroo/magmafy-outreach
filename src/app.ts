import { Store } from './db/store.js';
import { CrmPort } from './crm/contract.js';
import { CrmSync } from './crm/sync.js';
import { WhatsAppPort } from './sender/port.js';
import { AiPort } from './personalize/ai.js';
import { PlacesPort } from './sourcing/places.js';
import { WebPort } from './enrich/web.js';
import { Enricher } from './enrich/enricher.js';
import { Sourcer } from './sourcing/sourcer.js';
import { Personalizer } from './personalize/personalizer.js';
import { Planner, DueFollowup } from './planner/planner.js';
import { Breaker } from './sender/breaker.js';
import { Sender, TickResult } from './sender/sender.js';
import { Inbox } from './inbox/inbox.js';
import { FollowupEngine } from './followup/engine.js';
import { ControlBot, TelegramPort } from './control/bot.js';
import { buildDailySummary, buildWeeklyReport } from './metrics/reports.js';
import { Rng } from './util/rng.js';
import { Logger, nullLogger } from './util/log.js';
import { dayKey, zonedParts } from './util/time.js';

export interface AppDeps { store: Store; crm: CrmPort; wa: WhatsAppPort; ai: AiPort; tg: TelegramPort; env: Record<string, string | undefined>; places?: PlacesPort; web?: WebPort; rng?: Rng; sleep?: (ms: number) => Promise<void>; log?: Logger; pair?: (digits: string) => Promise<string> }

/** Wires every component together and exposes the jobs the scheduler runs. */
export class App {
  readonly store: Store; readonly sync: CrmSync; readonly planner: Planner; readonly breaker: Breaker; readonly sender: Sender; readonly inbox: Inbox; readonly personalizer: Personalizer; readonly followups: FollowupEngine; readonly bot: ControlBot; readonly sourcer?: Sourcer;
  private cachedDue: DueFollowup[] = []; private log: Logger;
  constructor(private d: AppDeps) {
    this.store = d.store; this.log = d.log ?? nullLogger;
    const alert = (m: string, o?: { urgent?: boolean }) => { this.d.tg.send(m, o).catch((e) => this.log.error('telegram send failed', { err: String(e) })); };
    this.sync = new CrmSync(d.store, d.crm, this.log, alert, { paceMs: 1000, sleep: d.sleep });
    this.planner = new Planner(d.store, { rng: d.rng, dueFollowups: () => this.cachedDue });
    this.breaker = new Breaker(d.store, this.planner, alert);
    this.sender = new Sender({ store: d.store, planner: this.planner, wa: d.wa, breaker: this.breaker, sync: this.sync, alert, env: d.env, rng: d.rng, sleep: d.sleep, log: this.log });
    this.inbox = new Inbox({ store: d.store, sync: this.sync, alert, ai: d.ai, log: this.log });
    this.personalizer = new Personalizer(d.store, d.ai, this.sync, this.log);
    this.followups = new FollowupEngine(d.store, this.personalizer, this.sync);
    this.bot = new ControlBot({ store: d.store, planner: this.planner, breaker: this.breaker, sender: this.sender, inbox: this.inbox, wa: d.wa, ownerId: d.env.TELEGRAM_OWNER_ID ?? '', pair: d.pair });
    if (d.places && d.web) this.sourcer = new Sourcer(d.store, d.places, new Enricher(d.store, d.web), this.log);
    this.alertFn = alert;
  }
  alertFn: (m: string, o?: { urgent?: boolean }) => void;

  /** Start-up: wire WhatsApp events, then reconcile any dangling send intent (never a blind retry). */
  async start() {
    this.d.wa.onInbound((m) => { this.inbox.handle(m).catch((e) => this.log.error('inbox failed', { err: String(e) })); });
    this.d.wa.onEvent((e) => { this.breaker.onWaEvent(e); if (e.type === 'receipt') this.store.db.run("UPDATE messages SET delivery_status=? WHERE wa_message_id=? AND (delivery_status IS NULL OR delivery_status!='read')", e.status, e.messageId); if (e.type === 'qr') this.alertFn('WhatsApp QR code received (use /pair instead of scanning).'); });
    this.bot.wire(this.d.tg);
    const r = await this.sender.reconcileIntents(); this.log.info('start-up reconcile', r);
    return r;
  }

  /** Once each morning (idempotent): CRM changes in, follow-ups prepared, pool topped up, today's plan made, reminders. */
  async morning(): Promise<{ planned: number; prepared: number; due: number }> {
    const s = this.store.settings(); const day = dayKey(this.store.clock.now(), s.timeZone);
    try { await this.sync.pullChanges(); } catch (e) { this.log.warn('pullChanges failed', { err: String(e) }); }
    this.store.purgeExpired();
    this.cachedDue = await this.followups.dueFor(day);
    this.followups.closeNoReply(day);
    const prepared = await this.fillPool();
    const plan = this.planner.ensurePlan(day);
    this.inbox.dueReminders();
    await this.sync.flush();
    const poolLeft = this.store.leadsByStatus('message_ready').length;
    if (poolLeft < s.poolMinDays * s.newPerDay) this.alertFn(`⚠️ Ready pool is low: ${poolLeft} leads (< ${s.poolMinDays} sending days). Sourcing should refill it.`);
    return { planned: plan.items.length, prepared, due: this.cachedDue.length };
  }
  /** Writes messages for qualified A/B leads until the pool holds `poolMinDays + 1` days of ready leads. */
  async fillPool(): Promise<number> {
    const s = this.store.settings(); const want = (s.poolMinDays + 1) * s.newPerDay; let have = this.store.leadsByStatus('message_ready').length; let made = 0;
    for (const l of this.store.leadsByStatus('qualified', 2000)) {
      if (have >= want) break; if (!l.tier || !s.allowedTiers.includes(l.tier as any)) continue;
      const r = await this.personalizer.prepareFirst(l.id); if (r.ok) { have++; made++; }
    }
    return made;
  }
  async tick(): Promise<TickResult> { await this.sync.flush(); return this.sender.tick(); }
  async evening() { const s = this.store.settings(); const day = dayKey(this.store.clock.now(), s.timeZone); await this.d.tg.send(buildDailySummary(this.store, day)); if (zonedParts(this.store.clock.now(), s.timeZone).weekday === 4) await this.d.tg.send(buildWeeklyReport(this.store, day)); }
}
