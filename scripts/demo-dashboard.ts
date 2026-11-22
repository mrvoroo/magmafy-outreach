// Serves the dashboard on seeded DEMO data (fakes) so it can be looked at without any real account:  npx tsx scripts/demo-dashboard.ts  → http://127.0.0.1:8099/?t=demo-token-demo-token-demo-token
import { world } from '../tests/helpers.js';
import { startAdmin } from '../src/ops/admin.js';
const w = await world(); await w.app.start(); await w.makeReady(12); await w.app.morning(); await w.runDay();
const sent = w.store.allLeads().filter((l) => l.first_sent_at); const texts = ['كم السعر؟', 'مو مهتم ولا تراسلوني', 'ارسل التفاصيل', 'بعدين', 'عندنا شركة', 'من معي؟', 'مهتم كلمني', 'لا شكرا'];
for (const [i, t] of texts.entries()) if (sent[i]) { w.wa.emitInbound({ id: 'd' + i, from: sent[i].phone!.replace(/\D/g, ''), jid: 'x', text: t, kind: 'text', at: w.store.now() }); await w.settle(); }
startAdmin(w.app, { token: 'demo-token-demo-token-demo-token', auth: w.crm }, 8099); console.log('demo on 8099');
