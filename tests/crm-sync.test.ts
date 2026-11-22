import { describe, it, expect } from 'vitest';
import { Db } from '../src/db/db.js';
import { Store } from '../src/db/store.js';
import { FakeCrm } from '../src/crm/fake.js';
import { CrmSync } from '../src/crm/sync.js';
import { FakeClock } from '../src/util/clock.js';

const setup = () => {
  const clock = new FakeClock(new Date('2026-12-01T08:00:00Z')); const store = new Store(new Db(), clock); const crm = new FakeCrm(); const alerts: string[] = [];
  const sync = new CrmSync(store, crm, undefined, (m) => alerts.push(m));
  const lead = store.createLead({ name: 'معرض أ', segment: 'furniture', place_id: 'p1', phone: '+966551112233' });
  return { clock, store, crm, sync, lead, alerts };
};
const up = (l: any) => ({ op: 'upsert' as const, args: { placeId: l.place_id, business: l.name, segment: l.segment, phone: l.phone } });

describe('CRM sync', () => {
  it('pushes upsert then outbound in order, once, and records the CRM id', async () => {
    const { sync, crm, store, lead } = setup();
    sync.enqueue(lead.id, up(lead)); sync.enqueue(lead.id, { op: 'outbound', args: { ref: 'm1', kind: 'first', text: 'hi', variant: 'A' } });
    const r = await sync.flush(); expect(r.done).toBe(2);
    const crmId = store.lead(lead.id)!.crm_id!; expect(crm.leads.get(crmId)!.attempts).toBe(1);
    await sync.flush(); expect(crm.calls.filter((c) => c === 'outbound')).toHaveLength(1);
  });
  it('a retried outbound with the same ref does not duplicate in the CRM', async () => {
    const { sync, crm, store, lead } = setup(); sync.enqueue(lead.id, up(lead)); await sync.flush();
    const crmId = store.lead(lead.id)!.crm_id!;
    await crm.logOutbound({ leadId: crmId, ref: 'm1', kind: 'first', text: 'a' }); await crm.logOutbound({ leadId: crmId, ref: 'm1', kind: 'first', text: 'a' });
    expect(crm.leads.get(crmId)!.attempts).toBe(1);
  });
  it('CRM down: rows stay pending with backoff, later succeed; nothing lost', async () => {
    const { sync, crm, store, lead, clock } = setup(); crm.down = true;
    sync.enqueue(lead.id, up(lead)); expect((await sync.flush()).failed).toBe(1); expect(sync.pending()).toBe(1);
    crm.down = false; expect((await sync.flush()).done).toBe(0); // still inside backoff
    clock.advance(60_000); expect((await sync.flush()).done).toBe(1); expect(store.lead(lead.id)!.crm_id).toBeTruthy();
  });
  it('a CRM refusal (do-not-contact) kills the row, flags the lead and alerts', async () => {
    const { sync, crm, store, lead, alerts } = setup(); sync.enqueue(lead.id, up(lead)); await sync.flush();
    crm.humanSetDnc(store.lead(lead.id)!.crm_id!); sync.enqueue(lead.id, { op: 'outbound', args: { ref: 'm2', kind: 'first', text: 'x' } });
    const r = await sync.flush(); expect(r.dead).toBe(1); expect(store.lead(lead.id)!.dnc).toBe(true); expect(alerts.length).toBe(1);
  });
  it('an existing CRM client with the same number blocks the lead from ever being messaged', async () => {
    const { sync, crm, store, lead } = setup(); crm.addForeignClient('+966551112233'); sync.enqueue(lead.id, up(lead)); await sync.flush();
    const l = store.lead(lead.id)!; expect(l.dnc).toBe(true); expect(l.dnc_reason).toBe('exists_in_crm_not_ours');
    expect((await sync.preSendCheck(l)).ok).toBe(false);
  });
  it('pre-send check fails closed: unreachable CRM, DNC, human meeting, missing lead', async () => {
    const { sync, crm, store, lead } = setup(); sync.enqueue(lead.id, up(lead)); await sync.flush();
    const crmId = store.lead(lead.id)!.crm_id!;
    expect((await sync.preSendCheck(store.lead(lead.id)!)).ok).toBe(true);
    crm.down = true; expect(await sync.preSendCheck(store.lead(lead.id)!)).toEqual({ ok: false, reason: 'crm_unreachable' }); crm.down = false;
    crm.humanSetStage(crmId, 'اجتماع محجوز'); expect((await sync.preSendCheck(store.lead(lead.id)!)).ok).toBe(false);
    crm.humanDelete(crmId); expect((await sync.preSendCheck(store.lead(lead.id)!)).reason).toBe('missing_in_crm');
  });
  it('human changes in the CRM stop the sequence and cancel planned messages', async () => {
    const { sync, crm, store, lead } = setup();
    store.transition(lead.id, 'enriched', 't'); store.transition(lead.id, 'qualified', 't'); store.transition(lead.id, 'message_ready', 't');
    const m = store.createMessage({ lead_id: lead.id, kind: 'first', text: 'x', state: 'ready' }).msg;
    sync.enqueue(lead.id, up(lead)); await sync.flush();
    crm.humanSetStage(store.lead(lead.id)!.crm_id!, 'اجتماع محجوز');
    expect(await sync.pullChanges()).toBe(1);
    expect(store.lead(lead.id)!.status).toBe('parked'); expect(store.message(m.id)!.state).toBe('skipped');
  });
  it('CRM dnc / deletion → opted_out / wrong_contact and a local permanent block', async () => {
    const { sync, crm, store, lead } = setup(); sync.enqueue(lead.id, up(lead)); await sync.flush();
    crm.humanSetDnc(store.lead(lead.id)!.crm_id!); await sync.pullChanges();
    expect(store.lead(lead.id)!.status).toBe('opted_out'); expect(store.isDnc('+966551112233')).toBe(true);
  });
  it('reconcile flags a lead deleted on the CRM side', async () => {
    const { sync, crm, store, lead, alerts } = setup(); sync.enqueue(lead.id, up(lead)); await sync.flush();
    crm.humanDelete(store.lead(lead.id)!.crm_id!); const r = await sync.reconcile(); expect(r.crmKnown).toBe(0); expect(alerts.some((a) => a.includes('mismatch'))).toBe(true);
  });
});
