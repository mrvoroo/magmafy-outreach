import { describe, it, expect } from 'vitest';
import { Db } from '../src/db/db.js';
import { Store } from '../src/db/store.js';
import { FakeClock } from '../src/util/clock.js';
import { classifyPlace, isTooBig } from '../src/sourcing/segments.js';
import { extractFacts, robotsAllows } from '../src/enrich/html.js';
import { FakePlaces, BudgetGuard, BudgetExceeded, Place } from '../src/sourcing/places.js';
import { FakeWeb, PoliteWeb } from '../src/enrich/web.js';
import { Enricher, usableReview } from '../src/enrich/enricher.js';
import { Sourcer } from '../src/sourcing/sourcer.js';
import { normalizePhone } from '../src/domain/phone.js';

const mkStore = () => new Store(new Db(), new FakeClock(new Date('2026-12-01T08:00:00Z')));

describe('segment classification (strict)', () => {
  const ok = (name: string, types: string[] = [], seg?: any) => classifyPlace({ name, types }, seg);
  it('accepts the three segments', () => {
    expect(ok('معرض النخبة للأثاث')).toEqual({ ok: true, segment: 'furniture' });
    expect(ok('Royal Sofa Gallery', ['furniture_store'])).toMatchObject({ ok: true, segment: 'furniture' });
    expect(ok('لمسة ديكور')).toEqual({ ok: true, segment: 'decor' });
    expect(ok('ستائر وسجاد الفخامة')).toMatchObject({ ok: true, segment: 'furnishing' });
    expect(ok('بيت الإضاءة والثريات')).toMatchObject({ ok: true, segment: 'furnishing' });
  });
  it('rejects contractors, design offices, kitchens, doors, factories, hardware, real estate, used, online-only', () => {
    for (const n of ['شركة المقاول للتشطيبات والديكور', 'مكتب تصميم داخلي نورة', 'مطابخ الأمل', 'أبواب وشبابيك الخليج', 'مصنع أثاث الرياض', 'مواد بناء وأدوات صحية', 'عقارات الديكور', 'أثاث مستعمل', 'Falcon Fit-out', 'interior design studio Riyadh', 'Kitchen & Furniture Co', 'سيراميك وبلاط ومفروشات'])
      expect(ok(n).ok, n).toBe(false);
  });
  it('rejects by Google type and when there is no signal (borderline = excluded)', () => {
    expect(ok('معرض الأثاث', ['general_contractor']).ok).toBe(false);
    expect(ok('محل الفرح').ok).toBe(false);
  });
  it('big chains go to too-big', () => {
    expect(isTooBig({ name: 'IKEA Riyadh' })).toBe(true); expect(isTooBig({ name: 'هوم سنتر' })).toBe(true);
    expect(isTooBig({ name: 'معرض صغير', reviewCount: 5000 })).toBe(true); expect(isTooBig({ name: 'معرض صغير', reviewCount: 200 }, 1)).toBe(false);
  });
});

describe('phone normalisation', () => {
  it('handles Saudi mobile formats and Arabic digits', () => {
    for (const x of ['0551234567', '+966 55 123 4567', '00966551234567', '٠٥٥١٢٣٤٥٦٧', '551234567']) expect(normalizePhone(x)?.e164, x).toBe('+966551234567');
    expect(normalizePhone('0551234567')!.type).toBe('mobile'); expect(normalizePhone('+966 11 234 5678')!.type).toBe('landline');
    expect(normalizePhone('abc')).toBeNull(); expect(normalizePhone('12')).toBeNull();
    expect(normalizePhone('+971 50 123 4567')!.country).toBe('AE');
  });
});

describe('website extraction', () => {
  const html = `<html><head><title>معرض الراقي</title><meta name="description" content="معرض متخصص في الكنب وغرف النوم والمجالس بتصاميم عصرية في الرياض"></head><body>
  <a href="https://wa.me/966551234567?text=hi">واتساب</a><a href="https://instagram.com/alraqi_furniture/">انستقرام</a><a href="/about">من نحن</a><a href="mailto:Info@Raqi.com">x</a>
  <p>المؤسس: خالد العتيبي</p><p>وصل حديثًا مجموعة كنب مودرن جديدة لموسم الشتاء</p><p>غرف نوم كنب مجالس</p><script>var x='wa.me/999'</script></body></html>`;
  it('extracts WhatsApp, Instagram, owner, categories, announcements', () => {
    const f = extractFacts(html, 'https://raqi.com/');
    expect(f.whatsapp).toEqual(['966551234567']); expect(f.instagram).toBe('alraqi_furniture'); expect(f.ownerName).toBe('خالد العتيبي');
    expect(f.categories).toEqual(expect.arrayContaining(['كنب', 'غرف نوم', 'مجالس'])); expect(f.announcements[0]).toContain('وصل حديثًا'); expect(f.aboutUrl).toBe('https://raqi.com/about'); expect(f.emails).toEqual(['info@raqi.com']);
  });
  it('does not invent an owner', () => { expect(extractFacts('<p>مرحبا بكم في معرضنا</p>', 'https://x.com').ownerName).toBeNull(); });
  it('robots.txt is respected', () => {
    const r = 'User-agent: *\nDisallow: /private\nAllow: /private/ok\n';
    expect(robotsAllows(r, '/')).toBe(true); expect(robotsAllows(r, '/private/x')).toBe(false); expect(robotsAllows(r, '/private/ok/1')).toBe(true);
    expect(robotsAllows('User-agent: magmafy-outreach\nDisallow: /', '/a')).toBe(false);
  });
  it('PoliteWeb honours robots and rate-limits per host with an honest UA', async () => {
    const seen: any[] = []; let t = 0; const slept: number[] = [];
    const f = (async (url: string, init?: any) => { seen.push([url, init?.headers?.['User-Agent']]); const robots = url.endsWith('/robots.txt'); return new Response(robots ? 'User-agent: *\nDisallow: /no' : 'ok', { status: 200, headers: { 'content-type': 'text/html' } }); }) as any;
    const w = new PoliteWeb(f, 3000, async (ms) => { slept.push(ms); t += ms; }, () => t);
    expect(await w.get('https://a.com/no/page')).toBeNull();
    await w.get('https://a.com/'); await w.get('https://a.com/about');
    expect(slept.length).toBe(1); expect(seen.every(([, ua]) => /magmafy-outreach/.test(ua))).toBe(true);
  });
});

