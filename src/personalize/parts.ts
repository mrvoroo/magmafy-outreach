import type { Segment } from '../db/store.js';

/**
 * Approved copy (Gulf "white" dialect). The AI writes ONLY the personal line; everything else is chosen from these banks,
 * so no unapproved claim can enter a message. Parts are numbered so the anti-pattern detector can compare signatures.
 */
export const GREET_NAMED = ['السلام عليكم أستاذ {name}، معك {me} من {co}.', 'هلا والله أستاذ {name}، أنا {me} من {co}.', 'أهلين أستاذ {name}، معك {me} من {co}.', 'مساء الخير أستاذ {name}، أنا {me} من {co}.'];
export const GREET_PLAIN = ['السلام عليكم، معك {me} من {co}.', 'هلا والله، أنا {me} من {co}.', 'أهلين، معك {me} من {co}.', 'مساء الخير، أنا {me} من {co}.'];

const FOR: Record<Segment, string> = { furniture: 'معارض الأثاث', decor: 'محلات الديكور', furnishing: 'محلات المفروشات' };
export const OFFERS: ((seg: Segment) => string)[] = [
  (s) => `نساعد ${FOR[s]} توصلها طلبات أكثر من إعلانات السوشال وقوقل.`,
  (s) => `شغلنا نساعد ${FOR[s]} تجذب عملاء أكثر لمعرضها عبر الإعلانات.`,
  (s) => `نبدأ حاليًا مع عدد قليل من ${FOR[s]} لنزيد استفساراتها من الإعلانات.`,
  (s) => `نعمل على زيادة طلبات ${FOR[s]} من إنستغرام وقوقل.`
];
export const QUESTIONS: Record<'A' | 'B' | 'C', string[]> = {
  A: ['تحب أرسل لك الفكرة في دقيقة؟', 'تسمح لي أرسل لك فكرة سريعة؟', 'أرسل لك الفكرة باختصار؟'],
  B: ['من وين تجيكم أغلب الطلبات الحين؟', 'وين تجيكم أغلب الاستفسارات حاليًا، إنستغرام ولا سناب ولا قوقل؟', 'أغلب طلباتكم تجيكم من وين الحين؟'],
  C: ['متى يناسبك مكالمة قصيرة عشرين دقيقة؟']
};
export const FOLLOW1 = ['{greet} رجعت أذكرك برسالتي السابقة، وإذا الوقت مو مناسب قل لي وما أزعجك.', '{greet} بس حبيت أتأكد وصلتك رسالتي السابقة؟'];
export const FOLLOW3 = ['{greet} هذي آخر رسالة مني عشان ما أزعجك، وإذا احتجتم أي شيء في الإعلانات أنا موجود. بالتوفيق لكم.', '{greet} ما أبي أطول عليك، وأي وقت تحبون نتكلم فيه أنا حاضر. بالتوفيق لكم ومبروك على نشاطكم.'];
export const FOLLOW2_CLOSE = ['تحب أرسل لك الفكرة باختصار؟', 'يناسبك أرسل لك فكرة سريعة؟'];
export const FOLLOW_GREET_NAMED = 'أهلين أستاذ {name}،';
export const FOLLOW_GREET_PLAIN = 'أهلين،';

export function firstNameOf(owner: string | null): string | null {
  if (!owner) return null; const t = owner.replace(/^(م\.|أ\.|د\.|الأستاذ|الاستاذ|الشيخ)\s*/, '').trim().split(/\s+/);
  if (!t[0] || t[0].length < 2) return null;
  if (/^(أبو|ابو|عبد|عبدال)/.test(t[0]) && t[1]) return `${t[0]} ${t[1]}`; // «أبو فهد» / «عبد الله» keep their second word
  return t[0];
}
export const fill = (tpl: string, v: Record<string, string>) => tpl.replace(/\{(\w+)\}/g, (_, k) => v[k] ?? '');
