import { describe, it, expect } from 'vitest';
import { Db } from '../src/db/db.js';
import { Store } from '../src/db/store.js';
import { FakeClock } from '../src/util/clock.js';
import { SeededRng } from '../src/util/rng.js';
import { Planner } from '../src/planner/planner.js';
import { FakeWhatsApp, WaSendError } from '../src/sender/port.js';
import { Breaker } from '../src/sender/breaker.js';
import { Sender } from '../src/sender/sender.js';
import { CrmSync } from '../src/crm/sync.js';
import { FakeCrm } from '../src/crm/fake.js';
import { localToUtc, dayKey } from '../src/util/time.js';

const TZ = 'Asia/Riyadh'; const DAY = '2026-12-05'; // a Saturday
function world(env: Record<string, string> = { SEND_ENABLED: 'true' }, mode: 'off' | 'assisted' | 'auto' = 'auto', n = 6) {
  const clock = new FakeClock(localToUtc(DAY, 7 * 60, TZ)); const store = new Store(new Db(), clock); const alerts: string[] = [];
  store.setSetting('sendMode', mode); store.setSetting('warmup', { enabled: false, steps: [{ fromDay: 1, perDay: 12 }] });
  const crm = new FakeCrm(); const sync = new CrmSync(store, crm, undefined, (m) => alerts.push(m)); const planner = new Planner(store, { rng: new SeededRng(3) });
  const wa = new FakeWhatsApp(); wa.now = () => clock.now().getTime(); const breaker = new Breaker(store, planner, (m) => alerts.push(m));
  wa.onEvent((e) => breaker.onWaEvent(e));
  const sender = new Sender({ store, planner, wa, breaker, sync, alert: (m) => alerts.push(m), env, rng: new SeededRng(5), sleep: async () => {} });
  const leads: string[] = [];
  for (let i = 1; i <= n; i++) {
    const l = store.createLead({ name: 'L' + i, segment: 'furniture', place_id: 'p' + i, phone: '+9665' + (10000000 + i), city: 'Riyadh', country: 'SA' }); store.updateLead(l.id, { tier: 'A', score: 80 } as any);
    store.transition(l.id, 'enriched', 't'); store.transition(l.id, 'qualified', 't'); store.transition(l.id, 'message_ready', 't');
    store.createMessage({ lead_id: l.id, kind: 'first', text: `رسالة رقم ${i} بدون روابط؟`, state: 'ready', variant: i % 2 ? 'A' : 'B' }); leads.push(l.id);
    sync.enqueue(l.id, { op: 'upsert', args: { placeId: 'p' + i, business: 'L' + i, segment: 'furniture', phone: '+9665' + (10000000 + i) } });
  }
  const ready = async () => { await sync.flush(); };
  /** advance time to just after the next planned item and tick */
  const runDay = async (max = 40) => { await ready(); planner.ensurePlan(DAY); const out: any[] = []; for (let i = 0; i < max; i++) { const next = planner.items(DAY).find((x) => x.state === 'planned'); if (!next) break; clock.set(new Date(new Date(next.target_at).getTime() + 1000)); out.push(await sender.tick()); await sync.flush(); } return out; };
  return { clock, store, crm, sync, planner, wa, breaker, sender, alerts, leads, runDay, ready };
}

describe('safety gates', () => {
  it('NEVER sends without SEND_ENABLED=true (dry run writes the would-be message instead)', async () => {
    const w = world({}, 'auto'); expect(w.sender.mode()).toBe('off'); const r = await w.runDay();
    expect(w.wa.sent).toHaveLength(0); expect(r.every((x) => x.action === 'dry_run')).toBe(true); expect(r.length).toBeGreaterThan(0);
    expect(w.store.events(undefined, 200).some((e) => e.type === 'dry_run_send' && JSON.parse(e.data).text.includes('رسالة رقم'))).toBe(true);
    expect(w.store.db.all("SELECT * FROM messages WHERE state='sent'")).toHaveLength(0);
  });
  it('sendMode=off is a dry run even with SEND_ENABLED=true', async () => { const w = world({ SEND_ENABLED: 'true' }, 'off'); await w.runDay(); expect(w.wa.sent).toHaveLength(0); });
  it('paused = nothing sends (kill-switch drill) and resuming needs a live connection', async () => {
    const w = world(); w.store.setPaused(true, 'manual', 'owner'); const r = await w.runDay(); expect(r.length).toBe(0); expect(w.wa.sent).toHaveLength(0);
    expect(await w.sender.tick()).toEqual({ action: 'paused' });
    w.wa.st = 'closed'; expect(w.breaker.resume('owner', w.wa.status() === 'open').ok).toBe(false); w.wa.st = 'open'; expect(w.breaker.resume('owner', true).ok).toBe(true);
  });
});