const mkPlace = (o: Partial<Place> & { name: string; id: string }): Place => ({ types: ['furniture_store'], reviews: [], rating: 4.6, reviewCount: 120, businessStatus: 'OPERATIONAL', phone: '+966 55 000 0000', website: null, ...o });
const goodReviews = [{ text: 'ما شاء الله تنوع الكنب عندهم كبير وجودة ممتازة والتعامل راقي جدا', rating: 5, publishTime: '2026-11-01T00:00:00Z' }, { text: 'جودة الخامات رائعة والتوصيل كان سريع وأنصح بالتعامل معهم', rating: 5, publishTime: '2026-10-20T00:00:00Z' }];

describe('sourcer end-to-end with fakes', () => {
  it('creates qualified leads with evidence, rejects out-of-segment, flags big, de-duplicates, never fabricates an owner', async () => {
    const store = mkStore();
    const places = new FakePlaces([
      mkPlace({ id: 'p1', name: 'معرض الراقي للأثاث', phone: '+966 55 111 1111', website: 'https://raqi.com/', reviews: goodReviews }),
      mkPlace({ id: 'p2', name: 'مطابخ الأمل', phone: '+966 55 222 2222' }),
      mkPlace({ id: 'p3', name: 'IKEA', phone: '+966 55 333 3333', reviewCount: 9000 }),
      mkPlace({ id: 'p4', name: 'لمسة ديكور', types: ['home_goods_store'], phone: '+966 55 111 1111', reviews: goodReviews }), // same phone as p1 → duplicate
      mkPlace({ id: 'p5', name: 'ستائر الفخامة', types: ['home_goods_store'], phone: '0551119999', reviews: goodReviews }),
      mkPlace({ id: 'p6', name: 'معرض مغلق للأثاث', businessStatus: 'CLOSED_PERMANENTLY', phone: '+966 55 444 4444' })
    ]);
    const web = new FakeWeb({ 'https://raqi.com/': '<a href="https://wa.me/966551110000">w</a><p>المؤسس: خالد العتيبي</p><p>كنب غرف نوم مجالس</p>' });
    const s = new Sourcer(store, places, new Enricher(store, web));
    const r = await s.run({ city: 'Riyadh', cityAr: 'الرياض', country: 'SA', segments: ['furniture'], target: 10 });
    expect(r.created).toBe(3); expect(r.rejected).toBe(2); expect(r.tooBig).toBe(1); expect(r.duplicates).toBeGreaterThanOrEqual(1);
    const l1 = store.leadByPlace('p1')!;
    expect(l1.status).toBe('qualified'); expect(l1.phone).toBe('+966551110000'); expect(l1.alt_phones).toContain('+966551111111'); expect(l1.owner_name).toBe('خالد العتيبي');
    expect(l1.sources.phone.source).toContain('website_whatsapp_link'); expect(l1.tier).toMatch(/[AB]/);
    expect(store.evidence(l1.id).some((e) => e.type === 'review' && e.internal_only && e.expires_at)).toBe(true);
    expect(store.leadByPlace('p5')!.owner_name).toBeNull();
    expect(store.leadByPlace('p2')!.status).toBe('rejected'); expect(store.leadByPlace('p3')!.status).toBe('too_big');
    // a second run creates nothing new
    const r2 = await s.run({ city: 'Riyadh', cityAr: 'الرياض', country: 'SA', segments: ['furniture'], target: 10 });
    expect(r2.created).toBe(0);
  });
  it('stops cleanly when the budget cap is hit', async () => {
    const store = mkStore(); store.setSetting('budgets', { googleDailyUsd: 0.05, googleMonthlyUsd: 40, aiDailyUsd: 3, aiMonthlyUsd: 40 });
    const g = new BudgetGuard(store, 'google', () => ({ daily: store.settings().budgets.googleDailyUsd, monthly: 40 }));
    g.check(0.04); g.record(0.04, 'x'); expect(() => g.check(0.04)).toThrow(BudgetExceeded);
  });
  it('review filter keeps only specific positive text', () => {
    expect(usableReview(goodReviews[0] as any)).toBe(true);
    expect(usableReview({ text: 'جيد', rating: 5, publishTime: '' })).toBe(false);
    expect(usableReview({ text: 'التوصيل تأخر كثيرا وجودة سيئة جدا والله', rating: 2, publishTime: '' })).toBe(false);
  });
});
