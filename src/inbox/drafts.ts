import type { ReplyCategory } from './classify.js';
import { firstNameOf } from '../personalize/parts.js';

/** Suggested replies (Gulf white Arabic, short, aiming at ONE thing: a short call). Never auto-sent by default. */
export function draftReply(cat: ReplyCategory, o: { ownerName: string | null; me: string; company: string }): string | null {
  const n = firstNameOf(o.ownerName); const hi = n ? `هلا والله أستاذ ${n}` : 'هلا والله';
  switch (cat) {
    case 'who_is_this': return `${hi}، أنا ${o.me} من ${o.company}، نساعد معارض الأثاث والديكور في الإعلانات والطلبات. وصلت لرقمكم من معلومات النشاط المنشورة على خرائط قوقل. تحب أشرح لك الفكرة في دقيقة؟`;
    case 'price': return `${hi}، يعتمد على وضع معرضكم وأهدافكم، وما أقدر أعطيك رقم صحيح قبل ما نفهم وضعكم. تسمح نتكلم عشرين دقيقة وأطلع لك برقم واضح؟ يناسبك اليوم ولا بكرة؟`;
    case 'send_details': return `${hi}، باختصار:\nالمشكلة: كثير من المعارض تصرف على الإعلانات وما تعرف من وين تجي الطلبات.\nشغلنا: نرتب الإعلانات والموقع عشان توصل لعملاء أكثر ونقيس النتيجة.\nيناسبك مكالمة عشرين دقيقة اليوم ولا بكرة؟`;
    case 'has_agency': return `ما شاء الله، الله يوفقكم. وإذا احتجتم رأي ثاني أو فكرة جديدة في أي وقت أنا موجود.`;
    case 'later': return `تمام، الله يعطيك العافية. متى تحب أرجع أتواصل معك؟`;
    case 'not_interested': return `شكرًا لوقتك، بالتوفيق لكم.`;
    case 'voice_or_call': return `${hi}، آسف ما قدرت أسمع الرسالة الصوتية الحين. تكتب لي باختصار، أو أتصل عليك في وقت يناسبك؟`;
    case 'employee': return `هلا والله، ممكن توصلني بصاحب المعرض أو المسؤول عن التسويق؟ عندي فكرة مختصرة تهمهم.`;
    case 'opt_out': return `تم، ما راح نتواصل معكم مرة ثانية. نعتذر على الإزعاج.`;
    case 'positive': return `${hi}، ممتاز! يناسبك مكالمة قصيرة عشرين دقيقة اليوم ولا بكرة؟`;
    default: return null;
  }
}