describe('live sending (fake WhatsApp)', () => {
  it('sends exactly the stored text, one per planned slot, with intent written BEFORE the call and confirm after', async () => {
    const w = world(); const seen: string[] = [];
    const orig = w.wa.sendText.bind(w.wa); w.wa.sendText = async (d, t, o) => { const row = w.store.db.get("SELECT state FROM messages WHERE text=?", t)!; seen.push(row.state); return orig(d, t, o); };
    const r = await w.runDay(); expect(r.filter((x) => x.action === 'sent').length).toBe(6);
    expect(seen.every((s) => s === 'intent')).toBe(true);
    for (const s of w.wa.sent) expect(w.store.db.get('SELECT 1 x FROM messages WHERE text=? AND state=?', s.text, 'sent')).toBeTruthy();
    const l = w.store.lead(w.leads[0])!; expect(l.status).toBe('first_message_sent'); expect(l.first_sent_at).toBeTruthy();
    expect(w.store.db.get("SELECT wa_message_id FROM messages WHERE lead_id=?", w.leads[0])!.wa_message_id).toMatch(/^WA/);
    expect(w.crm.calls.filter((c) => c === 'outbound').length).toBe(6);
    expect(Math.max(...w.wa.typing)).toBeGreaterThan(1000); // typing indicator proportional to length
  });
  it('human-like: planned times are spread, not bunched', async () => { const w = world(); await w.runDay(); const t = w.wa.sent.map((s) => s.at); for (let i = 1; i < t.length; i++) expect(t[i] - t[i - 1]).toBeGreaterThanOrEqual(3.5 * 60000); });
  it('never twice to the same lead on the same day, never above the cap', async () => {
    const w = world(); w.store.setSetting('newPerDay', 3); w.store.setSetting('warmup', { enabled: false, steps: [{ fromDay: 1, perDay: 3 }] }); await w.runDay(); expect(w.wa.sent).toHaveLength(3); expect(new Set(w.wa.sent.map((s) => s.digits)).size).toBe(3);
  });
  it('a duplicate worker started by mistake cannot double-send', async () => {
    const w = world(); await w.ready(); w.planner.ensurePlan(DAY); const first = w.planner.items(DAY)[0]; w.clock.set(new Date(new Date(first.target_at).getTime() + 1000));
    const b = new Sender({ store: w.store, planner: w.planner, wa: w.wa, breaker: w.breaker, sync: w.sync, alert: () => {}, env: { SEND_ENABLED: 'true' }, rng: new SeededRng(9), sleep: async () => {} });
    const [x, y] = await Promise.all([w.sender.tick(), b.tick()]);
    expect([x.action, y.action].filter((a) => a === 'sent')).toHaveLength(1); expect(w.wa.sent).toHaveLength(1);
  });
  it('CRM says stop (human booked a meeting / DNC / client): the item is skipped, nothing sent', async () => {
    const w = world(); await w.ready(); const id = w.store.lead(w.leads[0])!.crm_id!; w.crm.humanSetStage(id, 'اجتماع محجوز'); w.crm.humanSetDnc(w.store.lead(w.leads[1])!.crm_id!);
    await w.runDay(); const digits = w.wa.sent.map((s) => s.digits); expect(digits).not.toContain('96651' + '0000001'.slice(-7)); expect(w.wa.sent.length).toBe(4);
  });
  it('CRM unreachable: fail closed (waits, does not send)', async () => { const w = world(); await w.ready(); w.crm.down = true; w.planner.ensurePlan(DAY); const f = w.planner.items(DAY)[0]; w.clock.set(new Date(new Date(f.target_at).getTime() + 1000)); expect((await w.sender.tick()).action).toBe('waiting'); expect(w.wa.sent).toHaveLength(0); });
  it('first message to a number not on WhatsApp → wrong_contact (or an alternate number is used)', async () => {
    const w = world({ SEND_ENABLED: 'true' }, 'auto', 3); w.wa.notOnWa.add('96651' + '0000001'); w.wa.notOnWa.add('9665' + '10000001');
    w.store.updateLead(w.leads[1], { alt_phones: ['+966599999999'] } as any); w.wa.notOnWa.add('9665' + '10000002');
    await w.runDay(); expect(w.store.lead(w.leads[0])!.status).toBe('wrong_contact'); const l2 = w.store.lead(w.leads[1])!; expect(l2.phone).toBe('+966599999999'); expect(l2.status).toBe('first_message_sent');
    expect(w.wa.sent.some((s) => s.digits === '966599999999')).toBe(true);
  });
  it('reachability is checked only for leads about to be messaged, not in bulk', async () => { const w = world({ SEND_ENABLED: 'true' }, 'auto', 20); w.store.setSetting('newPerDay', 4); w.store.setSetting('warmup', { enabled: false, steps: [{ fromDay: 1, perDay: 4 }] }); await w.runDay(); expect(w.wa.checks.length).toBeLessThanOrEqual(4); });
  it('a spike of «not on WhatsApp» trips the breaker', async () => { const w = world(); for (let i = 1; i <= 6; i++) w.wa.notOnWa.add('9665' + (10000000 + i)); await w.runDay(); expect(w.store.isPaused()).toBe(true); expect(w.store.kvGet<any>('breaker')!.reason).toBe('not_on_whatsapp_spike'); });
});

