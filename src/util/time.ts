/** Time-zone helpers built on Intl only (no dependency). All "day" values are local-day keys "YYYY-MM-DD". */
export function zonedParts(date: Date, tz: string) {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' });
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(date)) p[x.type] = x.value;
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday);
  return { year: +p.year, month: +p.month, day: +p.day, hour: +p.hour, minute: +p.minute, second: +p.second, weekday: wd };
}
export function dayKey(date: Date, tz: string): string {
  const p = zonedParts(date, tz);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}
/** Offset (ms) of `tz` from UTC at the given instant. */
export function tzOffsetMs(date: Date, tz: string): number {
  const p = zonedParts(date, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}
/** Local wall time ("YYYY-MM-DD", minutes since midnight) → UTC Date. */
export function localToUtc(day: string, minutes: number, tz: string): Date {
  const [y, m, d] = day.split('-').map(Number);
  const guess = new Date(Date.UTC(y, m - 1, d, 0, 0, 0) + minutes * 60000);
  let off = tzOffsetMs(guess, tz);
  let utc = new Date(guess.getTime() - off);
  off = tzOffsetMs(utc, tz);
  utc = new Date(guess.getTime() - off);
  return utc;
}
export function weekdayOfDay(day: string): number { // 0=Sun..6=Sat of a local day key
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d) + n * 86400000);
  return t.toISOString().slice(0, 10);
}
export function diffDays(a: string, b: string): number { // b - a
  const f = (s: string) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((f(b) - f(a)) / 86400000);
}
export const hhmm = (s: string): number => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
