/**
 * Entry point. Safe by default: with no secrets it runs entirely on fakes and dry-run (nothing external, nothing sent).
 *   node dist/main.js            → long-running service
 *   node dist/main.js source     → one sourcing run (Riyadh by default)
 *   node dist/main.js morning    → run the morning job once
 */
import { mkdirSync } from 'node:fs';
import { Db } from './db/db.js';
import { Store } from './db/store.js';
import { EnvSchema, readiness } from './config/env.js';
import { createLogger } from './util/log.js';
import { App } from './app.js';
import { HttpCrm } from './crm/http.js';
import { FakeCrm } from './crm/fake.js';
import { FakeWhatsApp } from './sender/port.js';
import { BaileysWhatsApp } from './sender/baileys.js';
import { AnthropicAi, OfflineAi } from './personalize/ai.js';
import { BudgetGuard, GooglePlaces } from './sourcing/places.js';
import { PoliteWeb } from './enrich/web.js';
import { FakeTelegram, HttpTelegram } from './control/bot.js';
import { startAdmin } from './ops/admin.js';
import { backupAuthState, backupDatabase, prune } from './ops/backup.js';
import { dayKey, zonedParts } from './util/time.js';
import { join, dirname } from 'node:path';

async function main() {
  const env = EnvSchema.parse(process.env); const log = createLogger(env.LOG_LEVEL); const ready = readiness(env);
  mkdirSync(dirname(env.DB_PATH), { recursive: true }); const store = new Store(new Db(env.DB_PATH));
  const s = store.settings(); log.info('starting', { ready, sendEnabled: env.SEND_ENABLED, mode: s.sendMode });
  const guardG = new BudgetGuard(store, 'google', () => ({ daily: store.settings().budgets.googleDailyUsd, monthly: store.settings().budgets.googleMonthlyUsd }), (m) => void tg.send('💸 ' + m));
  const guardA = new BudgetGuard(store, 'ai', () => ({ daily: store.settings().budgets.aiDailyUsd, monthly: store.settings().budgets.aiMonthlyUsd }), (m) => void tg.send('💸 ' + m));
  const tg = ready.telegram ? new HttpTelegram(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_OWNER_ID) : new FakeTelegram();
  const crm = ready.crm ? new HttpCrm(env.CRM_URL, env.CRM_OUTREACH_KEY) : new FakeCrm();
  const live = env.SEND_ENABLED && ready.crm; // live WhatsApp only if the switch is on AND the CRM mirror exists
  const wa = live ? new BaileysWhatsApp(env.AUTH_STATE_DIR, log) : new FakeWhatsApp();
  const ai = ready.ai ? new AnthropicAi(env.ANTHROPIC_API_KEY, env.ANTHROPIC_MODEL, guardA) : new OfflineAi();
  const places = ready.places ? new GooglePlaces(env.GOOGLE_PLACES_API_KEY, guardG) : undefined;
  const app = new App({ store, crm, wa, ai, tg, env: { ...process.env, SEND_ENABLED: live ? 'true' : 'false' } as Record<string, string | undefined>, places, web: new PoliteWeb(), log, pair: live ? (d) => (wa as BaileysWhatsApp).requestPairingCode(d) : undefined });

  const cmd = process.argv[2];
  if (cmd === 'source') { if (!app.sourcer) throw new Error('GOOGLE_PLACES_API_KEY is not set'); const c = s.targetCities[0]; const r = await app.sourcer.run({ city: c.city, cityAr: c.cityAr, country: c.country, target: 120 }); log.info('source done', r); return; }
  if (cmd === 'morning') { log.info('morning', await app.morning()); return; }

  await app.start(); if (live) await wa.connect();
  if (tg instanceof HttpTelegram) void tg.poll();
  if (crm instanceof HttpCrm || ready.admin) startAdmin(app, { token: ready.admin ? env.ADMIN_BASIC_TOKEN : undefined, auth: crm instanceof HttpCrm ? crm : undefined }, Number(process.env.PORT ?? env.ADMIN_PORT), process.env.PORT ? '0.0.0.0' : '127.0.0.1'); else log.warn('dashboard disabled: needs CRM_URL + CRM_OUTREACH_KEY (CRM admin sign-in)');
  // scheduler: one tick a minute (+jitter inside the sender), morning job once per local day, summary in the evening, backup nightly
  let lastMorning = '', lastEvening = '', lastBackup = '';
  const loop = async () => {
    try {
      const st = store.settings(); const now = store.clock.now(); const day = dayKey(now, st.timeZone); const p = zonedParts(now, st.timeZone);
      if (lastMorning !== day && p.hour >= 6) { lastMorning = day; await app.morning(); }
      await app.tick();
      if (lastEvening !== day && `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}` >= st.summaryTime) { lastEvening = day; await app.evening(); try { await app.sync.reconcile(); } catch (e) { log.warn('reconcile failed', { err: String(e) }); } }
      if (lastBackup !== day && p.hour >= 3 && p.hour < 5) { lastBackup = day; await backupDatabase(store.db, join(env.BACKUP_DIR, `outreach-${day}.sqlite`)); prune(env.BACKUP_DIR, 'outreach-'); if (ready.backups) { backupAuthState(env.AUTH_STATE_DIR, join(env.BACKUP_DIR, `auth-${day}.enc`), env.BACKUP_PASSPHRASE); prune(env.BACKUP_DIR, 'auth-'); } }
    } catch (e) { log.error('loop error', { err: String(e) }); }
  };
  const timer = setInterval(loop, 60_000); void loop();
  const stop = () => { clearInterval(timer); log.info('stopping'); setTimeout(() => process.exit(0), 500); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
main().catch((e) => { console.error(e); process.exit(1); });
