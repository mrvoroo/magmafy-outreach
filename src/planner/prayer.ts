import { addDays, localToUtc, zonedParts, tzOffsetMs } from '../util/time.js';

export interface City { lat: number; lng: number; tz: string }
export const CITY_COORDS: Record<string, City> = {
  Riyadh: { lat: 24.7136, lng: 46.6753, tz: 'Asia/Riyadh' }, Jeddah: { lat: 21.4858, lng: 39.1925, tz: 'Asia/Riyadh' }, Dammam: { lat: 26.4207, lng: 50.0888, tz: 'Asia/Riyadh' },
  Khobar: { lat: 26.2172, lng: 50.1971, tz: 'Asia/Riyadh' }, Makkah: { lat: 21.3891, lng: 39.8579, tz: 'Asia/Riyadh' }, Madinah: { lat: 24.5247, lng: 39.5692, tz: 'Asia/Riyadh' },
  Buraydah: { lat: 26.326, lng: 43.975, tz: 'Asia/Riyadh' }, Dubai: { lat: 25.2048, lng: 55.2708, tz: 'Asia/Dubai' }, 'Abu Dhabi': { lat: 24.4539, lng: 54.3773, tz: 'Asia/Dubai' },
  Sharjah: { lat: 25.3463, lng: 55.4209, tz: 'Asia/Dubai' }, Manama: { lat: 26.2285, lng: 50.586, tz: 'Asia/Bahrain' }, Doha: { lat: 25.2854, lng: 51.531, tz: 'Asia/Qatar' }
};
export const COUNTRY_TZ: Record<string, string> = { SA: 'Asia/Riyadh', AE: 'Asia/Dubai', BH: 'Asia/Bahrain', QA: 'Asia/Qatar' };
const rad = (d: number) => (d * Math.PI) / 180, deg = (r: number) => (r * 180) / Math.PI;

/** NOAA solar position → prayer times (Umm al-Qura convention: Fajr 18.5°, Isha = Maghrib + 90 min; Asr shadow ×1). Accuracy ≈ ±2 min; buffers cover it. */
export function prayerTimes(day: string, c: City): { fajr: Date; dhuhr: Date; asr: Date; maghrib: Date; isha: Date } {
  const [y, m, d] = day.split('-').map(Number);
  const jd = Date.UTC(y, m - 1, d, 12) / 86400000 + 2440587.5; const T = (jd - 2451545) / 36525;
  const L0 = (280.46646 + T * (36000.76983 + T * 0.0003032)) % 360; const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
  const C = Math.sin(rad(M)) * (1.914602 - T * (0.004817 + 0.000014 * T)) + Math.sin(rad(2 * M)) * (0.019993 - 0.000101 * T) + Math.sin(rad(3 * M)) * 0.000289;
  const trueLong = L0 + C; const omega = 125.04 - 1934.136 * T; const lambda = trueLong - 0.00569 - 0.00478 * Math.sin(rad(omega));
  const eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60; const eps = eps0 + 0.00256 * Math.cos(rad(omega));
  const decl = deg(Math.asin(Math.sin(rad(eps)) * Math.sin(rad(lambda))));
  const yy = Math.tan(rad(eps / 2)) ** 2;
  const eqt = 4 * deg(yy * Math.sin(2 * rad(L0)) - 2 * e * Math.sin(rad(M)) + 4 * e * yy * Math.sin(rad(M)) * Math.cos(2 * rad(L0)) - 0.5 * yy * yy * Math.sin(4 * rad(L0)) - 1.25 * e * e * Math.sin(2 * rad(M)));
  const noonUtcMin = 720 - 4 * c.lng - eqt;
  const ha = (alt: number) => deg(Math.acos((Math.sin(rad(alt)) - Math.sin(rad(c.lat)) * Math.sin(rad(decl))) / (Math.cos(rad(c.lat)) * Math.cos(rad(decl)))));
  const asrAlt = deg(Math.atan(1 / (1 + Math.tan(rad(Math.abs(c.lat - decl))))));
  const at = (minUtc: number) => new Date(Date.UTC(y, m - 1, d) + minUtc * 60000);
  const maghribMin = noonUtcMin + 4 * ha(-0.833);
  return { fajr: at(noonUtcMin - 4 * ha(-18.5)), dhuhr: at(noonUtcMin + 1), asr: at(noonUtcMin + 4 * ha(asrAlt)), maghrib: at(maghribMin), isha: at(maghribMin + 90) };
}
/** Local day of the UTC instant, used to keep a prayer time on the right local day. */
export function localMinutes(d: Date, tz: string) { const p = zonedParts(d, tz); return p.hour * 60 + p.minute; }
export { addDays, localToUtc, tzOffsetMs };
