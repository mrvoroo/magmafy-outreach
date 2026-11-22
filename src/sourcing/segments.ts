import type { Segment } from '../db/store.js';
import type { Place } from './places.js';

export const QUERIES: Record<Segment, { ar: string[]; en: string[] }> = {
  furniture: { ar: ['معارض أثاث', 'معرض أثاث منزلي', 'معرض كنب وغرف نوم'], en: ['furniture showroom', 'home furniture store'] },
  decor: { ar: ['محلات ديكور منزلي', 'متجر ديكور'], en: ['home decor store'] },
  furnishing: { ar: ['مفروشات', 'ستائر وسجاد', 'محل ستائر', 'محل سجاد', 'مفروشات وأطقم كنب مجلس', 'إضاءة وثريات', 'مفارش ومخدات'], en: ['carpets and curtains store', 'home textiles bedding store', 'lighting chandelier store', 'majlis sofa furnishing store'] }
};

// STRICT exclusions (plan §6.1). Borderline = excluded, never guessed.
const EXCLUDE = [
  /مقاول|مقاولات|تشطيب|تنفيذ ديكور|تشطيبات|contracting|contractor|fit[- ]?out|fitout|renovation|ترميم|نجارة|نجار\b|carpentry|joinery/i,
  /مكتب (تصميم|هندسي|استشار)|تصميم داخلي|تصاميم داخلية|interior design(?:er)? (office|studio|firm)|design studio|architect|هندسة معمارية/i,
  /مطابخ|مطبخ|kitchen|أبواب|ابواب|\bdoors?\b|شبابيك|windows|ألمنيوم|الومنيوم|aluminium|aluminum|جبس|gypsum/i,
  /مصنع|مصانع|factory|manufactur|مصنّع/i,
  /مواد بناء|أدوات صحية|سباكة|كهربائية|hardware|building material|sanitary|plumbing|بلاط|سيراميك|tiles?\b|ceramic|دهانات|paint/i,
  /عقار|عقارات|real estate|properties|developer|مطور عقاري/i,
  /online only|متجر إلكتروني فقط|أونلاين فقط/i,
  /مستعمل|أثاث مستعمل|used furniture|second[- ]hand|توصيل ونقل|نقل عفش|moving|movers|حراج/i,
  /فندق|hotel|مطعم|restaurant|كافيه|cafe|صالون|salon|مستشفى|clinic/i
];
const BAD_TYPES = new Set(['general_contractor', 'real_estate_agency', 'home_improvement_store', 'hardware_store', 'electrician', 'plumber', 'painter', 'moving_company', 'roofing_contractor', 'lodging', 'restaurant', 'cafe', 'storage', 'car_dealer', 'doctor', 'beauty_salon', 'hair_care']);
const FURNITURE = /أثاث|اثاث|كنب|غرف نوم|غرف (?:معيشة|جلوس)|مجلس|furniture|sofa|bedroom|sectional/i;
const DECOR = /ديكور|decor|ديكورات|هدايا منزلية|مرايا|mirrors?|لوحات|تحف|إكسسوار|accessor|vases?|مزهري/i;
const FURNISHING = /مفروشات|ستائر|ستارة|curtain|سجاد|carpet|rug|مفارش|مخدات|بياضات|bedding|textile|linen|إضاءة|اضاءة|ثريات|lighting|chandelier|أباجورات|مراتب|mattress|منسوجات|برادي|blinds/i;

export type Classification = { ok: true; segment: Segment } | { ok: false; reason: string };
/** Returns the segment or a reason. Deterministic: tested with a library of good and bad names. */
export function classifyPlace(p: Pick<Place, 'name' | 'types'>, searched?: Segment): Classification {
  const name = p.name ?? '';
  for (const t of p.types ?? []) if (BAD_TYPES.has(t)) return { ok: false, reason: 'bad_type:' + t };
  for (const re of EXCLUDE) { const m = name.match(re); if (m) return { ok: false, reason: 'excluded_word:' + m[0].toLowerCase() }; }
  const hits: Segment[] = [];
  if (FURNITURE.test(name) || (p.types ?? []).includes('furniture_store')) hits.push('furniture');
  if (DECOR.test(name)) hits.push('decor');
  if (FURNISHING.test(name)) hits.push('furnishing');
  if (!hits.length && (p.types ?? []).includes('home_goods_store')) hits.push(searched === 'furnishing' ? 'furnishing' : 'decor');
  if (!hits.length) return { ok: false, reason: 'no_segment_signal' };
  // Prefer what we searched for when it matches; otherwise the first signal (furniture > furnishing > decor).
  const seg = searched && hits.includes(searched) ? searched : hits.includes('furniture') ? 'furniture' : hits.includes('furnishing') ? 'furnishing' : 'decor';
  return { ok: true, segment: seg };
}

const BIG_BRANDS = /ايكيا|إيكيا|ikea|هوم سنتر|home centre|home center|safat home|بان|pan emirates|الجفالي|danube|دانوب|home box|هوم بوكس|2xl|ikea|مفروشات بيت الأثاث|فيرست فيرنيتشر|ace home|اس بي|sb furniture|هوم ماكس|homemax|الخزامى|al khozama|أثاث الدار|nayomi|نايومي|royal furniture|روايال فيرنتشر|اكسترا|extra/i;
/** Large chains with a marketing department go to the "too big" bucket (not deleted). */
export function isTooBig(p: { name: string; reviewCount?: number | null }, branchCount = 1): boolean {
  return BIG_BRANDS.test(p.name) || (p.reviewCount ?? 0) > 3000 || branchCount >= 5;
}
export const normBrand = (n: string) => n.toLowerCase().replace(/[ً-ٟـ]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\b(فرع|branch|ال)\b/g, '').trim().split(' ').slice(0, 2).join(' ');
