const DIACRITICS = /[ً-ٰٟـ]/g;
export function normalizeAr(s: string): string {
  return s.replace(DIACRITICS, '').replace(/[إأآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي').toLowerCase();
}
/** Words = whitespace-separated tokens that contain at least one letter. */
export function words(s: string): string[] { return s.split(/\s+/).filter((t) => /[\p{L}\p{N}]/u.test(t)); }
export const countWords = (s: string) => words(s).length;
const STOP = new Set(['من', 'في', 'على', 'الى', 'عن', 'مع', 'ان', 'انه', 'هذا', 'هذه', 'ذلك', 'التي', 'الذي', 'كان', 'كانت', 'ما', 'لا', 'و', 'او', 'ثم', 'قد', 'كل', 'عند', 'عندكم', 'لكم', 'لكن', 'جدا', 'كثير', 'واضح', 'ماشاء', 'الله', 'شاء', 'لاحظت', 'شفت', 'قريت', 'تقييمات', 'عملايكم', 'عملاءكم', 'موقعكم', 'اكثر']);
/** Significant tokens: normalised, article-stripped, ≥3 letters, not a stopword. */
export function significant(s: string): Set<string> {
  const out = new Set<string>();
  for (const w of words(normalizeAr(s))) { let t = w.replace(/[^\p{L}\p{N}]/gu, ''); t = t.replace(/^(ال|وال|بال|لل|و|ب|ل)(?=.{3,})/, ''); t = t.replace(/(ات|ون|ين|ه|ها|هم|كم|نا)$/, (m) => (t.length > 4 ? '' : m)); if (t.length >= 3 && !STOP.has(t)) out.add(t); }
  return out;
}
export function jaccard<T>(a: Set<T>, b: Set<T>): number { if (!a.size && !b.size) return 1; let i = 0; for (const x of a) if (b.has(x)) i++; return i / (a.size + b.size - i); }
export function shingles(s: string, n = 3): Set<string> { const w = words(normalizeAr(s)).map((x) => x.replace(/[^\p{L}\p{N}]/gu, '')).filter(Boolean); const out = new Set<string>(); for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(' ')); return out; }
