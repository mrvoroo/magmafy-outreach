import { Store, Lead, Message, MsgKind } from '../db/store.js';
import { Planner, PlanItem } from '../planner/planner.js';
import { WhatsAppPort, WaSendError } from './port.js';
import { Breaker } from './breaker.js';
import { CrmSync } from '../crm/sync.js';
import { liveSendingAllowed } from '../config/settings.js';
import { Status } from '../domain/status.js';
import { Rng, between, mathRng } from '../util/rng.js';
import { addDays, dayKey } from '../util/time.js';
import { Logger, nullLogger } from '../util/log.js';

const PREV: Record<string, Status> = { first: 'scheduled', followup1: 'first_message_sent', followup2: 'followup_1_sent', followup3: 'followup_2_sent' };
const NEXT: Record<string, Status> = { first: 'first_message_sent', followup1: 'followup_1_sent', followup2: 'followup_2_sent', followup3: 'followup_3_sent' };
export type TickResult = { action: 'idle' | 'paused' | 'waiting' | 'not_connected' | 'dry_run' | 'assisted' | 'sent' | 'skipped' | 'failed' | 'review' | 'not_on_whatsapp'; item?: string; detail?: string };

export interface SenderDeps { store: Store; planner: Planner; wa: WhatsAppPort; breaker: Breaker; sync: CrmSync; alert: (m: string) => void; env: Record<string, string | undefined>; rng?: Rng; sleep?: (ms: number) => Promise<void>; log?: Logger }

/**
 * The only component allowed to talk to WhatsApp. It never composes or edits text: it sends exactly the stored final message,
 * and only after intent-then-confirm bookkeeping (plan §9). One item per tick.
 */
