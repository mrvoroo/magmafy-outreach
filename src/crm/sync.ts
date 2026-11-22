import { randomUUID } from 'node:crypto';
import { Store, Lead } from '../db/store.js';
import { CrmPort, CrmRefusal, Outcome, UpsertArgs, OutboundArgs, InboundArgs, OutcomeArgs } from './contract.js';
import { Logger, nullLogger } from '../util/log.js';
import { Status } from '../domain/status.js';
import { addDays, dayKey } from '../util/time.js';

export type OutboxOp = { op: 'upsert'; args: UpsertArgs } | { op: 'outbound'; args: Omit<OutboundArgs, 'leadId'> } | { op: 'inbound'; args: Omit<InboundArgs, 'leadId'> } | { op: 'outcome'; args: Omit<OutcomeArgs, 'leadId'> };
const BACKOFF_SEC = [30, 120, 600, 1800, 3600];
const MAX_ATTEMPTS = 8;

/**
 * Mirrors everything into the Magmafy CRM through a durable outbox: state change + outbox row are written in the same
 * DB transaction by the caller (enqueue), the CRM call happens later (flush) with backoff, per-lead FIFO, idempotent refs.
 */
export class CrmSync {
  constructor(private store: Store, private crm: CrmPort, private log: Logger = nullLogger, private alert: (m: string) => void = () => {}, private opts: { paceMs?: number; sleep?: (ms: number) => Promise<void> } = {}) {}

  enqueue(leadId: string, op: OutboxOp, id?: string): string {
    const rid = id ?? 'ob_' + randomUUID().slice(0, 12);
    const seq = Number(this.store.db.get('SELECT COALESCE(MAX(seq),0)+1 s FROM crm_outbox')!.s);
    this.store.db.run('INSERT OR IGNORE INTO crm_outbox(id,op,lead_id,payload,state,attempts,created_at,seq) VALUES (?,?,?,?,?,?,?,?)', rid, op.op, leadId, JSON.stringify(op.args), 'pending', 0, this.store.now(), seq);
    return rid;
  }
  pending(): number { return Number(this.store.db.get("SELECT COUNT(*) c FROM crm_outbox WHERE state='pending'")!.c); }
  dead(): any[] { return this.store.db.all("SELECT * FROM crm_outbox WHERE state='dead'"); }

  /** Sends due rows. A failing row blocks later rows of the same lead only. Returns counts. */
  async flush(limit = 100): Promise<{ done: number; failed: number; dead: number }> {
    const now = this.store.now();
    const rows = this.store.db.all("SELECT * FROM crm_outbox WHERE state='pending' AND (next_try_at IS NULL OR next_try_at<=?) ORDER BY seq LIMIT ?", now, limit);
    const blocked = new Set<string>(); let done = 0, failed = 0, dead = 0;
    for (const r of rows) {
      if (blocked.has(r.lead_id)) continue;
      try {
        await this.run(r);
        this.store.db.run("UPDATE crm_outbox SET state='done', done_at=?, last_error=NULL WHERE id=?", this.store.now(), r.id); done++;
        if (this.opts.paceMs) await (this.opts.sleep ?? ((ms) => new Promise((x) => setTimeout(x, ms))))(this.opts.paceMs);
      } catch (e) {
        const attempts = r.attempts + 1; const msg = (e as Error).message;
        const fatal = e instanceof CrmRefusal;
        if (fatal || attempts >= MAX_ATTEMPTS) {
          this.store.db.run("UPDATE crm_outbox SET state='dead', attempts=?, last_error=? WHERE id=?", attempts, msg, r.id); dead++;
          this.store.event('crm_sync_dead', 'crm-sync', r.lead_id, { op: r.op, error: msg });
          this.alert(`CRM sync failed permanently for ${r.lead_id}: ${r.op} — ${msg}`);
          if (fatal && msg.includes('do_not_contact')) this.store.updateLead(r.lead_id, { dnc: true, dnc_reason: 'crm_dnc' }, 'crm-sync');
        } else {
          const wait = BACKOFF_SEC[Math.min(attempts - 1, BACKOFF_SEC.length - 1)] * 1000;
          this.store.db.run("UPDATE crm_outbox SET attempts=?, last_error=?, next_try_at=? WHERE id=?", attempts, msg, new Date(this.store.clock.now().getTime() + wait).toISOString(), r.id); failed++;
        }
        blocked.add(r.lead_id);
      }
    }
    return { done, failed, dead };
  }

  private async run(r: any) {
    const a = JSON.parse(r.payload);
    const lead = this.store.lead(r.lead_id);
    if (r.op === 'upsert') {
      const v = await this.crm.upsertLead(a);
      this.store.updateLead(r.lead_id, { crm_id: v.leadId } as Partial<Lead>, 'crm-sync');
      if (v.blocked) { // an existing client / hand-made lead owns this number: never message it
        this.store.updateLead(r.lead_id, { dnc: true, dnc_reason: 'exists_in_crm_not_ours' }, 'crm-sync');
        this.store.event('crm_blocked', 'crm-sync', r.lead_id, { stage: v.stage });
      }
      return;
    }
    if (!lead?.crm_id) throw new Error('lead not yet in CRM (upsert pending)'); // retryable: the upsert row is earlier in the same lead's queue
    const withId = { ...a, leadId: lead.crm_id, ref: a.ref ?? r.id };
    if (r.op === 'outbound') await this.crm.logOutbound({ ...withId, ref: a.ref ?? r.id });
    else if (r.op === 'inbound') await this.crm.logInbound(withId);
    else if (r.op === 'outcome') await this.crm.setOutcome({ ...withId, ref: a.ref ?? r.id });
  }

