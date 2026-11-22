import { RetryableError, FatalError, withTimeout, withRetry } from '../util/errors.js';
import { Store } from '../db/store.js';

export interface PlaceReview { text: string; rating: number; publishTime: string; lang?: string }
export interface Place {
  id: string; name: string; address?: string; phone?: string | null; website?: string | null; rating?: number | null; reviewCount?: number | null;
  businessStatus?: string; types: string[]; reviews: PlaceReview[]; openNow?: boolean; lat?: number; lng?: number
}
export interface SearchArgs { query: string; lang: 'ar' | 'en'; region: string; pageToken?: string }
export interface PlacesPort { searchText(a: SearchArgs): Promise<{ places: Place[]; nextPageToken?: string }> }

/** Fields requested (field mask = cost control). */
export const FIELD_MASK = 'places.id,places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.internationalPhoneNumber,places.websiteUri,places.rating,places.userRatingCount,places.businessStatus,places.location,places.regularOpeningHours,places.types,places.reviews,nextPageToken';

export class BudgetExceeded extends FatalError {}
/** Daily and monthly spend caps checked BEFORE every paid call (plan §6.1). Prices are config: verify against Google's current table. */
export class BudgetGuard {
  constructor(private store: Store, private provider: 'google' | 'ai', private cap: () => { daily: number; monthly: number }, private alert: (m: string) => void = () => {}) {}
  check(estimateUsd: number) {
    const now = this.store.clock.now(); const c = this.cap();
    const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
    const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
    const d = this.store.spendSince(this.provider, day), m = this.store.spendSince(this.provider, month);
    if (d + estimateUsd > c.daily || m + estimateUsd > c.monthly) { this.alert(`${this.provider} budget cap reached (day ${d.toFixed(2)}/${c.daily}, month ${m.toFixed(2)}/${c.monthly})`); throw new BudgetExceeded(`${this.provider} budget cap reached`); }
  }
  record(usd: number, note: string) { this.store.addSpend(this.provider, usd, note); }
}

export class GooglePlaces implements PlacesPort {
  constructor(private apiKey: string, private guard: BudgetGuard, private costPerSearchUsd = 0.04, private f: typeof fetch = fetch) { if (!apiKey) throw new Error('GOOGLE_PLACES_API_KEY required'); }
  async searchText(a: SearchArgs) {
    this.guard.check(this.costPerSearchUsd);
    const body: Record<string, unknown> = { textQuery: a.query, languageCode: a.lang, regionCode: a.region, pageSize: 20 };
    if (a.pageToken) body.pageToken = a.pageToken;
    const data = await withRetry(async () => {
      let res: Response;
      try { res = await withTimeout(this.f('https://places.googleapis.com/v1/places:searchText', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': this.apiKey, 'X-Goog-FieldMask': FIELD_MASK }, body: JSON.stringify(body) }), 20_000, 'places'); }
      catch (e) { throw new RetryableError((e as Error).message); }
      if (res.status === 429 || res.status >= 500) throw new RetryableError('places http ' + res.status);
      if (!res.ok) throw new FatalError('places http ' + res.status);
      return res.json() as Promise<any>;
    });
    this.guard.record(this.costPerSearchUsd, 'searchText ' + a.query);
    const places: Place[] = (data.places ?? []).map((p: any): Place => ({
      id: p.id, name: p.displayName?.text ?? '', address: p.formattedAddress, phone: p.internationalPhoneNumber ?? p.nationalPhoneNumber ?? null, website: p.websiteUri ?? null,
      rating: p.rating ?? null, reviewCount: p.userRatingCount ?? null, businessStatus: p.businessStatus, types: p.types ?? [], lat: p.location?.latitude, lng: p.location?.longitude,
      reviews: (p.reviews ?? []).map((r: any) => ({ text: r.text?.text ?? r.originalText?.text ?? '', rating: r.rating ?? 0, publishTime: r.publishTime ?? '', lang: r.text?.languageCode })).filter((r: PlaceReview) => r.text)
    }));
    return { places, nextPageToken: data.nextPageToken as string | undefined };
  }
}

/** Deterministic fake: serves a fixed catalogue filtered by a substring of the query. */
export class FakePlaces implements PlacesPort {
  calls = 0;
  constructor(public catalogue: (Place & { _q?: string })[]) {}
  async searchText(a: SearchArgs) {
    this.calls++;
    const start = a.pageToken ? Number(a.pageToken) : 0;
    const hits = this.catalogue.filter((p) => !p._q || a.query.includes(p._q));
    const page = hits.slice(start, start + 20);
    return { places: page, nextPageToken: start + 20 < hits.length ? String(start + 20) : undefined };
  }
}
