import { describe, it, expect } from 'vitest';
import { Db } from '../src/db/db.js';
import { Store } from '../src/db/store.js';
import { FakeClock } from '../src/util/clock.js';
import { SeededRng } from '../src/util/rng.js';
import { Planner, rampCap } from '../src/planner/planner.js';
import { prayerTimes, CITY_COORDS, localMinutes } from '../src/planner/prayer.js';
import { allowedIntervals, isAllowedAt } from '../src/planner/windows.js';
import { defaultSettings } from '../src/config/settings.js';
import { localToUtc, addDays, weekdayOfDay, dayKey } from '../src/util/time.js';

const TZ = 'Asia/Riyadh';
function world(seed = 7) {
  const clock = new FakeClock(localToUtc('2026-12-05', 7 * 60, TZ)); const store = new Store(new Db(), clock);
  const planner = new Planner(store, { rng: new SeededRng(seed) }); let n = 0;
  const seedLeads = (k: number) => { for (let i = 0; i < k; i++) { n++; const l = store.createLead({ name: 'L' + n, segment: 'furniture', place_id: 'p' + n, phone: '+9665' + String(10000000 + n), city: 'Riyadh', country: 'SA' }); store.updateLead(l.id, { tier: 'A', score: 90 - (n % 40) } as any); store.transition(l.id, 'enriched', 't'); store.transition(l.id, 'qualified', 't'); store.transition(l.id, 'message_ready', 't'); store.createMessage({ lead_id: l.id, kind: 'first', text: 'm' + n, state: 'ready' }); } };
  /** Pretends the sender did its job at each planned time. */
  const execute = (day: string) => { for (const it of planner.items(day)) { if (it.state !== 'planned') continue; store.db.run("UPDATE plan_items SET state='sent' WHERE id=?", it.id); store.updateMessage(it.message_id, { state: 'sent', sent_at: it.target_at }); store.transition(it.lead_id, 'sending', 't'); store.transition(it.lead_id, 'first_message_sent', 't'); if (!store.kvGet('live_since')) store.kvSet('live_since', day); } };
  const at = (day: string, hm = 420) => clock.set(localToUtc(day, hm, TZ));
  return { clock, store, planner, seedLeads, execute, at };
}

describe('prayer times & windows', () => {
  it('Riyadh Dec 1: sane times (Dhuhr ≈ 11:3x, Maghrib ≈ 17:0x, Isha = Maghrib+90)', () => {
    const p = prayerTimes('2026-12-01', CITY_COORDS.Riyadh); const m = (d: Date) => localMinutes(d, TZ);
    expect(m(p.fajr)).toBeGreaterThan(4 * 60 + 40); expect(m(p.fajr)).toBeLessThan(5 * 60 + 30);
    expect(m(p.dhuhr)).toBeGreaterThan(11 * 60 + 25); expect(m(p.dhuhr)).toBeLessThan(11 * 60 + 50);
    expect(m(p.asr)).toBeGreaterThan(14 * 60 + 30); expect(m(p.asr)).toBeLessThan(15 * 60 + 15);
    expect(m(p.maghrib)).toBeGreaterThan(16 * 60 + 50); expect(m(p.maghrib)).toBeLessThan(17 * 60 + 25); expect(m(p.isha) - m(p.maghrib)).toBe(90);
  });
  it('allowed intervals exclude prayer buffers and non-sending days', () => {
    const s = defaultSettings(); expect(allowedIntervals('2026-12-04', { city: 'Riyadh', country: 'SA' }, s)).toEqual([]); // Friday
    const iv = allowedIntervals('2026-12-05', { city: 'Riyadh', country: 'SA' }, s); const p = prayerTimes('2026-12-05', CITY_COORDS.Riyadh);
    for (const t of [p.dhuhr, p.asr, p.maghrib, p.isha]) { expect(isAllowedAt(t.getTime(), iv)).toBe(false); expect(isAllowedAt(t.getTime() + 20 * 60000, iv)).toBe(false); }
    expect(iv.length).toBeGreaterThanOrEqual(2);
  });
  it('UAE uses UTC+4 windows', () => { const s = defaultSettings(); const a = allowedIntervals('2026-12-05', { city: 'Dubai', country: 'AE' }, s); const b = allowedIntervals('2026-12-05', { city: 'Riyadh', country: 'SA' }, s); expect(b[0][0] - a[0][0]).toBeGreaterThan(30 * 60000); });
});