describe('circuit breaker', () => {
  it('rate-limit error trips immediately, alerts, resets warm-up and blocks every later send', async () => {
    const w = world(); await w.ready(); w.planner.ensurePlan(DAY); w.wa.failNext = new WaSendError('rate_limited', true); const f = w.planner.items(DAY)[0]; w.clock.set(new Date(new Date(f.target_at).getTime() + 1000));
    const r = await w.sender.tick(); expect(r.action).toBe('failed'); expect(w.store.isPaused()).toBe(true); expect(w.alerts.some((a) => a.includes('STOPPED'))).toBe(true);
    expect(await w.sender.tick()).toEqual({ action: 'paused' }); expect(w.wa.sent).toHaveLength(0);
  });
  it('logged-out / restricted / connection flapping / consecutive failures all trip it', async () => {
    for (const trigger of [(w: any) => w.wa.emit({ type: 'status', status: 'logged_out' }), (w: any) => w.wa.emit({ type: 'restricted', detail: 'account restricted' }), (w: any) => { for (let i = 0; i < 6; i++) w.wa.emit({ type: 'status', status: 'closed' }); }]) { const w = world(); trigger(w); expect(w.store.isPaused()).toBe(true); }
    const w = world(); w.wa.failAlways = new WaSendError('other', true); await w.runDay(); expect(w.store.isPaused()).toBe(true); expect(w.store.kvGet<any>('breaker')!.reason).toBe('send_failures');
  });
  it('failed sends are not retried in a tight loop and never duplicated after recovery', async () => {
    const w = world(); await w.ready(); w.planner.ensurePlan(DAY); w.wa.failNext = new WaSendError('timeout', true); const f = w.planner.items(DAY)[0]; w.clock.set(new Date(new Date(f.target_at).getTime() + 1000));
    expect((await w.sender.tick()).action).toBe('failed'); expect((await w.sender.tick()).action).toBe('idle'); // retry only after a 10-20 min pause
    w.clock.advance(25 * 60000); expect((await w.sender.tick()).action).toBe('sent'); expect(w.wa.sent.filter((s) => s.text === w.store.message(w.store.db.get('SELECT message_id m FROM plan_items WHERE id=?', f.id)!.m)!.text)).toHaveLength(1);
  });
  it('undelivered messages (no receipts for 30 min on 5 sends) trip it', async () => { const w = world(); w.wa.autoReceipts = false; await w.runDay(); w.clock.advance(2 * 3600e3); expect(w.breaker.checkDelivery(w.clock.now().getTime())).toBe(true); expect(w.store.isPaused()).toBe(true); });
});

