import { CrmPort, CrmView, CrmControl, UpsertArgs, OutboundArgs, InboundArgs, OutcomeArgs, ChangesResult, CrmRefusal } from './contract.js';
import { RetryableError } from '../util/errors.js';

interface FLead { id: string; placeId: string; phone: string; business: string; stage: string; owner: string; dnc: boolean; attempts: number; ours: boolean; client: boolean; updated: number; personalLine?: string; variant?: string; log: { dir: 'out' | 'in'; ref: string; text: string; kind?: string }[] }
/** In-memory CRM that mirrors the real door's rules (Outreach.gs): idempotent refs, attempts cap 4, stage mapping, ownership. */
export class FakeCrm implements CrmPort {
  leads = new Map<string, FLead>();
  down = false; calls: string[] = []; private seq = 0; private t = 1;
  private view(l: FLead): CrmView { return { found: true, leadId: l.id, stage: l.stage, owner: l.owner, dnc: l.dnc, isClient: l.client, attempts: l.attempts, ours: l.ours, updated: String(l.updated) } as CrmView; }
  private guard(fn: string) { this.calls.push(fn); if (this.down) throw new RetryableError('fake crm down'); }
  private find(a: { leadId?: string; placeId?: string; phone?: string }, ownOnlyById = true) {
    const all = [...this.leads.values()];
    return (a.leadId ? all.find((l) => l.id === a.leadId && (!ownOnlyById || l.ours)) : undefined) ?? (a.placeId ? all.find((l) => l.placeId === a.placeId) : undefined) ?? (a.phone ? all.find((l) => l.phone === a.phone) : undefined);
  }
  /** Test helpers simulating humans working in the CRM. */
  humanSetStage(id: string, stage: string) { const l = this.leads.get(id)!; l.stage = stage; l.updated = this.t++; }
  humanSetDnc(id: string) { const l = this.leads.get(id)!; l.dnc = true; l.updated = this.t++; }
  humanDelete(id: string) { this.leads.delete(id); }
  addForeignClient(phone: string) { const id = 'L-F' + ++this.seq; this.leads.set(id, { id, placeId: '', phone, business: 'client', stage: 'عميل نشط', owner: 'x', dnc: false, attempts: 0, ours: false, client: true, updated: this.t++, log: [] }); return id; }

  async health() { this.guard('health'); return { ok: true, version: 1 }; }
  async upsertLead(a: UpsertArgs) {
    this.guard('upsert');
    const f = this.find({ placeId: a.placeId, phone: a.phone ?? undefined });
    if (f) { if (f.ours) { f.personalLine = a.personalLine ?? f.personalLine; f.variant = a.variant ?? f.variant; } return { ...this.view(f), created: false, blocked: !f.ours }; }
    const id = 'L-' + String(++this.seq).padStart(4, '0');
    const l: FLead = { id, placeId: a.placeId, phone: a.phone ?? '', business: a.business, stage: 'جديد', owner: 'Ahmed', dnc: false, attempts: 0, ours: true, client: false, updated: this.t++, personalLine: a.personalLine, variant: a.variant, log: [] };
    this.leads.set(id, l); return { ...this.view(l), created: true, blocked: false };
  }
  private own(id: string) { const l = this.find({ leadId: id }); if (!l) throw new CrmRefusal('lead_not_found'); return l; }
  async logOutbound(a: OutboundArgs) {
    this.guard('outbound'); const l = this.own(a.leadId);
    if (l.log.some((x) => x.ref === a.ref)) return { ...this.view(l), duplicate: true };
    if (l.dnc) throw new CrmRefusal('do_not_contact');
    if (l.stage === 'جديد' || l.stage === 'تم التواصل') { l.attempts = Math.min(4, l.attempts + 1); l.stage = 'تم التواصل'; }
    l.log.push({ dir: 'out', ref: a.ref, text: a.text, kind: a.kind }); l.updated = this.t++; return { ...this.view(l), duplicate: false };
  }
  async logInbound(a: InboundArgs) {
    this.guard('inbound'); const l = this.own(a.leadId);
    if (l.log.some((x) => x.ref === a.ref)) return { ...this.view(l), duplicate: true };
    if (l.stage === 'جديد' || l.stage === 'تم التواصل') l.stage = 'متفاعل';
    l.log.push({ dir: 'in', ref: a.ref, text: a.text }); l.updated = this.t++; return { ...this.view(l), duplicate: false };
  }
  async setOutcome(a: OutcomeArgs) {
    this.guard('outcome'); const l = this.own(a.leadId);
    const mine = ['جديد', 'تم التواصل', 'متفاعل'].includes(l.stage);
    if (!mine && !['خسرناه', 'غير مؤهل', 'مؤجل'].includes(l.stage)) return { ...this.view(l), applied: false, reason: 'crm_owns_deal' };
    const map: Record<string, string> = { declined: 'خسرناه', no_reply: 'خسرناه', opted_out: 'غير مؤهل', wrong_contact: 'غير مؤهل', employee_only: 'غير مؤهل', later: 'مؤجل', has_agency: 'مؤجل' };
    l.stage = map[a.outcome]; if (a.outcome === 'opted_out') l.dnc = true; l.updated = this.t++; return { ...this.view(l), applied: true };
  }
  async control(a: { leadId?: string; placeId?: string; phone?: string }): Promise<CrmControl> {
    this.guard('control'); const l = this.find(a); if (!l) return { found: false };
    const stop = l.dnc || l.client || !['جديد', 'تم التواصل'].includes(l.stage);
    return { ...this.view(l), mustStop: stop };
  }
  async changes(cursor: string, known: string[]): Promise<ChangesResult> {
    this.guard('changes'); const since = Number(cursor || 0);
    const items = [...this.leads.values()].filter((l) => l.ours && l.updated > since).sort((x, y) => x.updated - y.updated).map((l) => ({ ...this.view(l), placeId: l.placeId, meetingBooked: l.stage === 'اجتماع محجوز' }));
    const have = new Set([...this.leads.values()].filter((l) => l.ours).map((l) => l.id));
    return { items, missing: known.filter((i) => !have.has(i)), next: items.length ? items[items.length - 1].updated! : cursor };
  }
}
