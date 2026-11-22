import { Store, Lead } from '../db/store.js';
import { WebPort } from './web.js';
import { extractFacts } from './html.js';
import { normalizePhone } from '../domain/phone.js';
import type { Place, PlaceReview } from '../sourcing/places.js';

const POSITIVE = /(ممتاز|رائع|جميل|أنصح|انصح|ما شاء الله|ماشاء الله|تنوع|جودة|أسعار مناسبة|تعامل راقي|تعامل محترم|سرعة|توصيل|great|excellent|beautiful|love|quality|recommend|friendly|fast delivery|variety|helpful)/i;
const NEG = /(سيئ|سيء|غالي|أسوأ|نصب|تأخير|تأخر|مشكلة|bad|worst|scam|late|poor|never|terrible|rude|overpriced)/i;

/** Only positive, specific, non-trivial review text is usable as personalization material. */
export function usableReview(r: PlaceReview): boolean { return r.rating >= 4 && r.text.length >= 25 && r.text.length <= 600 && POSITIVE.test(r.text) && !NEG.test(r.text); }

/** Records evidence from Google data (internal-only, expiring) and creates review-pattern evidence. */
export function evidenceFromPlace(store: Store, lead: Lead, p: Place, retentionDays: number) {
  const exp = new Date(store.clock.now().getTime() + retentionDays * 86400000).toISOString();
  let n = 0;
  for (const r of p.reviews.filter(usableReview).slice(0, 4)) { store.addEvidence({ lead_id: lead.id, type: 'review', snippet: r.text.replace(/\s+/g, ' ').trim(), source: 'google_places', source_url: null, internal_only: true, expires_at: exp }); n++; }
  const pos = p.reviews.filter((r) => r.rating >= 4);
  const themes: [string, RegExp][] = [['سرعة التوصيل', /توصيل|delivery/i], ['جودة الخامات والتصنيع', /جودة|خامة|خامات|تصنيع|quality|material/i], ['تنوع التشكيلة', /تنوع|تشكيلة|خيارات|variety|selection/i], ['تعامل الفريق', /تعامل|خدمة|فريق|service|staff|friendly/i]];
  for (const [theme, re] of themes) { const c = pos.filter((r) => re.test(r.text)).length; if (c >= 2) { store.addEvidence({ lead_id: lead.id, type: 'review_pattern', snippet: `عدة تقييمات إيجابية تذكر ${theme}`, source: 'google_places', source_url: null, internal_only: true, expires_at: exp }); n++; } }
  if (p.rating && p.reviewCount && p.rating >= 4.3 && p.reviewCount >= 30) { store.addEvidence({ lead_id: lead.id, type: 'rating', snippet: `تقييم ${p.rating} من ${p.reviewCount} تقييم على خرائط جوجل`, source: 'google_places', source_url: null, internal_only: true, expires_at: exp }); n++; }
  return n;
}

export class Enricher {
  constructor(private store: Store, private web: WebPort) {}
  /** Fetches the business's own site (home + about/contact), stores contact points and website evidence with sources. */
  async enrich(leadId: string): Promise<{ evidence: number; whatsapp: string | null }> {
    const lead = this.store.lead(leadId)!; let added = 0; const sources = { ...lead.sources }; const at = this.store.now();
    const patch: Partial<Lead> = {}; let waNumber: string | null = null;
    if (lead.website) {
      const home = await this.web.get(lead.website);
      if (home?.body) {
        let facts = extractFacts(home.body, home.finalUrl);
        const extra = [facts.aboutUrl, facts.contactUrl].filter((u): u is string => !!u && u !== home.finalUrl).slice(0, 2);
        for (const u of extra) { const pg = await this.web.get(u); if (pg?.body) { const f2 = extractFacts(pg.body, pg.finalUrl); facts = { ...facts, whatsapp: [...new Set([...facts.whatsapp, ...f2.whatsapp])], instagram: facts.instagram ?? f2.instagram, ownerName: facts.ownerName ?? f2.ownerName, phones: [...new Set([...facts.phones, ...f2.phones])], emails: facts.emails.length ? facts.emails : f2.emails, announcements: [...facts.announcements, ...f2.announcements].slice(0, 3), categories: [...new Set([...facts.categories, ...f2.categories])], description: facts.description ?? f2.description }; } }
        const country = (lead.country as any) ?? 'SA';
        const wa = facts.whatsapp.map((d) => normalizePhone(d, country)).filter(Boolean)[0];
        if (wa) { waNumber = wa.e164; sources.phone = { source: 'website_whatsapp_link:' + home.finalUrl, at }; }
        if (facts.instagram) { patch.instagram = facts.instagram; sources.instagram = { source: 'website_link:' + home.finalUrl, at }; }
        if (facts.ownerName) { patch.owner_name = facts.ownerName; sources.owner_name = { source: 'website_text:' + home.finalUrl, at }; }
        const alts = facts.phones.map((d) => normalizePhone(d, country)).filter((x): x is NonNullable<typeof x> => !!x).map((x) => x.e164);
        if (alts.length) patch.alt_phones = [...new Set([...(lead.alt_phones ?? []), ...alts])].filter((x) => x !== (waNumber ?? lead.phone));
        if (facts.announcements.length) for (const a of facts.announcements) { this.store.addEvidence({ lead_id: lead.id, type: 'recent_update', snippet: a, source: 'website', source_url: home.finalUrl, internal_only: false, expires_at: null }); added++; }
        if (facts.categories.length >= 2) { this.store.addEvidence({ lead_id: lead.id, type: 'website_text', snippet: `الموقع يعرض: ${facts.categories.slice(0, 4).join('، ')}`, source: 'website', source_url: home.finalUrl, internal_only: false, expires_at: null }); added++; }
        if (facts.description && facts.description.length > 30) { this.store.addEvidence({ lead_id: lead.id, type: 'website_text', snippet: facts.description, source: 'website_meta', source_url: home.finalUrl, internal_only: false, expires_at: null }); added++; }
      }
    }
    // Prefer the number from the business's own WhatsApp link over the Google listing number.
    if (waNumber && waNumber !== lead.phone) {
      const clash = this.store.leadByPhone(waNumber);
      if (!clash || clash.id === lead.id) { patch.alt_phones = [...new Set([...(patch.alt_phones ?? lead.alt_phones), ...(lead.phone ? [lead.phone] : [])])]; patch.phone = waNumber; const p = normalizePhone(waNumber); if (p) patch.phone_type = p.type; }
    }
    patch.sources = sources;
    this.store.updateLead(lead.id, patch, 'enricher');
    return { evidence: added, whatsapp: waNumber };
  }
}
