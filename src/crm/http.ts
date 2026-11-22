import { CrmPort, AdminAuthPort, CrmViewSchema, CrmRefusal, ChangesResult } from './contract.js';
import { RetryableError, withTimeout } from '../util/errors.js';

type Fetch = typeof fetch;
/** Talks to the Apps Script web app. Text/plain body avoids a CORS pre-flight; the key travels only in the body. Never logs it. */
export class HttpCrm implements CrmPort, AdminAuthPort {
  constructor(private url: string, private key: string, private f: Fetch = fetch, private timeoutMs = 60_000) {
    if (!url || !key) throw new Error('CRM_URL and CRM_OUTREACH_KEY are required');
  }
  private async call(fn: string, args: unknown[]): Promise<any> {
    let res: Response;
    try {
      res = await withTimeout(this.f(this.url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action: 'outreach', fn, args, key: this.key }), redirect: 'follow' }), this.timeoutMs, 'crm ' + fn);
    } catch (e) { throw new RetryableError('crm unreachable: ' + (e as Error).message); }
    if (res.status >= 500) throw new RetryableError('crm http ' + res.status);
    let body: any;
    try { body = await res.json(); } catch { throw new RetryableError('crm returned non-JSON'); }
    if (body?.ok) return body.data;
    if (body?.code === 'APP_ERROR') throw new CrmRefusal(String(body.error));
    if (body?.code === 'SERVER') throw new RetryableError('crm server error');
    throw new CrmRefusal('door_closed'); // UNKNOWN_FUNCTION = wrong key, switched off, locked out, or deployment not done
  }
  async adminRequestCode(email: string) { await this.call('outreachAdminRequestCode', [email]); }
  async adminLogin(email: string, code: string) { const d = await this.call('outreachAdminLogin', [email, code]); return { email: String(d.email), name: String(d.name) }; }
  async adminCheck(email: string) { return !!(await this.call('outreachAdminCheck', [email]))?.admin; }
  async health() { return this.call('outreachHealth', []); }
  async upsertLead(a: any) { return CrmViewSchema.parse(await this.call('outreachUpsertLead', [a])); }
  async logOutbound(a: any) { return CrmViewSchema.parse(await this.call('outreachLogOutbound', [a])); }
  async logInbound(a: any) { return CrmViewSchema.parse(await this.call('outreachLogInbound', [a])); }
  async setOutcome(a: any) { return CrmViewSchema.parse(await this.call('outreachSetOutcome', [a])); }
  async control(a: any) { const d = await this.call('outreachControl', [a]); return d?.found === false ? { found: false as const } : CrmViewSchema.parse(d); }
  async changes(cursor: string, knownIds: string[]): Promise<ChangesResult> {
    const d = await this.call('outreachChanges', [cursor, knownIds]);
    return { items: (d.items ?? []).map((x: unknown) => CrmViewSchema.parse(x)), missing: d.missing ?? [], next: d.next ?? cursor };
  }
}
