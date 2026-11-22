import { robotsAllows } from './html.js';
import { withTimeout, RetryableError } from '../util/errors.js';

export interface WebPort { get(url: string): Promise<{ status: number; body: string; finalUrl: string } | null> }
export const BOT_UA = 'magmafy-outreach/1.0 (+business-info lookup; contact: see website magmafyogp.com)';

/** Polite fetcher: robots.txt first, per-host rate limit, size cap, honest user-agent. Returns null when disallowed. */
export class PoliteWeb implements WebPort {
  private last = new Map<string, number>(); private robots = new Map<string, string>();
  constructor(private f: typeof fetch = fetch, private gapMs = 3000, private sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)), private now = () => Date.now()) {}
  async get(url: string) {
    let u: URL; try { u = new URL(url); } catch { return null; }
    if (!/^https?:$/.test(u.protocol)) return null;
    if (!this.robots.has(u.host)) { try { const r = await this.raw(`${u.protocol}//${u.host}/robots.txt`); this.robots.set(u.host, r.status === 200 ? r.body : ''); } catch { this.robots.set(u.host, ''); } }
    if (!robotsAllows(this.robots.get(u.host)!, u.pathname + u.search)) return null;
    const prev = this.last.get(u.host); const wait = prev === undefined ? 0 : prev + this.gapMs - this.now(); if (wait > 0) await this.sleep(wait);
    const r = await this.raw(url); this.last.set(u.host, this.now()); return r;
  }
  private async raw(url: string) {
    let res: Response;
    try { res = await withTimeout(this.f(url, { headers: { 'User-Agent': BOT_UA, Accept: 'text/html,*/*;q=0.5' }, redirect: 'follow' }), 15_000, 'web'); } catch (e) { throw new RetryableError((e as Error).message); }
    const ct = res.headers.get('content-type') ?? '';
    const body = /text\/(html|plain)|xml/.test(ct) || !ct ? (await res.text()).slice(0, 400_000) : '';
    return { status: res.status, body, finalUrl: res.url || url };
  }
}
export class FakeWeb implements WebPort { constructor(public pages: Record<string, string>) {} calls: string[] = []; async get(url: string) { this.calls.push(url); const b = this.pages[url]; return b === undefined ? null : { status: 200, body: b, finalUrl: url }; } }
