import { randomUUID } from 'node:crypto';
import { Store, Lead, Message, MsgKind } from '../db/store.js';
import { Settings } from '../config/settings.js';
import { Interval, allowedIntervals, isAllowedAt, totalMs, tzFor } from './windows.js';
import { Rng, between, mathRng } from '../util/rng.js';
import { addDays, dayKey, localToUtc, weekdayOfDay } from '../util/time.js';

export interface DueFollowup { leadId: string; messageId: string; kind: MsgKind }
export interface PlanItem { id: string; day: string; lead_id: string; message_id: string; kind: string; target_at: string; state: string; skip_reason: string | null }
export interface PlanCaps { base: number; ramp: number; extras: number; newCap: number; followCap: number; ceiling: number; rampIndex: number }

/** Warm-up ramp (plan §6.5): index = how many active sending days so far (+1 for today), minus any reset after a warning. */
export function rampCap(index: number, s: Settings): number {
  if (!s.warmup.enabled) return s.newPerDay;
  let cap = s.warmup.steps[0]?.perDay ?? s.newPerDay;
  for (const st of [...s.warmup.steps].sort((a, b) => a.fromDay - b.fromDay)) if (index >= st.fromDay) cap = st.perDay;
  return Math.min(cap, s.newPerDay);
}

export class Planner {
  constructor(private store: Store, private opts: { rng?: Rng; dueFollowups?: (day: string) => DueFollowup[] } = {}) {}
  private get rng() { return this.opts.rng ?? mathRng; }
  private s() { return this.store.settings(); }
  private dayBounds(day: string, tz: string) { return [localToUtc(day, 0, tz).toISOString(), localToUtc(addDays(day, 1), 0, tz).toISOString()] as const; }

  /** Distinct local days on which something was really sent (from the DB — a restart cannot reset it). */
  activeDays(tz: string): string[] {
    const rows = this.store.db.all("SELECT sent_at FROM messages WHERE direction='out' AND state='sent' AND sent_at IS NOT NULL");
    return [...new Set(rows.map((r) => dayKey(new Date(r.sent_at), tz)))].sort();
  }
  sentOn(day: string, kinds: MsgKind[]): number { const tz = this.s().timeZone; const [a, b] = this.dayBounds(day, tz); return this.store.sentCountOn(a, b, kinds); }
  /** Called by the circuit breaker on a warning: the next sends restart the warm-up ramp. */
  resetRamp() { this.store.kvSet('ramp_base', this.activeDays(this.s().timeZone).length); }
  rampIndex(): number { const s = this.s(); return this.activeDays(s.timeZone).length - (this.store.kvGet<number>('ramp_base', 0) ?? 0) + 1; }

  /** Computes (but does not store) the caps for a day, including catch-up of missed days (never a double batch). */
  caps(day: string): PlanCaps {
    const s = this.s(); const idx = this.rampIndex(); const base = rampCap(idx, s);
    const followCap = Math.min(s.followUpPerDay, s.totalCeilingPerDay);
    let extras = 0;
    const rampDone = !s.warmup.enabled || idx >= (s.warmup.steps.at(-1)?.fromDay ?? 7);
    if (rampDone) {
      const owed = this.store.kvGet<number>('catchup_owed', 0) ?? 0; // updated when plans are created (see updateOwed)
      extras = Math.min(owed, 4, Math.max(0, s.totalCeilingPerDay - base)); // the real follow-up load is checked when the plan is filled
    }
    return { base, ramp: base, extras, newCap: base + extras, followCap, ceiling: s.totalCeilingPerDay, rampIndex: idx };
  }
  /** Adds the shortfall of past sending days (since the first live send) to the owed pool, once per day. Capped at 2 days' worth. */
  private updateOwed(day: string) {
    const s = this.s(); const live = this.store.kvGet<string>('live_since'); if (!live) return;
    let from = this.store.kvGet<string>('owed_processed_until') ?? live; let owed = this.store.kvGet<number>('catchup_owed', 0) ?? 0;
    const lastPlan = this.store.db.get('SELECT caps FROM plans WHERE day<? ORDER BY day DESC LIMIT 1', from); let lastBase: number = lastPlan ? JSON.parse(lastPlan.caps).base : rampCap(1, s);
    for (let d = from; d < day; d = addDays(d, 1)) {
      if (!s.sendingDays.includes(weekdayOfDay(d))) continue;
      const plan = this.store.db.get('SELECT caps FROM plans WHERE day=?', d); const baseCap: number = plan ? JSON.parse(plan.caps).base : lastBase; lastBase = baseCap;
      const sent = this.sentOn(d, ['first']); owed += Math.max(0, baseCap - sent);
    }
    owed = Math.min(owed, 2 * s.newPerDay); // two days' worth at most: old debts are forgotten, never a flood
    this.store.kvSet('catchup_owed', owed); this.store.kvSet('owed_processed_until', day);
  }