describe('ramp', () => { it('5,5,8,8,10,10,12…', () => { const s = defaultSettings(); expect([1, 2, 3, 4, 5, 6, 7, 20].map((i) => rampCap(i, s))).toEqual([5, 5, 8, 8, 10, 10, 12, 12]); }); });

describe('planner: three simulated weeks', () => {
  it('respects caps, ramp, Fridays, windows, prayer buffers, min gaps and randomness', () => {
    const w = world(); w.seedLeads(400); const s = w.store.settings(); const ramp: number[] = []; const gapsSeen = new Set<number>();
    for (let i = 0; i < 21; i++) {
      const day = addDays('2026-12-05', i); w.at(day); const plan = w.planner.ensurePlan(day); const items = plan.items;
      if (weekdayOfDay(day) === 5) { expect(items).toHaveLength(0); continue; }
      ramp.push(items.length);
      const iv = allowedIntervals(day, { city: 'Riyadh', country: 'SA' }, s); const times = items.map((x) => new Date(x.target_at).getTime());
      for (const t of times) expect(isAllowedAt(t, iv)).toBe(true);
      for (let k = 1; k < times.length; k++) { const g = (times[k] - times[k - 1]) / 60000; expect(g).toBeGreaterThanOrEqual(s.gapMinutes.min - 0.02); gapsSeen.add(Math.round(g)); }
      expect(new Set(items.map((x) => x.lead_id)).size).toBe(items.length); // never twice the same lead in a day
      expect(items.length).toBeLessThanOrEqual(s.totalCeilingPerDay);
      w.execute(day);
    }
    expect(ramp.slice(0, 6)).toEqual([5, 5, 8, 8, 10, 10]); expect(ramp.slice(6).every((n) => n === 12)).toBe(true);
    expect(gapsSeen.size).toBeGreaterThan(8); // not fixed intervals
  });
  it('plans are created once: a second call / restart changes nothing', () => {
    const w = world(); w.seedLeads(30); w.at('2026-12-05'); const a = w.planner.ensurePlan('2026-12-05'); const b = w.planner.ensurePlan('2026-12-05');
    expect(b.created).toBe(false); expect(b.items.map((x) => x.id)).toEqual(a.items.map((x) => x.id));
    const planner2 = new Planner(w.store, { rng: new SeededRng(999) }); expect(planner2.ensurePlan('2026-12-05').items.map((x) => x.id)).toEqual(a.items.map((x) => x.id));
    expect(w.store.db.all('SELECT * FROM plan_items')).toHaveLength(a.items.length);
  });
  it('outage: missed days are caught up gradually — never a double batch, never above the ceiling', () => {
    const w = world(); w.seedLeads(500);
    for (let i = 0; i < 9; i++) { const day = addDays('2026-12-05', i); if (weekdayOfDay(day) === 5) continue; w.at(day); w.planner.ensurePlan(day); w.execute(day); }
    // 4 days of outage (no plans, nothing sent), then back
    const sizes: number[] = []; let d = addDays('2026-12-05', 13);
    for (let i = 0; i < 11; i++, d = addDays(d, 1)) { if (weekdayOfDay(d) === 5) continue; w.at(d); const p = w.planner.ensurePlan(d); sizes.push(p.items.length); w.execute(d); expect(p.items.length).toBeLessThanOrEqual(16); expect(p.items.length).toBeLessThanOrEqual(w.store.settings().totalCeilingPerDay); }
    expect(Math.max(...sizes)).toBeLessThanOrEqual(12 + 4); expect(sizes[0]).toBeGreaterThan(12); // some catch-up…
    expect(sizes.slice(-2).every((n) => n === 12)).toBe(true); // …then back to normal once the debt is paid
  });
  it('paused system makes an empty plan; resuming does not create extras later', () => {
    const w = world(); w.seedLeads(30); w.store.setPaused(true, 'test', 't'); w.at('2026-12-05'); const p = w.planner.ensurePlan('2026-12-05'); expect(p.items).toHaveLength(0);
    w.store.setPaused(false, 'test', 't'); expect(w.planner.ensurePlan('2026-12-05').items).toHaveLength(0);
  });
  it('plans created late in the day only use the time that is left; missed items are released, not bunched', () => {
    const w = world(); w.seedLeads(30); w.at('2026-12-05', 15 * 60); const p = w.planner.ensurePlan('2026-12-05'); const s = w.store.settings();
    for (const i of p.items) expect(new Date(i.target_at).getTime()).toBeGreaterThan(w.clock.now().getTime());
    expect(p.items.length).toBeLessThan(12);
    w.clock.set(localToUtc('2026-12-05', 23 * 60, TZ)); expect(w.planner.expireMissed(w.clock.now().getTime(), '2026-12-05')).toBe(p.items.length);
    for (const i of w.planner.items('2026-12-05')) { expect(i.state).toBe('skipped'); expect(w.store.message(i.message_id)!.state).toBe('ready'); expect(w.store.lead(i.lead_id)!.status).toBe('message_ready'); }
    void s;
  });
  it('due(): only items whose time has come and that are still inside an allowed moment', () => {
    const w = world(); w.seedLeads(30); w.at('2026-12-05'); const p = w.planner.ensurePlan('2026-12-05'); const first = new Date(p.items[0].target_at).getTime();
    expect(w.planner.due(first - 60000, '2026-12-05')).toHaveLength(0); expect(w.planner.due(first + 1000, '2026-12-05').length).toBeGreaterThanOrEqual(1);
  });
  it('do-not-contact leads and low tiers are never planned; pool-low note appears', () => {
    const w = world(); w.seedLeads(20); const l = w.store.leadsByStatus('message_ready')[0]; w.store.updateLead(l.id, { dnc: true } as any);
    const c = w.store.leadsByStatus('message_ready')[1]; w.store.updateLead(c.id, { tier: 'C' } as any);
    w.at('2026-12-05'); const p = w.planner.ensurePlan('2026-12-05'); expect(p.items.some((i) => i.lead_id === l.id || i.lead_id === c.id)).toBe(false);
    expect(JSON.parse(w.store.db.get('SELECT notes FROM plans WHERE day=?', '2026-12-05')!.notes).some((n: string) => n.startsWith('pool_low'))).toBe(true);
  });
  it('Riyadh leads are planned before other cities, higher score first', () => {
    const w = world(); w.seedLeads(6); for (const l of w.store.leadsByStatus('message_ready').slice(0, 3)) w.store.updateLead(l.id, { city: 'Jeddah' } as any);
    w.store.setSetting('warmup', { enabled: true, steps: [{ fromDay: 1, perDay: 3 }] }); w.at('2026-12-05'); const p = w.planner.ensurePlan('2026-12-05');
    expect(p.items.map((i) => w.store.lead(i.lead_id)!.city)).toEqual(['Riyadh', 'Riyadh', 'Riyadh']);
  });
  it('resetRamp (circuit breaker) restarts the warm-up', () => {
    const w = world(); w.seedLeads(100); for (let i = 0; i < 8; i++) { const day = addDays('2026-12-05', i); if (weekdayOfDay(day) === 5) continue; w.at(day); w.planner.ensurePlan(day); w.execute(day); }
    expect(w.planner.rampIndex()).toBeGreaterThan(6); w.planner.resetRamp(); expect(w.planner.rampIndex()).toBe(1); expect(w.planner.caps('2026-12-14').newCap).toBe(5);
  });
  it('catch-up never applies during warm-up and today stays dayKey-consistent', () => { const w = world(); w.at('2026-12-05'); expect(dayKey(w.clock.now(), TZ)).toBe('2026-12-05'); expect(w.planner.caps('2026-12-05').extras).toBe(0); });
});
