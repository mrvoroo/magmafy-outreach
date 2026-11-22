import { Store, Lead } from '../db/store.js';
import { Settings } from '../config/settings.js';
import { classifyPlace } from '../sourcing/segments.js';

export interface Score { score: number; tier: 'A' | 'B' | 'C'; reasons: string[]; reject?: string }
/** Plan §6.3. Deterministic and explainable. `recentReviewMonths` is derived from evidence/places data. */
export function scoreLead(l: Lead, ev: { reviews: number; hasSiteEvidence: boolean; recentActivity: boolean; inCrmAsClientOrLost: boolean }): Score {
  const reasons: string[] = []; let s = 0;
  const seg = classifyPlace({ name: l.name, types: [] }, l.segment);
  if (!seg.ok && seg.reason.startsWith('excluded_word')) return { score: 0, tier: 'C', reasons: ['outside segments: ' + seg.reason], reject: seg.reason };
  if (l.business_status && l.business_status !== 'OPERATIONAL') return { score: 0, tier: 'C', reasons: ['not operational'], reject: 'closed' };
  if (l.chain_flag) return { score: 0, tier: 'C', reasons: ['big chain'], reject: 'too_big' };
  if (ev.inCrmAsClientOrLost) return { score: 0, tier: 'C', reasons: ['already client/lost in CRM'], reject: 'crm_known' };
  const add = (n: number, why: string) => { s += n; reasons.push(`${n > 0 ? '+' : ''}${n} ${why}`); };
  if (ev.recentActivity) add(25, 'recent activity (≤2 months)'); else add(-15, 'no recent activity');
  const rc = l.review_count ?? 0;
  if (rc >= 20 && rc <= 1500) add(20, `healthy review count (${rc})`); else if (rc >= 5) add(8, `few reviews (${rc})`); else add(-10, 'almost no reviews');
  if ((l.rating ?? 0) >= 4.0) add(8, 'rating ≥ 4'); else if (l.rating && l.rating < 3.5) add(-8, 'low rating');
  if (l.website || l.instagram) add(12, 'has website/Instagram'); else add(-5, 'no website/Instagram');
  if (l.phone_type === 'mobile') add(20, 'mobile number'); else if (l.phone_type === 'landline') add(l.alt_phones.length ? -5 : -30, 'landline' + (l.alt_phones.length ? ' (alt exists)' : ' only')); else if (!l.phone) add(-40, 'no phone');
  if (l.owner_name) add(10, 'owner name found');
  if (ev.hasSiteEvidence || ev.reviews > 0) add(Math.min(15, 5 + ev.reviews * 3), 'usable evidence for a personal line'); else add(-15, 'no usable evidence');
  const score = Math.max(0, Math.min(100, s + 30));
  const tier = score >= 65 ? 'A' : score >= 45 ? 'B' : 'C';
  return { score, tier, reasons };
}

export function qualifyLead(store: Store, leadId: string, opts: { crmKnown?: boolean } = {}): Score {
  const l = store.lead(leadId)!; const evs = store.evidence(leadId);
  const reviews = evs.filter((e) => e.type === 'review' || e.type === 'review_pattern').length;
  const siteEv = evs.some((e) => !e.internal_only);
  const recent = (() => { const m = store.kvGet<Record<string, boolean>>('recent_activity', {}) ?? {}; return m[leadId] ?? reviews > 0; })();
  const r = scoreLead(l, { reviews, hasSiteEvidence: siteEv, recentActivity: recent, inCrmAsClientOrLost: !!opts.crmKnown });
  store.updateLead(leadId, { score: r.score, tier: r.tier, score_breakdown: r.reasons }, 'qualifier');
  return r;
}
export function poolAllowed(l: Lead, s: Settings) { return !!l.tier && s.allowedTiers.includes(l.tier as any); }
