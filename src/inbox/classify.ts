import { normalizeAr } from '../personalize/arabic.js';

export type ReplyCategory = 'who_is_this' | 'price' | 'send_details' | 'has_agency' | 'later' | 'not_interested' | 'voice_or_call' | 'positive' | 'employee' | 'opt_out' | 'other';
export interface Classification { category: ReplyCategory; confidence: number; matched: string[] }

const R = (...p: string[]) => new RegExp(p.map((x) => normalizeAr(x)).join('|'), 'i');
// Opt-out detection is CODE, never AI (plan §6.7): Arabic + English, direct and polite forms.
const OPT_OUT = R('لا (?:ت|)راسل(?:وني|ني|نا)', 'لا (?:ت|)رسل(?:وا)? (?:لي|لنا|ي)', 'لا تتواصل(?:وا)?', 'لا تكلم(?:ني|وني)', 'لا تتصل(?:وا)?', 'ما ابي رسايل', 'ما ابغى رسايل', 'ما ابي (?:اي |)(?:رسايل|تواصل)', 'احذف(?:وا)? (?:رقمي|رقمنا|الرقم)', 'شيل(?:وني|ني)', 'ازل(?:وني|ني)', 'ايقاف الرسايل', 'اوقف(?:وا)? الرسايل', 'مزعج', 'سبام', 'spam', '\\bstop\\b', 'unsubscribe', "don'?t (?:message|contact|text|call) (?:me|us)", 'do not (?:message|contact|text)', 'remove (?:me|my number)', 'leave me alone', 'بلاك', 'راح ابلغ', 'بلغت عنكم', 'report');
const NOT_INTERESTED = R('مو مهتم', 'مب مهتم', 'مش مهتم', 'غير مهتم', 'مانا مهتم', 'ما نحتاج', 'ما احتاج', 'مو محتاج', 'لا شكرا', 'لا مشكور', 'مو مطلوب', 'ما يهمنا', 'ما يهمني', 'not interested', 'no thanks', 'no thank you');
const HAS_AGENCY = R('عندنا (?:شركه|وكاله|مكتب|مسوق|فريق)', 'عندي (?:شركه|وكاله|مسوق)', 'نتعامل مع (?:شركه|وكاله|مكتب)', 'متعاقدين مع', 'لدينا (?:شركه|وكاله|فريق)', 'we have (?:an |a )?(?:agency|team|marketer)', 'already work with');
const LATER = R('بعدين', 'لاحقا', 'بعد (?:شهر|اسبوع|رمضان|العيد|الاجازه)', 'الشهر (?:الجاي|القادم)', 'مو الحين', 'ما الحين', 'مب الحين', 'مش الحين', 'وقت ثاني', 'تواصل(?:وا)? (?:معنا|معي) (?:بعد|لاحقا)', 'ارجع', 'كلمني بعد', 'next month', 'later', 'not now');
const WHO = R('من (?:انت|معي|معاي|هذا|يتكلم|اي شركه)', 'منو معي', 'مين معي', 'مين انت', 'مين هذا', 'وش (?:تبي|تبغى|تبون|الموضوع|شغلكم)', 'ايش (?:تبي|تبغى|الموضوع)', 'من وين (?:جبت|جبتو|حصلت|حصلتو|عرفت)', 'كيف (?:جبت|حصلت|عرفت) (?:على )?(?:رقمي|الرقم|رقمنا)', 'من اعطاك', 'who (?:is|are) (?:this|you)', 'how did you get');
const PRICE = R('كم (?:السعر|الاسعار|التكلفه|تكلف|تاخذ|تبون)', 'بكم', 'السعر', 'الاسعار', 'تكلفه', 'كم (?:تكلف|يكلف)', 'how much', 'price', 'pricing', 'cost');
const EMPLOYEE = R('انا (?:موظف|موظفه|مندوب|سكرتير|محاسب)', 'المدير (?:مو|مب|غير|مش) موجود', 'كلم (?:المدير|المسوول|الاداره)', 'ارسل (?:للمدير|للاداره|للمسوول)', 'صاحب المعرض (?:مو|مب|غير)', 'مو انا (?:المسوول|المدير)', 'اتواصل مع (?:المدير|الاداره)', 'i am (?:an )?employee', 'the (?:owner|manager) is not');
const DETAILS = R('ارسل (?:لي|لنا|ي|التفاصيل|الفكره|الافكار)', 'ابشر', 'ارسل', 'تفاصيل', 'وش الفكره', 'ايش الفكره', 'اي فكره', 'ايه ارسل', 'نعم', 'ايوه', 'ايوا', 'تمام ارسل', 'اكيد', 'حياك', 'تفضل', 'send (?:me )?(?:the )?(?:details|idea|info)', 'yes', 'sure', 'ok send');
const POSITIVE = R('مهتم', 'مهتمين', 'كلمني', 'كلمونا', 'اتصل(?:وا)? (?:علي|علينا|بي)', 'ممتاز', 'تمام', 'مناسب', 'خلنا نتكلم', 'نتكلم', 'موافق', 'interested', "let'?s talk", 'call me', 'sounds good');

/** Deterministic classifier. Order matters: the safest/strongest signals first. */
export function classifyRules(text: string | null, kind: string): Classification {
  if (kind === 'voice' || kind === 'call' || kind === 'missed_call') return { category: 'voice_or_call', confidence: 0.99, matched: [kind] };
  const t = normalizeAr(text ?? '').replace(/[^\p{L}\p{N}\s']/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return { category: 'other', confidence: 0.2, matched: [] };
  const order: [ReplyCategory, RegExp][] = [['opt_out', OPT_OUT], ['not_interested', NOT_INTERESTED], ['has_agency', HAS_AGENCY], ['later', LATER], ['who_is_this', WHO], ['price', PRICE], ['employee', EMPLOYEE], ['send_details', DETAILS], ['positive', POSITIVE]];
  const hits = order.filter(([, re]) => re.test(t));
  if (!hits.length) return { category: 'other', confidence: 0.3, matched: [] };
  // "مو مهتم ولا تراسلوني": opt_out wins over not_interested because it is first in order.
  // "نعم" is ambiguous only with a long text; a one-word yes after our question means send_details.
  const [category] = hits[0]; const clear = hits.length === 1 || category === 'opt_out';
  return { category, confidence: clear ? 0.9 : 0.7, matched: hits.map(([c]) => c) };
}