  /** The plan for `day`, created at most once. A restart (or a second call) returns the stored plan: no extra sends. */
  ensurePlan(day: string, nowIso = this.store.now()): { items: PlanItem[]; caps: PlanCaps; created: boolean } {
    const existing = this.store.db.get('SELECT * FROM plans WHERE day=?', day);
    if (existing) return { items: this.items(day), caps: JSON.parse(existing.caps), created: false };
    return this.store.db.tx(() => {
      const again = this.store.db.get('SELECT * FROM plans WHERE day=?', day); if (again) return { items: this.items(day), caps: JSON.parse(again.caps), created: false };
      const s = this.s(); this.updateOwed(day);
      const caps = this.caps(day); const notes: string[] = [];
      this.store.db.run('INSERT INTO plans(day,created_at,caps,notes) VALUES (?,?,?,?)', day, nowIso, JSON.stringify(caps), '[]');
      if (!s.sendingDays.includes(weekdayOfDay(day))) { this.store.db.run("UPDATE plans SET notes=? WHERE day=?", JSON.stringify(['not_a_sending_day']), day); return { items: [], caps, created: true }; }
      if (this.store.isPaused()) { this.store.db.run("UPDATE plans SET notes=? WHERE day=?", JSON.stringify(['paused']), day); return { items: [], caps, created: true }; }
      // 1) due follow-ups first, 2) new leads by city order then score.
      const sentFollow = this.sentOn(day, ['followup1', 'followup2', 'followup3']); const sentNew = this.sentOn(day, ['first']);
      const due = (this.opts.dueFollowups?.(day) ?? []).slice(0, Math.max(0, caps.followCap - sentFollow));
      const newRoom = Math.max(0, Math.min(caps.newCap - sentNew, caps.ceiling - sentNew - sentFollow - due.length));
      const order = s.targetCities.map((c) => c.city);
      const pool = this.store.leadsByStatus('message_ready').filter((l) => !l.dnc && !this.store.isDnc(l.phone) && l.tier && s.allowedTiers.includes(l.tier as any))
        .sort((a, b) => (order.indexOf(a.city ?? '') + 1 || 99) - (order.indexOf(b.city ?? '') + 1 || 99) || (b.score ?? 0) - (a.score ?? 0));
      const picked: { lead: Lead; msg: Message; kind: MsgKind }[] = [];
      for (const l of pool) { if (picked.length >= newRoom) break; const m = this.store.outboundOf(l.id, 'first'); if (m && m.state === 'ready') picked.push({ lead: l, msg: m, kind: 'first' }); }
      const items: { leadId: string; messageId: string; kind: MsgKind; where: { city: string | null; country: string | null }; prio: number }[] = [];
      for (const f of due) { const l = this.store.lead(f.leadId)!; if (l && !l.dnc) items.push({ leadId: f.leadId, messageId: f.messageId, kind: f.kind, where: { city: l.city, country: l.country }, prio: 0 }); }
      for (const p of picked) items.push({ leadId: p.lead.id, messageId: p.msg.id, kind: 'first', where: { city: p.lead.city, country: p.lead.country }, prio: 1 });
      const assigned = this.assignSlots(day, items, s, new Date(nowIso).getTime(), notes);
      for (const a of assigned) {
        this.store.db.run('INSERT INTO plan_items(id,day,lead_id,message_id,kind,target_at,state) VALUES (?,?,?,?,?,?,?)', 'pi_' + randomUUID().slice(0, 10), day, a.leadId, a.messageId, a.kind, new Date(a.at).toISOString(), 'planned');
        this.store.updateMessage(a.messageId, { state: 'scheduled', scheduled_at: new Date(a.at).toISOString() });
        const l = this.store.lead(a.leadId)!; if (l.status === 'message_ready') this.store.transition(l.id, 'scheduled', 'planner');
      }
      if (assigned.length < items.length) notes.push(`capacity: ${items.length - assigned.length} item(s) could not be placed in today's windows`);
      const owedNow = this.store.kvGet<number>('catchup_owed', 0) ?? 0; const usedExtras = Math.max(0, Math.min(caps.extras, assigned.filter((x) => x.kind === 'first').length - caps.base));
      if (usedExtras > 0) this.store.kvSet('catchup_owed', Math.max(0, owedNow - usedExtras));
      const poolLeft = pool.length - picked.length; if (poolLeft < s.poolMinDays * s.newPerDay) notes.push(`pool_low: ${poolLeft} ready leads left (< ${s.poolMinDays} days)`);
      this.store.db.run('UPDATE plans SET notes=? WHERE day=?', JSON.stringify(notes), day);
      this.store.event('plan_created', 'planner', null, { day, caps, planned: assigned.length, notes });
      return { items: this.items(day), caps, created: true };
    });
  }