export class Sender {
  private rng: Rng; private sleep: (ms: number) => Promise<void>; private log: Logger;
  constructor(private d: SenderDeps) { this.rng = d.rng ?? mathRng; this.sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))); this.log = d.log ?? nullLogger; }
  private get store() { return this.d.store; }
  /** Effective mode: the env switch is a hard gate; without SEND_ENABLED=true everything is a dry run. */
  mode(): 'off' | 'assisted' | 'auto' { const s = this.store.settings(); return liveSendingAllowed(this.d.env, s) ? s.sendMode : 'off'; }

  /** Called once at start-up: no `intent` row is ever blindly retried. */
  async reconcileIntents(): Promise<{ confirmed: number; reverted: number; review: number }> {
    const out = { confirmed: 0, reverted: 0, review: 0 };
    for (const r of this.store.db.all("SELECT * FROM messages WHERE direction='out' AND state='intent'")) {
      const m = this.store.message(r.id)!; const lead = this.store.lead(m.lead_id)!; const digits = (lead.phone ?? '').replace(/\D/g, '');
      const known = await this.d.wa.wasSent(digits, m.text, m.intent_at ?? '');
      if (known === true) { this.confirm(m, lead, 'unknown', this.store.now()); out.confirmed++; }
      else if (known === false) { this.revert(m, lead, 'reconcile: not sent'); out.reverted++; }
      else { this.park(m, lead, 'uncertain_after_restart'); out.review++; this.d.alert(`⚠️ After a restart I cannot tell if the message to «${lead.name}» went out. I will NOT resend it. Please check WhatsApp and decide.`); }
    }
    return out;
  }

  async tick(): Promise<TickResult> {
    const s = this.store.settings(); const nowMs = this.store.clock.now().getTime();
    if (this.store.isPaused()) return { action: 'paused' };
    const day = dayKey(this.store.clock.now(), s.timeZone);
    this.d.planner.ensurePlan(day); this.d.planner.expireMissed(nowMs, day);
    const mode = this.mode();
    if (mode === 'auto' && this.d.breaker.checkDelivery(nowMs)) return { action: 'paused', detail: 'not_delivered' };
    const item = this.d.planner.due(nowMs, day)[0]; if (!item) return { action: 'idle' };
    // never bunch: respect a minimum gap since the last real send, even after a restart
    const last = this.store.db.get("SELECT MAX(COALESCE(sent_at,intent_at)) t FROM messages WHERE direction='out' AND state IN ('sent','intent')")?.t as string | null;
    if (mode !== 'off' && last && nowMs - new Date(last).getTime() < s.gapMinutes.min * 60000 * 0.9) return { action: 'waiting', item: item.id, detail: 'min_gap' };
    const lead = this.store.lead(item.lead_id)!; const msg = this.store.message(item.message_id)!;
    const pre = await this.preChecks(item, lead, msg, day, s);
    if (pre) return pre;
    if (mode === 'off') { this.store.db.run("UPDATE plan_items SET state='dryrun' WHERE id=?", item.id); this.store.updateMessage(msg.id, { delivery_status: 'dry_run' }); this.store.event('dry_run_send', 'sender', lead.id, { kind: msg.kind, to: lead.phone, text: msg.text }); return { action: 'dry_run', item: item.id }; }
    if (mode === 'assisted') { this.store.db.run("UPDATE plan_items SET state='assisted' WHERE id=?", item.id); const link = `https://wa.me/${(lead.phone ?? '').replace(/\D/g, '')}?text=${encodeURIComponent(msg.text)}`; this.d.alert(`✉️ Ready to send to «${lead.name}» (item ${item.id}):\n${msg.text}\n${link}\nAfter sending reply: /done ${item.id}`); return { action: 'assisted', item: item.id }; }
    if (this.d.wa.status() !== 'open') return { action: 'not_connected', item: item.id };
    return this.sendAuto(item, lead, msg, day);
  }

  /** The common safety gates. Returns a result when the item must NOT be sent. */
  private async preChecks(item: PlanItem, lead: Lead, msg: Message, day: string, s: ReturnType<Store['settings']>): Promise<TickResult | null> {
    const skip = (reason: string): TickResult => { this.d.planner.skipItem(item.id, reason); return { action: 'skipped', item: item.id, detail: reason }; };
    if (!lead.phone) return skip('no_phone');
    if (msg.state !== 'scheduled') return skip('message_state_' + msg.state);
    if (msg.kind !== 'first' && !PREV[msg.kind]) return skip('bad_kind');
    if (lead.status !== PREV[msg.kind]) return skip('lead_status_' + lead.status);
    if (lead.dnc || this.store.isDnc(lead.phone)) return skip('dnc');
    const tz = s.timeZone; const [a, b] = [new Date(Date.parse(day + 'T00:00:00Z') - 14 * 3600e3).toISOString(), new Date(Date.parse(day + 'T00:00:00Z') + 38 * 3600e3).toISOString()];
    const sameDay = this.store.messagesOf(lead.id).some((m) => m.direction === 'out' && ['sent', 'intent'].includes(m.state) && m.id !== msg.id && m.sent_at && dayKey(new Date(m.sent_at), tz) === day);
    if (sameDay) return skip('already_messaged_today');
    void a; void b;
    // hard caps from the DB (not from memory)
    const caps = JSON.parse(this.store.db.get('SELECT caps FROM plans WHERE day=?', day)!.caps);
    const sentNew = this.d.planner.sentOn(day, ['first']), sentFollow = this.d.planner.sentOn(day, ['followup1', 'followup2', 'followup3']);
    if (msg.kind === 'first' && sentNew >= caps.newCap) return skip('cap_new');
    if (msg.kind !== 'first' && sentFollow >= caps.followCap) return skip('cap_followup');
    if (sentNew + sentFollow >= s.totalCeilingPerDay) return skip('cap_total');
    if (!msg.text.trim() || /https?:|www\./i.test(msg.text) || msg.text.length > 600) return skip('final_guard');
    const crm = await this.d.sync.preSendCheck(lead);
    if (!crm.ok) { if (crm.reason === 'crm_unreachable' || crm.reason === 'not_in_crm_yet') return { action: 'waiting', item: item.id, detail: crm.reason }; return skip(crm.reason ?? 'crm_stop'); }
    return null;
  }

  private async sendAuto(item: PlanItem, lead0: Lead, msg: Message, day: string): Promise<TickResult> {
    let lead = lead0; const s = this.store.settings();
    // reachability: only now, only for a first message, only for this lead
    if (msg.kind === 'first' && lead.wa_reachable !== true) {
      let ok = false; const candidates = [lead.phone!, ...lead.alt_phones.filter((p) => p !== lead.phone)];
      for (const [i, ph] of candidates.entries()) {
        const digits = ph.replace(/\D/g, ''); ok = await this.d.wa.isOnWhatsApp(digits); this.d.breaker.noteReachability(ok);
        if (this.store.isPaused()) return { action: 'paused', detail: 'breaker' };
        if (ok) { if (i > 0) this.store.updateLead(lead.id, { phone: ph, wa_reachable: true } as Partial<Lead>, 'sender'); else this.store.updateLead(lead.id, { wa_reachable: true }, 'sender'); lead = this.store.lead(lead.id)!; break; }
      }
      if (!ok) {
        this.d.planner.skipItem(item.id, 'not_on_whatsapp'); this.store.updateMessage(msg.id, { state: 'skipped', failure_reason: 'not_on_whatsapp' });
        this.store.transition(lead.id, 'wrong_contact', 'sender', 'not on WhatsApp — needs a phone call'); this.store.updateLead(lead.id, { wa_reachable: false }, 'sender');
        this.d.sync.enqueue(lead.id, { op: 'outcome', args: { outcome: 'wrong_contact', ref: 'wc_' + lead.id } });
        return { action: 'not_on_whatsapp', item: item.id };
      }
    }
    // 1) intent (committed BEFORE the call), 2) human-like delay, 3) send, 4) confirm
    let claimed = false;
    try {
      this.store.db.tx(() => {
        // atomic claim: only ONE worker can move the message scheduled → intent (a second worker started by mistake gets 0 rows)
        const r = this.store.db.run("UPDATE messages SET state='intent', intent_at=? WHERE id=? AND state='scheduled'", this.store.now(), msg.id);
        if (Number(r.changes) !== 1) return;
        this.store.transition(lead.id, 'sending', 'sender'); this.store.db.run("UPDATE plan_items SET state='sending' WHERE id=?", item.id); claimed = true;
      });
    } catch { claimed = false; }
    if (!claimed) return { action: 'skipped', item: item.id, detail: 'already_claimed' };
    const typingMs = Math.round(Math.min(12000, Math.max(1500, msg.text.length * 55 + between(this.rng, 500, 2500))));
    await this.sleep(Math.round(between(this.rng, 2000, 9000)));
    try {
      const r = await this.d.wa.sendText(lead.phone!.replace(/\D/g, ''), msg.text, { typingMs });
      this.confirm(this.store.message(msg.id)!, this.store.lead(lead.id)!, r.messageId, this.store.now(), item.id);
      this.d.breaker.noteSendResult(true);
      return { action: 'sent', item: item.id };
    } catch (e) {
      const err = e instanceof WaSendError ? e : new WaSendError('other', false, (e as Error).message);
      this.d.breaker.noteSendResult(false);
      if (err.code === 'rate_limited' || err.code === 'restricted') this.d.breaker.trip(err.code, err.message);
      if (err.certain) { this.revert(this.store.message(msg.id)!, this.store.lead(lead.id)!, err.code, item.id); return { action: 'failed', item: item.id, detail: err.code }; }
      this.park(this.store.message(msg.id)!, this.store.lead(lead.id)!, 'uncertain_' + err.code, item.id);
      this.d.alert(`⚠️ Send to «${lead.name}» ended unclearly (${err.code}). I will NOT retry it; please check WhatsApp.`);
      void s; return { action: 'review', item: item.id, detail: err.code };
    }
  }

  private confirm(msg: Message, lead: Lead, waId: string, nowIso: string, itemId?: string) {
    const s = this.store.settings(); const day = dayKey(new Date(nowIso), s.timeZone);
    this.store.db.tx(() => {
      this.store.updateMessage(msg.id, { state: 'sent', sent_at: nowIso, wa_message_id: waId, failure_reason: null });
      this.store.transition(lead.id, NEXT[msg.kind], 'sender');
      if (msg.kind === 'first') this.store.updateLead(lead.id, { first_sent_at: nowIso });
      if (itemId) this.store.db.run("UPDATE plan_items SET state='sent' WHERE id=?", itemId); else this.store.db.run("UPDATE plan_items SET state='sent' WHERE message_id=?", msg.id);
      if (!this.store.kvGet('live_since')) this.store.kvSet('live_since', day);
      const delays = s.followUpDelaysDays; const base = dayKey(new Date(this.store.lead(lead.id)!.first_sent_at ?? nowIso), s.timeZone);
      const nextDay = msg.kind === 'first' ? addDays(base, delays[0]) : msg.kind === 'followup1' ? addDays(base, delays[1]) : msg.kind === 'followup2' ? addDays(base, delays[2]) : null;
      this.d.sync.enqueue(lead.id, { op: 'outbound', args: { ref: msg.id, kind: msg.kind as any, variant: msg.variant, text: msg.text, nextFollowUpDay: nextDay } }, 'ob_' + msg.id);
    });
    this.store.event('message_sent', 'sender', lead.id, { kind: msg.kind, wa: waId });
  }
  /** Certain failure: back to the state before the attempt; the item is retried only after a pause (never a tight loop). */
  private revert(msg: Message, lead: Lead, reason: string, itemId?: string) {
    this.store.db.tx(() => {
      this.store.updateMessage(msg.id, { state: 'scheduled', failure_reason: reason, intent_at: null });
      if (lead.status === 'sending') this.store.transition(lead.id, PREV[msg.kind], 'sender', reason);
      const retryAt = new Date(this.store.clock.now().getTime() + between(this.rng, 10, 20) * 60000).toISOString();
      this.store.db.run("UPDATE plan_items SET state='planned', target_at=? WHERE id=? OR message_id=?", retryAt, itemId ?? '', msg.id);
    });
  }
  private park(msg: Message, lead: Lead, reason: string, itemId?: string) {
    this.store.db.tx(() => {
      this.store.updateMessage(msg.id, { state: 'needs_review', failure_reason: reason });
      if (lead.status === 'sending') this.store.transition(lead.id, 'needs_review', 'sender', reason);
      this.store.db.run("UPDATE plan_items SET state='review' WHERE id=? OR message_id=?", itemId ?? '', msg.id);
    });
  }
  /**
   * Sends a reply the OWNER approved (/send <id>). Replies are not cold messages: no planner caps, but the same hard gates
   * (kill switch, SEND_ENABLED, do-not-contact, connection) and the same intent-then-confirm bookkeeping.
   */
  async sendReply(replyMessageId: string, actor: string): Promise<{ ok: boolean; reason?: string }> {
    const msg = this.store.message(replyMessageId); if (!msg || msg.direction !== 'out' || !msg.kind.startsWith('reply')) return { ok: false, reason: 'not_a_reply' };
    if (msg.state === 'sent') return { ok: true, reason: 'already_sent' };
    if (msg.state !== 'ready') return { ok: false, reason: 'state_' + msg.state };
    const lead = this.store.lead(msg.lead_id)!; if (this.store.isPaused()) return { ok: false, reason: 'paused' };
    if (this.mode() !== 'auto') return { ok: false, reason: 'mode_' + this.mode() }; if (this.d.wa.status() !== 'open') return { ok: false, reason: 'not_connected' };
    if (!lead.phone || (this.store.isDnc(lead.phone) && !/ما راح نتواصل/.test(msg.text))) return { ok: false, reason: 'dnc' };
    const r = this.store.db.run("UPDATE messages SET state='intent', intent_at=? WHERE id=? AND state='ready'", this.store.now(), msg.id); if (Number(r.changes) !== 1) return { ok: false, reason: 'claimed' };
    await this.sleep(Math.round(between(this.rng, 1500, 5000)));
    try {
      const res = await this.d.wa.sendText(lead.phone.replace(/\D/g, ''), msg.text, { typingMs: Math.min(9000, 1500 + msg.text.length * 45) });
      this.store.updateMessage(msg.id, { state: 'sent', sent_at: this.store.now(), wa_message_id: res.messageId });
      this.d.sync.enqueue(lead.id, { op: 'outbound', args: { ref: msg.id, kind: 'reply', text: msg.text } }, 'ob_' + msg.id);
      this.store.event('reply_sent', actor, lead.id, { msg: msg.id }); this.d.breaker.noteSendResult(true); return { ok: true };
    } catch (e) {
      const err = e instanceof WaSendError ? e : new WaSendError('other', false, (e as Error).message); this.d.breaker.noteSendResult(false);
      if (err.code === 'rate_limited' || err.code === 'restricted') this.d.breaker.trip(err.code, err.message);
      if (err.certain) { this.store.updateMessage(msg.id, { state: 'ready', failure_reason: err.code, intent_at: null }); return { ok: false, reason: err.code }; }
      this.store.updateMessage(msg.id, { state: 'needs_review', failure_reason: 'uncertain_' + err.code }); this.d.alert(`⚠️ The reply to «${lead.name}» ended unclearly; I will not retry. Please check WhatsApp.`); return { ok: false, reason: 'uncertain' };
    }
  }
  /** Assisted mode: the owner tapped the wa.me link and sent it by hand, then confirms. */
  confirmAssisted(itemId: string): boolean {
    const it = this.store.db.get('SELECT * FROM plan_items WHERE id=?', itemId) as PlanItem | undefined; if (!it || it.state !== 'assisted') return false;
    const msg = this.store.message(it.message_id)!; const lead = this.store.lead(it.lead_id)!;
    this.store.db.tx(() => { this.store.updateMessage(msg.id, { state: 'intent', intent_at: this.store.now() }); this.store.transition(lead.id, 'sending', 'owner'); });
    this.confirm(this.store.message(msg.id)!, this.store.lead(lead.id)!, 'manual', this.store.now(), itemId); return true;
  }
}
export type { MsgKind };
