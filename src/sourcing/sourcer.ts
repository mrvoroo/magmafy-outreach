import { Store, Segment, Lead } from '../db/store.js';
import { PlacesPort, Place, BudgetExceeded } from './places.js';
import { QUERIES, classifyPlace, isTooBig, normBrand } from './segments.js';
import { Enricher, evidenceFromPlace } from '../enrich/enricher.js';
import { qualifyLead } from '../qualify/qualifier.js';
import { normalizePhone } from '../domain/phone.js';
import { Logger, nullLogger } from '../util/log.js';

export interface RunResult { seen: number; created: number; qualifiedAB: number; rejected: number; tooBig: number; duplicates: number; stoppedBy?: 'budget' | 'target' | 'exhausted' }

/** Sourcer + enrich + qualify for one city (all configured segments) until `target` A/B leads exist (plan §6.1). */
export class Sourcer {
  constructor(private store: Store, private places: PlacesPort, private enricher: Enricher, private log: Logger = nullLogger) {}

  async run(opts: { city: string; cityAr: string; country: 'SA' | 'AE' | 'BH' | 'QA'; segments?: Segment[]; target: number; maxPagesPerQuery?: number }): Promise<RunResult> {
    const s = this.store.settings(); const segs = opts.segments ?? s.segments;
    const res: RunResult = { seen: 0, created: 0, qualifiedAB: 0, rejected: 0, tooBig: 0, duplicates: 0 };
    const collected: { p: Place; searched: Segment }[] = []; const seenIds = new Set<string>();
    try {
      for (const seg of segs) {
        for (const lang of ['ar', 'en'] as const) for (const q of QUERIES[seg][lang]) {
          let token: string | undefined;
          for (let page = 0; page < (opts.maxPagesPerQuery ?? 3); page++) {
            const r = await this.places.searchText({ query: `${q} ${lang === 'ar' ? opts.cityAr : opts.city}`, lang, region: opts.country.toLowerCase(), pageToken: token });
            for (const p of r.places) if (!seenIds.has(p.id)) { seenIds.add(p.id); collected.push({ p, searched: seg }); }
            token = r.nextPageToken; if (!token) break;
          }
        }
      }
    } catch (e) { if (e instanceof BudgetExceeded) res.stoppedBy = 'budget'; else throw e; }
    const brandCount = new Map<string, number>(); for (const { p } of collected) { const b = normBrand(p.name); brandCount.set(b, (brandCount.get(b) ?? 0) + 1); }
    for (const { p, searched } of collected) {
      res.seen++;
      if (this.store.leadByPlace(p.id)) { res.duplicates++; continue; }
      const cls = classifyPlace(p, searched);
      const ph = p.phone ? normalizePhone(p.phone, opts.country) : null;
      const base = { name: p.name, segment: (cls.ok ? cls.segment : searched) as Segment, place_id: p.id, city: opts.city, country: opts.country, address: p.address ?? null, website: p.website ?? null, rating: p.rating ?? null, review_count: p.reviewCount ?? null, business_status: p.businessStatus ?? null, places_fetched_at: this.store.now() };
      if (!cls.ok) { const l = this.store.createLead({ ...base, sources: { place: { source: 'google_places', at: this.store.now() } } }); this.store.transition(l.id, 'rejected', 'sourcer', cls.reason); res.rejected++; continue; }
      if (p.businessStatus && p.businessStatus !== 'OPERATIONAL') { const l = this.store.createLead(base); this.store.transition(l.id, 'rejected', 'sourcer', 'closed'); res.rejected++; continue; }
      if (ph && this.store.leadByAnyPhone(ph.e164)) { res.duplicates++; continue; }
      const big = isTooBig({ name: p.name, reviewCount: p.reviewCount }, brandCount.get(normBrand(p.name)) ?? 1);
      const src = { place: { source: 'google_places', at: this.store.now() }, ...(ph ? { phone: { source: 'google_places', at: this.store.now() } } : {}) };
      const lead = this.store.createLead({ ...base, phone: ph?.e164 ?? null, phone_type: ph?.type ?? 'unknown', chain_flag: big, sources: src });
      res.created++;
      if (big) { this.store.transition(lead.id, 'too_big', 'sourcer', 'chain/large brand'); res.tooBig++; continue; }
      evidenceFromPlace(this.store, lead, p, s.googleRetentionDays);
      try { await this.enricher.enrich(lead.id); } catch (e) { this.log.warn('enrich failed', { lead: lead.id, err: (e as Error).message }); }
      this.store.transition(lead.id, 'enriched', 'enricher');
      const q = qualifyLead(this.store, lead.id);
      if (q.reject) { this.store.transition(lead.id, 'rejected', 'qualifier', q.reject); res.rejected++; continue; }
      this.store.transition(lead.id, 'qualified', 'qualifier', `tier ${q.tier}`);
      if (q.tier !== 'C') res.qualifiedAB++;
      if (res.qualifiedAB >= opts.target) { res.stoppedBy = 'target'; break; }
    }
    res.stoppedBy ??= 'exhausted';
    return res;
  }
  /** Leads whose Google-derived data is older than the retention: must be re-fetched before use. */
  staleLeads(): Lead[] { const days = this.store.settings().googleRetentionDays; const cut = new Date(this.store.clock.now().getTime() - days * 86400000).toISOString(); return this.store.allLeads().filter((l) => l.places_fetched_at && l.places_fetched_at < cut && !['rejected', 'too_big'].includes(l.status)); }
}