  /** Called before EVERY send. Fails closed: if the CRM cannot be asked, we do not send. */
  async preSendCheck(lead: Lead): Promise<{ ok: boolean; reason?: string }> {
    if (lead.dnc || this.store.isDnc(lead.phone)) return { ok: false, reason: 'local_dnc' };
    if (!lead.crm_id) return { ok: false, reason: 'not_in_crm_yet' };
    try {
      const c = await this.crm.control({ leadId: lead.crm_id });
      if (!c.found) { this.store.event('crm_lead_missing', 'crm-sync', lead.id, {}); return { ok: false, reason: 'missing_in_crm' }; }
      if (c.mustStop) return { ok: false, reason: c.dnc ? 'crm_dnc' : c.isClient ? 'crm_client' : 'crm_stage_' + c.stage };
      return { ok: true };
    } catch (e) { return { ok: false, reason: 'crm_unreachable' }; }
  }

  /** Pulls human changes made in the CRM and stops sequences accordingly. */
  async pullChanges(): Promise<number> {
    const known = this.store.allLeads().filter((l) => l.crm_id).map((l) => l.crm_id!);
    const cursor = this.store.kvGet<string>('crm_cursor', '') ?? '';
    const res = await this.crm.changes(cursor, known);
    let n = 0;
    for (const it of res.items) {
      const lead = this.store.allLeads().find((l) => l.crm_id === it.leadId); if (!lead) continue;
      const stopTo = this.mapStop(lead, it.stage, it.dnc);
      if (stopTo) { this.stop(lead, stopTo, `crm change: ${it.stage}${it.dnc ? ' dnc' : ''}`); n++; }
    }
    for (const id of res.missing) {
      const lead = this.store.allLeads().find((l) => l.crm_id === id); if (!lead) continue;
      this.stop(lead, 'wrong_contact', 'deleted in CRM'); this.store.updateLead(lead.id, { dnc: true, dnc_reason: 'deleted_in_crm' }, 'crm-sync'); n++;
    }
    if (res.next) this.store.kvSet('crm_cursor', res.next);
    return n;
  }
  private mapStop(lead: Lead, stage: string, dnc: boolean): Status | null {
    if (['declined', 'opted_out', 'wrong_contact', 'no_reply_closed', 'call_booked'].includes(lead.status)) return null;
    if (dnc) return 'opted_out';
    if (stage === 'اجتماع محجوز' || ['تم الاجتماع', 'عرض مرسل', 'تفاوض', 'عقد وتحصيل', 'فترة تجريبية', 'عميل نشط'].includes(stage)) return 'call_booked';
    if (stage === 'خسرناه') return 'declined';
    if (stage === 'غير مؤهل') return 'wrong_contact';
    if (stage === 'مؤجل' && !['later', 'has_agency'].includes(lead.status)) return 'later';
    if (stage === 'متفاعل' && !['replied', 'later', 'has_agency'].includes(lead.status)) return 'replied';
    return null;
  }
  private stop(lead: Lead, to: Status, note: string) {
    // walk through "replied" when the state machine requires it
    let cur = this.store.lead(lead.id)!;
    try { this.store.transition(cur.id, to, 'crm', note); }
    catch { try { if (['scheduled', 'message_ready', 'qualified'].includes(cur.status)) this.store.transition(cur.id, to === 'call_booked' ? 'parked' : 'parked', 'crm', note); else { this.store.transition(cur.id, 'replied', 'crm', note); this.store.transition(cur.id, to, 'crm', note); } } catch { this.store.event('crm_stop_failed', 'crm', cur.id, { to }); } }
    if (to === 'opted_out' && lead.phone) this.store.addDnc(lead.phone, 'crm', note);
    // cancel anything still planned
    this.store.db.run("UPDATE messages SET state='skipped', failure_reason=? WHERE lead_id=? AND direction='out' AND state IN ('ready','scheduled','draft')", 'stopped:' + to, lead.id);
  }
  /** Nightly reconciliation: counts on both sides. */
  async reconcile(): Promise<{ localLeads: number; crmKnown: number; pending: number; dead: number }> {
    const known = this.store.allLeads().filter((l) => l.crm_id).map((l) => l.crm_id!);
    const r = await this.crm.changes('', known);
    const out = { localLeads: known.length, crmKnown: known.length - r.missing.length, pending: this.pending(), dead: this.dead().length };
    if (out.crmKnown !== out.localLeads || out.dead) this.alert(`CRM reconcile mismatch: ${JSON.stringify(out)}`);
    return out;
  }
  today(tz: string) { return dayKey(this.store.clock.now(), tz); }
  tomorrowFrom(day: string, n: number) { return addDays(day, n); }
}
