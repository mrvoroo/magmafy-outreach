import { normalizePhone } from '../domain/phone.js';

export interface SiteFacts {
  whatsapp: string[]; instagram: string | null; socials: string[]; emails: string[]; ownerName: string | null; title: string | null; description: string | null;
  categories: string[]; announcements: string[]; aboutUrl: string | null; contactUrl: string | null; phones: string[]; textSample: string;
}
const strip = (h: string) => h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>/gi, ' ').replace(/<\/?(p|div|li|ul|br|h[1-6]|tr|td|section|article|header|footer)[^>]*>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/[ \t\r\f\v]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n+/g, '\n').trim();
const abs = (href: string, base: string) => { try { return new URL(href, base).toString(); } catch { return null; } };

const CATS: [string, RegExp][] = [['كنب', /كنب|sofa/i], ['غرف نوم', /غرف نوم|bedroom/i], ['طاولات سفرة', /طاولات? (سفرة|طعام)|dining/i], ['مجالس', /مجالس|majlis/i], ['ستائر', /ستائر|curtain/i], ['سجاد', /سجاد|carpet|rug/i], ['إضاءة', /إضاءة|ثريات|lighting|chandelier/i], ['ديكور', /ديكور|decor/i], ['مفارش وبياضات', /مفارش|بياضات|bedding/i], ['مرايا', /مرايا|mirror/i]];
const OWNER_RE = [/(?:المؤسس|المالك|صاحب (?:المعرض|المحل|المؤسسة)|المدير العام|مدير المعرض)[ \t]*[:：\-–]?[ \t]*((?:م\.|أ\.|د\.|الأستاذ|الاستاذ|الشيخ)?[ \t]*[ء-ي]{2,}(?: [ء-ي]{2,}){0,2})/, /(?:Founder|Owner|CEO|Managing Director)[ \t]*[:：\-–]?[ \t]*([A-Z][a-z]+(?: [A-Z][a-z]+){0,2})/];
const NOT_NAMES = /^(المعرض|المحل|الشركة|المؤسسة|فريق|الإدارة|الاداره|العام)$/;

export function extractFacts(html: string, baseUrl: string): SiteFacts {
  const text = strip(html);
  const wa = new Set<string>(); const socials = new Set<string>(); const emails = new Set<string>(); const phones = new Set<string>();
  let instagram: string | null = null, aboutUrl: string | null = null, contactUrl: string | null = null;
  for (const m of html.matchAll(/href=["']([^"']+)["']/gi)) {
    const href = m[1]; const u = abs(href, baseUrl); if (!u) continue;
    let mm: RegExpMatchArray | null;
    if ((mm = u.match(/(?:wa\.me\/|api\.whatsapp\.com\/send\?phone=|web\.whatsapp\.com\/send\?phone=)\+?(\d{8,15})/i))) wa.add(mm[1]);
    else if ((mm = u.match(/^https?:\/\/(?:www\.)?instagram\.com\/([A-Za-z0-9._]{2,30})\/?(?:\?|$)/i)) && !/^(p|reel|explore|accounts|share)$/i.test(mm[1])) instagram ??= mm[1].toLowerCase();
    else if (/(facebook|snapchat|tiktok|twitter|x\.com|youtube)\./i.test(u)) socials.add(u);
    else if (href.startsWith('mailto:')) emails.add(href.slice(7).split('?')[0].toLowerCase());
    else if (href.startsWith('tel:')) { const p = normalizePhone(href.slice(4)); if (p) phones.add(p.digits); }
    else if (/about|من-نحن|من نحن|about-us|عنا/i.test(href) && !aboutUrl) aboutUrl = u;
    else if (/contact|اتصل|تواصل/i.test(href) && !contactUrl) contactUrl = u;
  }
  let ownerName: string | null = null;
  for (const re of OWNER_RE) { const m = text.match(re); if (m) { const n = m[1].trim(); if (n.length >= 3 && !NOT_NAMES.test(n)) { ownerName = n; break; } } }
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]; const desc = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)?.[1] ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i)?.[1];
  const categories = CATS.filter(([, re]) => re.test(text)).map(([n]) => n);
  const announcements: string[] = [];
  for (const m of text.matchAll(/(?:وصل حديثًا|وصل حديثا|مجموعة جديدة|وصلتنا|جديدنا|افتتاح فرع|فرع جديد|new collection|new arrivals?|now open|grand opening)[^.!؟\n]{0,120}/gi)) { announcements.push(m[0].trim()); if (announcements.length >= 3) break; }
  return { whatsapp: [...wa], instagram, socials: [...socials].slice(0, 6), emails: [...emails].slice(0, 3), ownerName, title: title ? strip(title).slice(0, 160) : null, description: desc ? strip(desc).slice(0, 300) : null, categories, announcements, aboutUrl, contactUrl, phones: [...phones], textSample: text.replace(/\n/g, ' ').slice(0, 1500) };
}

/** Minimal robots.txt: Disallow rules for User-agent '*' or our agent. */
export function robotsAllows(robotsTxt: string, path: string, agent = 'magmafy-outreach'): boolean {
  const lines = robotsTxt.split(/\r?\n/).map((l) => l.replace(/#.*$/, '').trim()).filter(Boolean);
  let applies = false; const dis: string[] = []; const allow: string[] = [];
  for (const l of lines) {
    const [k, ...r] = l.split(':'); const v = r.join(':').trim(); const key = k.toLowerCase();
    if (key === 'user-agent') applies = v === '*' || v.toLowerCase().includes(agent);
    else if (applies && key === 'disallow' && v) dis.push(v);
    else if (applies && key === 'allow' && v) allow.push(v);
  }
  const best = (rules: string[]) => rules.filter((r) => path.startsWith(r)).sort((a, b) => b.length - a.length)[0]?.length ?? -1;
  return best(allow) >= best(dis);
}
