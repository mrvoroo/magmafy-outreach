import { describe, it, expect } from 'vitest';
import { world } from './helpers.js';
import { FakePlaces, Place } from '../src/sourcing/places.js';
import { FakeWeb } from '../src/enrich/web.js';

const reviews = (t: string) => [{ text: t, rating: 5, publishTime: '2026-11-10T00:00:00Z' }, { text: 'جودة الخامات رائعة والتوصيل سريع وأنصح بالتعامل معهم', rating: 5, publishTime: '2026-11-02T00:00:00Z' }];
const mk = (i: number, name: string, extra: Partial<Place> = {}): Place => ({ id: 'pl' + i, name, types: ['furniture_store'], reviews: reviews('ما شاء الله تنوع الكنب عندهم كبير والتعامل راقي جدا ' + i), rating: 4.6, reviewCount: 80 + i, businessStatus: 'OPERATIONAL', phone: '+966 55 ' + String(3000000 + i * 17).replace(/(\d{3})(\d{4})/, '$1 $2'), website: null, ...extra });

describe('END-TO-END (all fakes): source → enrich → qualify → personalize → plan → send → CRM → reply → follow-up → close', () => {
  it('runs a full cycle with every safety property holding', async () => {
    const good = Array.from({ length: 14 }, (_, i) => mk(i, ['معرض الراقي للأثاث', 'ستائر الفخامة', 'لمسة ديكور', 'بيت الكنب', 'مفروشات الورد', 'ديكور النخبة', 'أثاث الواحة', 'سجاد الخليج'][i % 8] + ' ' + (i + 1), { types: i % 3 ? ['furniture_store'] : ['home_goods_store'] }));
    const bad = [mk(100, 'مطابخ الأمل'), mk(101, 'شركة التشطيبات والمقاولات'), mk(102, 'IKEA', { reviewCount: 9000 }), mk(103, 'معرض مغلق للأثاث', { businessStatus: 'CLOSED_PERMANENTLY' })];
    const w = await world({ places: new FakePlaces([...good, ...bad]), web: new FakeWeb({}) }); await w.app.start();
    const r = await w.app.sourcer!.run({ city: 'Riyadh', cityAr: 'الرياض', country: 'SA', target: 50 });
    expect(r.created).toBeGreaterThan(10); expect(r.tooBig).toBe(1);
    for (const l of w.store.allLeads()) if (['مطابخ الأمل', 'شركة التشطيبات والمقاولات', 'IKEA', 'معرض مغلق للأثاث'].includes(l.name)) expect(['rejected', 'too_big']).toContain(l.status);
    await w.app.morning(); await w.runDay(); await w.app.sync.flush();
    const sent = w.store.db.all("SELECT * FROM messages WHERE direction='out' AND state='sent'"); expect(sent.length).toBe(5); // newPerDay=5 in this world
    // exact text mirrored once into the CRM, every lead once
    expect(w.crm.leads.size).toBeGreaterThanOrEqual(5);
    for (const m of sent) { const l = w.store.lead(m.lead_id)!; const c = w.crm.leads.get(l.crm_id!)!; expect(c.log.filter((x) => x.dir === 'out' && x.text === m.text)).toHaveLength(1); expect(c.attempts).toBe(1); expect(c.stage).toBe('تم التواصل'); }
    expect(new Set(sent.map((m) => m.text)).size).toBe(5); expect(w.wa.sent.map((s) => s.text).sort()).toEqual(sent.map((m) => m.text).sort());
    // caps never exceeded, nothing at a prayer time / Friday: covered by planner tests; here: nothing sent twice to a number
    expect(new Set(w.wa.sent.map((s) => s.digits)).size).toBe(5);
    // a reply stops its follow-ups, the others continue; after 12 more days everything is closed or replied
    const target = w.store.lead(sent[0].lead_id)!; w.wa.emitInbound({ id: 'r1', from: target.phone!.replace(/\D/g, ''), jid: 'x', text: 'ارسل التفاصيل', kind: 'text', at: w.store.now() }); await w.settle();
    for (let d = 0; d < 13; d++) { await w.nextDay(); await w.app.morning(); await w.runDay(); }
    expect(w.store.lead(target.id)!.status).toBe('replied'); expect(w.store.messagesOf(target.id).filter((m) => m.direction === 'out' && m.state === 'sent')).toHaveLength(1);
    const closed = w.store.allLeads().filter((l) => l.status === 'no_reply_closed'); expect(closed.length).toBeGreaterThanOrEqual(1);
    const rec = await w.app.sync.reconcile(); expect(rec.crmKnown).toBe(rec.localLeads); expect(rec.dead).toBe(0);
    // every lead's attempts in the CRM are within the cap of 4 and equal the number of cold messages we sent
    for (const l of w.store.allLeads().filter((x) => x.crm_id)) { const cold = w.store.messagesOf(l.id).filter((m) => m.direction === 'out' && m.state === 'sent' && !m.kind.startsWith('reply')).length; expect(w.crm.leads.get(l.crm_id!)!.attempts).toBe(Math.min(4, cold)); }
    expect(w.tg.sent.some((t) => t.text.includes('replied'))).toBe(true);
  });
  it('failure injection: CRM down for a whole day → nothing is sent without the mirror (fail closed), nothing lost after it recovers', async () => {
    const w = await world(); await w.app.start(); await w.makeReady(4); await w.app.morning(); w.crm.down = true; await w.runDay(); expect(w.wa.sent).toHaveLength(0);
    w.crm.down = false; w.clock.advance(3600e3); await w.app.sync.flush(); w.clock.advance(3600e3); await w.app.sync.flush(); expect(w.app.sync.pending()).toBe(0);
  });
  it('system restart in the middle of the day keeps working from the database', async () => {
    const w = await world(); await w.app.start(); await w.makeReady(5); await w.app.morning(); const day = w.today; const items = w.app.planner.items(day);
    w.clock.set(new Date(new Date(items[0].target_at).getTime() + 1000)); await w.app.tick(); await new Promise((r) => setTimeout(r, 0)); w.clock.set(new Date(new Date(items[1].target_at).getTime() + 1000)); await w.app.tick(); await new Promise((r) => setTimeout(r, 0));
    const { App } = await import('../src/app.js'); const { SeededRng } = await import('../src/util/rng.js');
    const app2 = new App({ store: w.store, crm: w.crm, wa: w.wa, ai: (w.app as any).d.ai, tg: w.tg, env: { SEND_ENABLED: 'true', TELEGRAM_OWNER_ID: 'owner' }, rng: new SeededRng(99), sleep: async () => {} }); await app2.start(); await app2.morning();
    expect(app2.planner.items(day).map((i) => i.id)).toEqual(items.map((i) => i.id)); for (let i = 0; i < 30; i++) { const nx = app2.planner.items(day).find((x) => x.state === 'planned'); if (!nx) break; w.clock.set(new Date(Math.max(w.clock.now().getTime() + 5 * 60000, new Date(nx.target_at).getTime() + 1000))); await app2.tick(); await new Promise((r) => setTimeout(r, 0)); }
    expect(w.wa.sent.length).toBe(5); expect(new Set(w.wa.sent.map((s) => s.text)).size).toBe(5);
  });
});
