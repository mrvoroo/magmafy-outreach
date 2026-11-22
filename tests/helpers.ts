import { Db } from '../src/db/db.js';
import { Store } from '../src/db/store.js';
import { FakeClock } from '../src/util/clock.js';
import { SeededRng } from '../src/util/rng.js';
import { FakeCrm } from '../src/crm/fake.js';
import { FakeWhatsApp } from '../src/sender/port.js';
import { OfflineAi } from '../src/personalize/ai.js';
import { FakeTelegram } from '../src/control/bot.js';
import { App } from '../src/app.js';
import { localToUtc, addDays, dayKey, weekdayOfDay } from '../src/util/time.js';
import { goldenLeads, seedGolden } from './golden-fixtures.js';

export const TZ = 'Asia/Riyadh';
export async function world(opts: { env?: Record<string, string>; start?: string; places?: any; web?: any } = {}) {
  const start = opts.start ?? '2026-12-05'; const clock = new FakeClock(localToUtc(start, 7 * 60, TZ)); const store = new Store(new Db(), clock);
  store.setSetting('sendMode', 'auto'); store.setSetting('warmup', { enabled: false, steps: [{ fromDay: 1, perDay: 12 }] }); store.setSetting('newPerDay', 5);
  const crm = new FakeCrm(); const wa = new FakeWhatsApp(); wa.now = () => clock.now().getTime(); const tg = new FakeTelegram(); const alerts: string[] = [];
  const app = new App({ store, crm, wa, ai: new OfflineAi(), tg, env: { SEND_ENABLED: 'true', TELEGRAM_OWNER_ID: 'owner', ...(opts.env ?? {}) }, rng: new SeededRng(11), sleep: async () => {}, places: opts.places, web: opts.web });
  const settle = async () => { await new Promise((r) => setTimeout(r, 5)); await new Promise((r) => setTimeout(r, 5)); };
  /** Creates n qualified leads with evidence (from the golden fixtures) so morning() personalises them. */
  let made = 0;
  const makeReady = async (n: number) => {
    const g = goldenLeads().filter((x) => x.ev.length).slice(made, made + n); made += n;
    const base = made - n; const ids = g.map((x, i) => seedGolden(store, [{ ...x, name: x.name + ' ' + (base + i) }], 100 + base + i)[0]);
    for (const id of ids) store.updateLead(id, { tier: 'A', score: 80, city: 'Riyadh', country: 'SA' } as any);
    return ids;
  };
  /** Runs every planned item of the current day through the real sender at its planned time. */
  const runDay = async () => { const day = dayKey(clock.now(), TZ); for (let i = 0; i < 60; i++) { await app.sync.flush(); const nx = app.planner.items(day).find((x) => x.state === 'planned'); if (!nx) break; clock.set(new Date(Math.max(clock.now().getTime(), new Date(nx.target_at).getTime()) + 1000)); await app.tick(); await new Promise((r) => setTimeout(r, 0)); } await app.sync.flush(); };
  const nextDay = async () => { let d = addDays(dayKey(clock.now(), TZ), 1); while (weekdayOfDay(d) === 5) d = addDays(d, 1); clock.set(localToUtc(d, 7 * 60, TZ)); };
  return { clock, store, crm, wa, tg, app, settle, makeReady, runDay, nextDay, get today() { return dayKey(clock.now(), TZ); } };
}
void goldenLeads;
