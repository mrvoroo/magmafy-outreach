import { countWords, significant, shingles, jaccard, normalizeAr } from './arabic.js';
import type { Evidence } from '../db/store.js';

export interface Check { name: string; pass: boolean; detail?: string }
export interface ValidationInput {
  text: string; kind: 'first' | 'followup1' | 'followup2' | 'followup3'; personalLine: string | null; evidenceIds: string[]; evidence: Evidence[]; ownerName: string | null; senderFirstName: string; company: string; recentTexts: { text: string; personalLine?: string | null }[]; claimsAllowed?: boolean;
}
const PRICE = /(سعر|اسعار|أسعار|بسعر|ريال|ر\.س|sar|usd|\$|دولار|خصم|خصومات|تخفيض|عرض خاص|عروض|مجان|باقة|باقات|اشتراك|تكلفة|رسوم|ميزانية|discount|price|package|free)/i;
const URL_RE = /(https?:|www\.|wa\.me|\.com|\.net|\.sa\b|\.ae\b|bit\.ly|instagram\.com|رابط|لينك|link)/i;
const CRITIC = /(ضعيف|ضعيفه|ضعيفة|قديم|قديمة|سيء|سيئ|رديء|مو حلو|مش حلو|ما عندكم|ينقصكم|تنقصكم|تحتاج(?:ون)? (?:تحسين|تطوير)|مشكلة في|غلط|أخطاء|اخطاء|تأخرتم|فاشل|ما يشتغل|متأخر|خسارة إنكم|للأسف|weak|bad|old|outdated)/i;
const CLAIM = /(نضمن|ضمان|مضمون|مضمونة|عملاء سابقين|عملائنا السابقين|اشتغلنا مع|عملنا مع|خدمنا|ضاعفنا|عشرات|مئات|آلاف|الف عميل|أفضل شركة|الأفضل|رقم 1|الأولى في|أكثر من \d|نتائج مضمونة|نتائج مذهلة|guarantee|best|#1|proven)/i;
const BAD_GREETING = /(عزيزي|عزيزتي|السيد المدير|المدير الكريم|حضرة|dear|sir|madam|manager)/i;
const TITLE_NAME = /(?<![\u0600-\u06FF])(?:أستاذ|الأستاذ|استاذ|أخوي|الأخ|اخوي|دكتور|د\.|الشيخ|شيخ|أبو|ابو|أم|ام)\s+([ء-ي]{2,})/g;
const EMOJI = /\p{Extended_Pictographic}/gu;
const LATIN_WORD = /[A-Za-z]{2,}/g;

export function validate(i: ValidationInput): { pass: boolean; checks: Check[] } {
  const c: Check[] = []; const t = i.text; const add = (name: string, pass: boolean, detail?: string) => c.push({ name, pass, detail });
  const wc = countWords(t);
  add('under_40_words', wc < 40 && wc >= 5, `${wc} words`);
  add('no_price_or_package', !PRICE.test(t), t.match(PRICE)?.[0]);
  add('no_link', !URL_RE.test(t), t.match(URL_RE)?.[0]);
  const emoji = t.match(EMOJI) ?? []; add('emoji_max_one', emoji.length <= 1, `${emoji.length}`);
  add('no_criticism', !CRITIC.test(t), t.match(CRITIC)?.[0]);
  add('no_claims', i.claimsAllowed ? true : !CLAIM.test(t), t.match(CLAIM)?.[0]);
  add('no_digits', !/[0-9٠-٩]/.test(t), 'digits can carry prices/claims');
  add('no_generic_greeting', !BAD_GREETING.test(t), t.match(BAD_GREETING)?.[0]);
  const latin = (t.match(LATIN_WORD) ?? []).filter((w) => w.toLowerCase() !== i.company.toLowerCase());
  add('no_english_jargon', latin.length === 0, latin.join(','));
  // names: only the real owner's name may appear after a title
  const titled = [...t.matchAll(TITLE_NAME)].map((m) => normalizeAr(m[1]));
  const known = new Set((i.ownerName ?? '').split(/\s+/).map(normalizeAr).filter(Boolean));
  const badName = titled.filter((n) => !known.has(n));
  add('name_only_if_found', badName.length === 0 && (i.ownerName ? true : titled.length === 0), badName.join(',') || (i.ownerName ? '' : titled.join(',')));
  if (i.kind === 'first') {
    add('has_sender_and_company', t.includes(i.senderFirstName) && new RegExp(i.company, 'i').test(t), '');
  }
  add('ends_with_question_or_close', i.kind === 'followup3' || i.kind === 'followup1' ? true : /[؟?]\s*$/.test(t.trim()), '');
  add('single_message_no_lists', !/(\n\s*[-•*\d])/.test(t) && !/[•]/.test(t), '');
  // evidence grounding (first + followup2 need a personal line)
  if (i.personalLine) {
    const evs = i.evidence.filter((e) => i.evidenceIds.includes(e.id));
    add('evidence_cited', evs.length > 0 && evs.length === i.evidenceIds.length, `${evs.length}/${i.evidenceIds.length}`);
    add('line_in_message', t.includes(i.personalLine), '');
    const ls = significant(i.personalLine); const es = new Set<string>(); for (const e of evs) for (const w of significant(e.snippet)) es.add(w);
    const overlap = [...ls].filter((w) => es.has(w));
    add('line_overlaps_evidence', overlap.length >= 1, overlap.join(',') || 'none');
  }
  // anti-pattern: near-duplicates of the last messages
  const mine = shingles(t); const myLine = i.personalLine ? significant(i.personalLine) : new Set<string>();
  let dupe = '';
  for (const r of i.recentTexts.slice(0, 30)) {
    if (r.text === t) { dupe = 'identical text'; break; }
    if (jaccard(mine, shingles(r.text)) >= 0.8) { dupe = 'near-duplicate text'; break; }
    if (r.personalLine && i.personalLine && (r.personalLine === i.personalLine || jaccard(myLine, significant(r.personalLine)) >= 0.7)) { dupe = 'same personal line'; break; }
  }
  add('not_near_duplicate', !dupe, dupe);
  return { pass: c.every((x) => x.pass), checks: c };
}
export const failed = (v: { checks: Check[] }) => v.checks.filter((x) => !x.pass).map((x) => `${x.name}${x.detail ? ' (' + x.detail + ')' : ''}`);
