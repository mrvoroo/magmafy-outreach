import { Store, Segment } from '../src/db/store.js';

export interface GoldenLead { name: string; segment: Segment; owner?: string; ev: { type: string; snippet: string; internal?: boolean }[] }
const R = (t: string) => ({ type: 'review', snippet: t, internal: true });
export const goldenLeads = (): GoldenLead[] => [
  { name: 'معرض الراقي للأثاث', segment: 'furniture', owner: 'خالد العتيبي', ev: [R('ما شاء الله تنوع الكنب عندهم كبير والتعامل راقي جدا'), { type: 'website_text', snippet: 'الموقع يعرض: كنب، غرف نوم، مجالس' }] },
  { name: 'بيت الكنب', segment: 'furniture', ev: [R('جودة الخامات ممتازة وأنصح بالتعامل معهم لأن التوصيل كان سريع')] },
  { name: 'غرف نوم الفخامة', segment: 'furniture', ev: [{ type: 'review_pattern', snippet: 'عدة تقييمات إيجابية تذكر سرعة التوصيل' }] },
  { name: 'معرض النخبة', segment: 'furniture', owner: 'أبو فهد الشمري', ev: [{ type: 'recent_update', snippet: 'وصل حديثًا مجموعة كنب مودرن جديدة لموسم الشتاء', internal: false }] },
  { name: 'ركن المجلس', segment: 'furniture', ev: [{ type: 'website_text', snippet: 'الموقع يعرض: مجالس، كنب، طاولات سفرة' }] },
  { name: 'أثاث الواحة', segment: 'furniture', ev: [{ type: 'rating', snippet: 'تقييم 4.7 من 210 تقييم على خرائط جوجل', internal: true }] },
  { name: 'لمسة ديكور', segment: 'decor', ev: [R('ديكورات جميلة وتشكيلة متنوعة وأسعار مناسبة والتعامل محترم جدا')] },
  { name: 'ديكور الأناقة', segment: 'decor', owner: 'عبد الله القحطاني', ev: [{ type: 'website_text', snippet: 'الموقع يعرض: ديكور، مرايا، إضاءة' }] },
  { name: 'بيت التحف', segment: 'decor', ev: [{ type: 'recent_update', snippet: 'مجموعة جديدة من المزهريات والتحف المنزلية وصلت اليوم', internal: false }] },
  { name: 'ركن الديكور', segment: 'decor', ev: [R('تشكيلة رائعة من المرايا والديكورات والتعامل راقي ما شاء الله')] },
  { name: 'لمسات منزلية', segment: 'decor', ev: [] },
  { name: 'ستائر الفخامة', segment: 'furnishing', ev: [R('جودة الخامات رائعة والتركيب كان سريع وأنصح بهم')] },
  { name: 'عالم السجاد', segment: 'furnishing', owner: 'سعد المطيري', ev: [{ type: 'website_text', snippet: 'الموقع يعرض: سجاد، ستائر، مفارش وبياضات' }] },
  { name: 'بيت الإضاءة', segment: 'furnishing', ev: [{ type: 'review_pattern', snippet: 'عدة تقييمات إيجابية تذكر جودة الخامات والتصنيع' }] },
  { name: 'مفارش الراحة', segment: 'furnishing', ev: [R('تنوع المفارش كبير والتعامل راقي والتوصيل سريع ما شاء الله')] },
  { name: 'ثريات النور', segment: 'furnishing', ev: [{ type: 'recent_update', snippet: 'وصل حديثًا ثريات كريستال بتصاميم عصرية جديدة', internal: false }] },
  { name: 'معرض الأصالة للأثاث', segment: 'furniture', ev: [R('خدمة ممتازة وتعامل راقي وتنوع في غرف النوم ما شاء الله')] },
  { name: 'كنب المدينة', segment: 'furniture', ev: [] },
  { name: 'دار الأثاث', segment: 'furniture', owner: 'محمد الدوسري', ev: [R('جودة التصنيع ممتازة والتوصيل في الموعد وأنصح بالتعامل')] },
  { name: 'ديكور اللمسة الذهبية', segment: 'decor', ev: [{ type: 'rating', snippet: 'تقييم 4.5 من 90 تقييم على خرائط جوجل', internal: true }] },
  { name: 'منزل الأحلام للمفروشات', segment: 'furnishing', ev: [R('تشكيلة الستائر متنوعة والتعامل محترم جدا ما شاء الله')] },
  { name: 'غرف الجلوس', segment: 'furniture', ev: [{ type: 'website_text', snippet: 'الموقع يعرض: كنب، مجالس، غرف نوم' }] },
  { name: 'بيت الديكور الحديث', segment: 'decor', ev: [R('ديكورات عصرية وتنوع كبير والتعامل راقي ما شاء الله')] },
  { name: 'سجاد وموكيت الخليج', segment: 'furnishing', ev: [{ type: 'review_pattern', snippet: 'عدة تقييمات إيجابية تذكر تنوع التشكيلة' }] },
  { name: 'أثاث السعادة', segment: 'furniture', ev: [R('ما شاء الله تنوع كبير في الكنب والتوصيل سريع وأنصح بالتعامل')] },
  { name: 'نسيج البيت', segment: 'furnishing', ev: [{ type: 'recent_update', snippet: 'مجموعة جديدة من البياضات والمفارش وصلت حديثا', internal: false }] },
  { name: 'ركن الأناقة للأثاث', segment: 'furniture', ev: [R('جودة ممتازة وتعامل راقي ما شاء الله تنوع في غرف المعيشة')] },
  { name: 'لوحات وتحف', segment: 'decor', ev: [{ type: 'website_text', snippet: 'الموقع يعرض: لوحات، تحف، ديكور' }] },
  { name: 'ستارة وسجادة', segment: 'furnishing', ev: [R('تعامل راقي وخامات ممتازة وتشكيلة سجاد متنوعة ما شاء الله')] },
  { name: 'معرض الخليج للأثاث', segment: 'furniture', owner: 'ناصر الحربي', ev: [R('ما شاء الله جودة التصنيع ممتازة والتوصيل سريع')] }
];
export function seedGolden(s: Store, leads: GoldenLead[], offset = 0): string[] {
  return leads.map((g, i0) => {
    const i = i0 + offset;
    const l = s.createLead({ name: g.name, segment: g.segment, place_id: 'g' + i, phone: '+96655' + String(1000000 + i), owner_name: g.owner ?? null });
    for (const e of g.ev) s.addEvidence({ lead_id: l.id, type: e.type, snippet: e.snippet, source: e.internal ? 'google_places' : 'website', source_url: null, internal_only: !!e.internal, expires_at: null });
    s.transition(l.id, 'enriched', 't'); s.transition(l.id, 'qualified', 't'); return l.id;
  });
}
