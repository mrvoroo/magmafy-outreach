import { describe, it, expect } from 'vitest';
import { Db } from '../src/db/db.js';
import { Store } from '../src/db/store.js';
import { IllegalTransition } from '../src/domain/status.js';
import { FakeClock } from '../src/util/clock.js';

const mk = () => new Store(new Db(), new FakeClock(new Date('2026-12-01T08:00:00Z')));
describe('store', () => {
  it('creates leads once per place id and phone', () => {
    const s = mk();
    s.createLead({ name: 'A', segment: 'furniture', place_id: 'p1', phone: '+966501234567' });
    expect(() => s.createLead({ name: 'B', segment: 'decor', place_id: 'p1' })).toThrow();
    expect(() => s.createLead({ name: 'C', segment: 'decor', place_id: 'p2', phone: '+966501234567' })).toThrow();
  });
  it('enforces forward-only status transitions and logs them', () => {
    const s = mk(); const l = s.createLead({ name: 'A', segment: 'furniture', place_id: 'p1' });
    s.transition(l.id, 'enriched', 't');
    expect(() => s.transition(l.id, 'first_message_sent', 't')).toThrow(IllegalTransition);
    expect(() => s.transition(l.id, 'discovered', 't')).toThrow(IllegalTransition);
    expect(s.events(l.id).some((e) => e.type === 'status')).toBe(true);
  });
  it('terminal states cannot be left', () => {
    const s = mk(); const l = s.createLead({ name: 'A', segment: 'furniture' });
    s.transition(l.id, 'wrong_contact', 't');
    expect(() => s.transition(l.id, 'enriched', 't')).toThrow(IllegalTransition);
  });
  it('message creation is idempotent per lead+kind (no duplicate sends)', () => {
    const s = mk(); const l = s.createLead({ name: 'A', segment: 'furniture' });
    const a = s.createMessage({ lead_id: l.id, kind: 'first', text: 'x', state: 'ready' });
    const b = s.createMessage({ lead_id: l.id, kind: 'first', text: 'y', state: 'ready' });
    expect(a.created).toBe(true); expect(b.created).toBe(false); expect(b.msg.id).toBe(a.msg.id); expect(b.msg.text).toBe('x');
  });
  it('inbound messages can be stored many times', () => {
    const s = mk(); const l = s.createLead({ name: 'A', segment: 'furniture' });
    s.createMessage({ lead_id: l.id, kind: 'inbound', direction: 'in', text: 'hi', state: 'received' });
    s.createMessage({ lead_id: l.id, kind: 'inbound', direction: 'in', text: 'hi again', state: 'received' });
    expect(s.messagesOf(l.id)).toHaveLength(2);
  });
  it('settings validate and persist', () => {
    const s = mk(); expect(s.settings().newPerDay).toBe(12);
    s.setSetting('newPerDay', 8); expect(s.settings().newPerDay).toBe(8);
    expect(() => s.setSetting('newPerDay', 500)).toThrow();
  });
  it('purges expired google evidence', () => {
    const s = mk(); const l = s.createLead({ name: 'A', segment: 'furniture' });
    s.addEvidence({ lead_id: l.id, type: 'review', snippet: 's', source: 'g', source_url: null, internal_only: true, expires_at: '2026-01-01T00:00:00Z' });
    s.addEvidence({ lead_id: l.id, type: 'site', snippet: 't', source: 'w', source_url: null, internal_only: false, expires_at: null });
    expect(s.purgeExpired()).toBe(1); expect(s.evidence(l.id)).toHaveLength(1);
  });
});