describe('uncertain sends and restarts (no ghost / duplicate sends)', () => {
  it('connection dropped AFTER the send: marked needs_review, owner alerted, NOT retried', async () => {
    const w = world(); await w.ready(); w.planner.ensurePlan(DAY); w.wa.dropAfterSend = true; const f = w.planner.items(DAY)[0]; w.clock.set(new Date(new Date(f.target_at).getTime() + 1000));
    expect((await w.sender.tick()).action).toBe('review'); const m = w.store.message(f.message_id)!; expect(m.state).toBe('needs_review'); expect(w.store.lead(f.lead_id)!.status).toBe('needs_review'); expect(w.wa.sent).toHaveLength(1);
    w.clock.advance(3600e3); await w.sender.tick(); expect(w.wa.sent.filter((s) => s.text === m.text)).toHaveLength(1); expect(w.alerts.some((a) => a.includes('NOT retry'))).toBe(true);
  });
  it('restart with a dangling intent: history says sent → confirmed; says not sent → reverted; unknown → review (never blind retry)', async () => {
    const mk = async (knows: 'sent' | 'notsent' | 'unknown') => {
      const w = world(); await w.ready(); w.planner.ensurePlan(DAY); const f = w.planner.items(DAY)[0]; const m = w.store.message(f.message_id)!; const l = w.store.lead(f.lead_id)!;
      w.store.db.run("UPDATE messages SET state='intent', intent_at=? WHERE id=?", w.store.now(), m.id); w.store.transition(l.id, 'sending', 't');
      if (knows === 'sent') w.wa.sent.push({ digits: l.phone!.replace(/\D/g, ''), text: m.text, at: 0, messageId: 'X' }); if (knows === 'unknown') w.wa.knowsHistory = false;
      const r = await w.sender.reconcileIntents(); return { r, w, m, l };
    };
    const a = await mk('sent'); expect(a.r.confirmed).toBe(1); expect(a.w.store.message(a.m.id)!.state).toBe('sent'); expect(a.w.wa.sent).toHaveLength(1);
    const b = await mk('notsent'); expect(b.r.reverted).toBe(1); expect(b.w.store.message(b.m.id)!.state).toBe('scheduled');
    const c = await mk('unknown'); expect(c.r.review).toBe(1); expect(c.w.store.message(c.m.id)!.state).toBe('needs_review'); expect(c.w.alerts.length).toBeGreaterThan(0);
  });
  it('a restart in the middle of the day: plan is reused and nothing is sent twice', async () => {
    const w = world(); await w.ready(); w.planner.ensurePlan(DAY); const items = w.planner.items(DAY); w.clock.set(new Date(new Date(items[2].target_at).getTime() + 1000));
    for (let i = 0; i < 3; i++) { await w.sender.tick(); w.clock.advance(6 * 60000); } const sentBefore = w.wa.sent.length;
    const planner2 = new Planner(w.store, { rng: new SeededRng(77) }); const s2 = new Sender({ store: w.store, planner: planner2, wa: w.wa, breaker: w.breaker, sync: w.sync, alert: () => {}, env: { SEND_ENABLED: 'true' }, rng: new SeededRng(1), sleep: async () => {} });
    await s2.reconcileIntents(); expect(planner2.ensurePlan(DAY).items.map((x) => x.id)).toEqual(items.map((x) => x.id));
    for (let i = 0; i < 30; i++) { const nx = planner2.items(DAY).find((x) => x.state === 'planned'); if (!nx) break; w.clock.set(new Date(Math.max(w.clock.now().getTime(), new Date(nx.target_at).getTime()) + 1000)); await s2.tick(); }
    expect(sentBefore).toBeGreaterThan(0); expect(new Set(w.wa.sent.map((s) => s.text)).size).toBe(w.wa.sent.length); expect(w.wa.sent.length).toBeLessThanOrEqual(6);
  });
});

describe('assisted mode (safe fallback)', () => {
  it('prepares a wa.me link for the owner and records the send only when confirmed', async () => {
    const w = world({ SEND_ENABLED: 'true' }, 'assisted'); const r = await w.runDay(); expect(r.every((x) => x.action === 'assisted')).toBe(true); expect(w.wa.sent).toHaveLength(0);
    const link = w.alerts.find((a) => a.includes('wa.me'))!; expect(link).toContain('https://wa.me/9665'); const id = w.planner.items(DAY)[0].id;
    expect(w.sender.confirmAssisted(id)).toBe(true); expect(w.store.db.get("SELECT COUNT(*) c FROM messages WHERE state='sent'")!.c).toBe(1);
    expect(w.sender.confirmAssisted(id)).toBe(false);
  });
});
void dayKey;