  /** Spreads items across the day's allowed intervals with random gaps; both windows get a share; never in prayer buffers. */
  private assignSlots(day: string, items: { leadId: string; messageId: string; kind: MsgKind; where: { city: string | null; country: string | null }; prio: number }[], s: Settings, nowMs: number, notes: string[]) {
    if (!items.length) return [];
    const fromNow = nowMs + 2 * 60_000;
    // Use the intervals of the first item's place as the slot grid; each item is then matched to a slot that is allowed for ITS place.
    const gridWhere = items[0].where; const grid = allowedIntervals(day, gridWhere, s).map(([a, b]) => [Math.max(a, fromNow), b] as Interval).filter(([a, b]) => b - a > 60_000);
    if (!grid.length) { notes.push('no_allowed_time_left_today'); return []; }
    const slots = this.makeSlots(grid, items.length, s);
    const out: { leadId: string; messageId: string; kind: MsgKind; at: number }[] = []; const left = [...items].sort((a, b) => a.prio - b.prio);
    for (const t of slots) { const i = left.findIndex((it) => isAllowedAt(t, allowedIntervals(day, it.where, s))); if (i < 0) continue; const it = left.splice(i, 1)[0]; out.push({ leadId: it.leadId, messageId: it.messageId, kind: it.kind, at: t }); }
    return out;
  }
  /** n slots over intervals, split proportionally to length, each interval walked with random gaps in [min,max] minutes (shrunk if it cannot fit). */
  makeSlots(intervals: Interval[], n: number, s: Settings): number[] {
    const gmin = s.gapMinutes.min * 60000, gmax = s.gapMinutes.max * 60000; const total = totalMs(intervals); if (!total || n <= 0) return [];
    // How many fit with at least gmin spacing in each interval?
    const cap = intervals.map(([a, b]) => Math.max(0, Math.floor((b - a) / gmin)));
    let share = intervals.map(([a, b]) => Math.min(cap[intervals.findIndex((x) => x[0] === a)], Math.round((n * (b - a)) / total)));
    let sum = share.reduce((x, y) => x + y, 0);
    for (let guard = 0; sum < n && guard < 1000; guard++) { const i = share.findIndex((v, k) => v < cap[k]); if (i < 0) break; share[i]++; sum++; }
    while (sum > n) { const k = share.indexOf(Math.max(...share)); share[k]--; sum--; }
    const out: number[] = [];
    intervals.forEach(([a, b], k) => {
      const m = share[k]; if (m <= 0) return; const len = b - a;
      const avg = Math.min(gmax, Math.max(gmin, len / (m + 1)));
      let t = a + between(this.rng, 0, Math.max(0, Math.min(avg * 0.6, len - (m - 1) * gmin - 1)));
      for (let i = 0; i < m; i++) { if (t >= b) break; out.push(Math.floor(t)); const lo = gmin, hi = Math.max(gmin, Math.min(gmax, (b - t) / Math.max(1, m - i - 1) )); t += between(this.rng, lo, hi); }
    });
    return out.sort((x, y) => x - y).filter((t, i, arr) => i === 0 || t - arr[i - 1] >= gmin - 1000);
  }
  items(day: string): PlanItem[] { return this.store.db.all('SELECT * FROM plan_items WHERE day=? ORDER BY target_at', day) as PlanItem[]; }

  /** Items whose time has come AND whose moment is still allowed. */
  due(nowMs: number, day: string): PlanItem[] {
    const s = this.s(); return this.items(day).filter((i) => i.state === 'planned' && new Date(i.target_at).getTime() <= nowMs).filter((i) => {
      const l = this.store.lead(i.lead_id)!; return isAllowedAt(nowMs, allowedIntervals(day, { city: l.city, country: l.country }, s));
    });
  }
  /** Items that slipped more than `graceMin` past their time (outage) are released back to the pool: never sent late in a bunch. */
  expireMissed(nowMs: number, day: string, graceMin = 90): number {
    let n = 0;
    for (const i of this.items(day)) if (i.state === 'planned' && nowMs - new Date(i.target_at).getTime() > graceMin * 60000) {
      this.store.db.run("UPDATE plan_items SET state='skipped', skip_reason='missed_window' WHERE id=?", i.id);
      const m = this.store.message(i.message_id); if (m && m.state === 'scheduled') this.store.updateMessage(m.id, { state: 'ready', scheduled_at: null });
      const l = this.store.lead(i.lead_id); if (l?.status === 'scheduled') this.store.transition(l.id, 'message_ready', 'planner', 'missed_window');
      n++;
    }
    return n;
  }
  skipItem(itemId: string, reason: string) {
    const it = this.store.db.get('SELECT * FROM plan_items WHERE id=?', itemId) as PlanItem | undefined; if (!it || it.state !== 'planned') return false;
    this.store.db.run("UPDATE plan_items SET state='skipped', skip_reason=? WHERE id=?", reason, itemId);
    const m = this.store.message(it.message_id); if (m && m.state === 'scheduled') this.store.updateMessage(m.id, { state: 'ready', scheduled_at: null });
    const l = this.store.lead(it.lead_id); if (l?.status === 'scheduled') this.store.transition(l.id, 'message_ready', 'planner', reason);
    return true;
  }
  today(): string { return dayKey(this.store.clock.now(), this.s().timeZone); }
}
export { tzFor };
