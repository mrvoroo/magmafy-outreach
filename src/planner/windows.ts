import { Settings } from '../config/settings.js';
import { CITY_COORDS, COUNTRY_TZ, prayerTimes } from './prayer.js';
import { hhmm, localToUtc, weekdayOfDay } from '../util/time.js';

export type Interval = [number, number]; // epoch ms [start, end)
export interface Where { city?: string | null; country?: string | null }
export const tzFor = (w: Where, s: Settings) => (w.country && COUNTRY_TZ[w.country]) || s.timeZone;
const cityOf = (w: Where, s: Settings) => CITY_COORDS[w.city ?? ''] ?? CITY_COORDS[s.targetCities[0]?.city ?? 'Riyadh'] ?? CITY_COORDS.Riyadh;

export function subtract(base: Interval[], cuts: Interval[]): Interval[] {
  let out = base.map((x) => [...x] as Interval);
  for (const [cs, ce] of cuts) { const n: Interval[] = []; for (const [s, e] of out) { if (ce <= s || cs >= e) n.push([s, e]); else { if (cs > s) n.push([s, cs]); if (ce < e) n.push([ce, e]); } } out = n; }
  return out.filter(([s, e]) => e - s > 60_000);
}
/** The allowed sending intervals for a local day at a place: windows (local time) minus buffers around each prayer. Empty on non-sending days. */
export function allowedIntervals(day: string, where: Where, s: Settings): Interval[] {
  const tz = tzFor(where, s); if (!s.sendingDays.includes(weekdayOfDay(day))) return [];
  const wins: Interval[] = s.windows.map((w) => [localToUtc(day, hhmm(w.start), tz).getTime(), localToUtc(day, hhmm(w.end), tz).getTime()]);
  const p = prayerTimes(day, cityOf(where, s)); const b = s.prayerBufferMinutes;
  const cuts: Interval[] = [p.dhuhr, p.asr, p.maghrib, p.isha].map((t) => [t.getTime() - b.before * 60000, t.getTime() + b.after * 60000]);
  return subtract(wins, cuts);
}
export const isAllowedAt = (t: number, iv: Interval[]) => iv.some(([a, b]) => t >= a && t < b);
export const totalMs = (iv: Interval[]) => iv.reduce((n, [a, b]) => n + (b - a), 0);
