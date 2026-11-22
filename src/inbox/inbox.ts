import { Store, Lead } from '../db/store.js';
import { InboundWa } from '../sender/port.js';
import { classifyRules, Classification, ReplyCategory } from './classify.js';
import { draftReply } from './drafts.js';
import { CrmSync } from '../crm/sync.js';
import { AiPort } from '../personalize/ai.js';
import { Status } from '../domain/status.js';
import { addDays, dayKey } from '../util/time.js';
import { Logger, nullLogger } from '../util/log.js';

export interface InboxDeps { store: Store; sync: CrmSync; alert: (msg: string, o?: { urgent?: boolean }) => void; ai?: AiPort; log?: Logger }
const NEED_EYES = 0.6;
const digitsOf = (p: string | null | undefined) => (p ?? '').replace(/\D/g, '');

/** Receives every inbound WhatsApp event, matches it to a lead, stops the sequence, classifies, alerts and drafts (plan §6.7). */
export class Inbox {
  constructor(private d: InboxDeps) {}
  private get store() { return this.d.store; }

  matchLead(from: string): Lead | undefined {
    const f = digitsOf(from); if (!f) return undefined;
    return this.store.allLeads().find((l) => digitsOf(l.phone) === f || l.alt_phones.some((p) => digitsOf(p) === f));
  }

  async handle(m: InboundWa): Promise<{ matched: boolean; category?: ReplyCategory; duplicate?: boolean }> {
    if (m.fromMe) return { matched: false };
    if (m.kind === 'group') { this.store.event('inbound_group_ignored', 'inbox', null, { from: m.from }); return { matched: false }; }
    const lead = this.matchLead(m.from);
    if (!lead) { this.store.event('inbound_unmatched', 'inbox', null, { from: m.from, text: (m.text ?? '').slice(0, 200) }); this.d.alert(`📩 Message from an unknown number ${m.from}: «${(m.text ?? `[${m.kind}]`).slice(0, 200)}» — not matched to any lead. Please check.`); return { matched: false }; }
    if (this.store.db.get('SELECT 1 x FROM messages WHERE lead_id=? AND wa_message_id=? AND direction=?', lead.id, m.id, 'in')) return { matched: true, duplicate: true }; // WhatsApp can deliver twice
    const text = m.text ?? (m.kind === 'voice' ? '[voice note]' : m.kind === 'call' ? '[call]' : m.kind === 'missed_call' ? '[missed call]' : '[media]');
    const { msg } = this.store.createMessage({ lead_id: lead.id, kind: 'inbound', direction: 'in', text, state: 'received', wa_message_id: m.id });
    this.store.updateMessage(msg.id, { sent_at: m.at } as any);

    // 1) stop everything planned for this lead, immediately and before anything slow
    this.stopSequence(lead.id, 'replied');
    // 2) classify (rules first; AI only for what the rules cannot place)
    let cls: Classification = classifyRules(m.text, m.kind);
    if (cls.category === 'other' && m.text && this.d.ai?.classifyReply) { try { const r = await this.d.ai.classifyReply({ text: m.text, leadName: lead.name, ourLastMessage: this.lastOut(lead.id) }); cls = { category: (r.category as ReplyCategory) ?? 'other', confidence: Math.min(0.85, r.confidence), matched: ['ai'] }; } catch { /* keep rules */ } }
    const needsEyes = cls.confidence < NEED_EYES || cls.category === 'other';
    const s = this.store.settings(); const draft = draftReply(cls.category, { ownerName: lead.owner_name, me: s.sender.firstName, company: s.sender.company });
    this.store.db.run('INSERT INTO reply_class(message_id,category,confidence,suggested,handled,needs_eyes) VALUES (?,?,?,?,0,?)', msg.id, cls.category, cls.confidence, draft, needsEyes ? 1 : 0);
    // 3) lead status + CRM
    this.applyOutcome(lead, cls, m);
    this.d.sync.enqueue(lead.id, { op: 'inbound', args: { ref: msg.id, text, category: cls.category, confidence: cls.confidence, suggested: draft ?? undefined } });
    // 4) alert the owner (seconds): who, what they said, suggested reply, our personal line + original message
    const first = this.store.outboundOf(lead.id, 'first');
    const urgent = ['voice_or_call', 'positive', 'price', 'send_details', 'who_is_this'].includes(cls.category);
    this.d.alert(`${urgent ? '🔥' : '💬'} ${lead.name} (${lead.city ?? ''}) replied — ${cls.category}${needsEyes ? ' · ⚠️ needs your eyes' : ''}\n\n«${text}»\n\n${draft ? `Suggested reply:\n${draft}\n\n(send it: /send ${msg.id})\n\n` : ''}Our message: ${first?.text ?? '—'}\nPersonal line: ${first?.personal_line ?? '—'}`, { urgent });
    return { matched: true, category: cls.category };
  }

  private lastOut(leadId: string) { const o = this.store.messagesOf(leadId).filter((x) => x.direction === 'out' && x.state === 'sent'); return o.at(-1)?.text ?? null; }

  /** Cancels planned/ready follow-ups and planned items for the lead. */
  stopSequence(leadId: string, why: string) {
    this.store.db.run("UPDATE messages SET state='skipped', failure_reason=? WHERE lead_id=? AND direction='out' AND kind NOT LIKE 'reply%' AND state IN ('ready','scheduled','draft')", 'stopped:' + why, leadId);
    this.store.db.run("UPDATE plan_items SET state='skipped', skip_reason=? WHERE lead_id=? AND state='planned'", why, leadId);
  }

  private move(lead: Lead, to: Status, note: string) {
    const cur = this.store.lead(lead.id)!;
    try { this.store.transition(cur.id, to, 'inbox', note); return; } catch { /* fall through: walk via replied */ }
    try { if (cur.status !== 'replied') this.store.transition(cur.id, 'replied', 'inbox', note); if (to !== 'replied') this.store.transition(cur.id, to, 'inbox', note); } catch { this.store.event('inbox_transition_failed', 'inbox', cur.id, { to, from: cur.status }); }
  }

  private applyOutcome(lead: Lead, c: Classification, m: InboundWa) {
    const s = this.store.settings(); const today = dayKey(this.store.clock.now(), s.timeZone); const sync = this.d.sync;
    const dnc = () => { if (lead.phone) this.store.addDnc(lead.phone, m.text ?? '', 'opt_out'); this.store.updateLead(lead.id, { dnc: true, dnc_reason: 'opt_out' }, 'inbox'); };
    switch (c.category) {
      case 'opt_out': this.move(lead, 'opted_out', 'opt-out: ' + (m.text ?? '').slice(0, 80)); dnc(); sync.enqueue(lead.id, { op: 'outcome', args: { outcome: 'opted_out', ref: 'oo_' + lead.id } }); this.store.event('opt_out', 'inbox', lead.id, { text: m.text }); break;
      case 'not_interested': this.move(lead, 'declined', 'not interested'); sync.enqueue(lead.id, { op: 'outcome', args: { outcome: 'declined', ref: 'dc_' + lead.id } }); break;
      case 'has_agency': { const d = addDays(today, s.reminderDays.hasAgency); this.move(lead, 'has_agency', 'has agency'); this.addReminder(lead.id, d, 'has_agency'); sync.enqueue(lead.id, { op: 'outcome', args: { outcome: 'has_agency', reengageDay: d, ref: 'ha_' + lead.id } }); break; }
      case 'later': { const d = addDays(today, s.reminderDays.later); this.move(lead, 'later', 'later'); this.addReminder(lead.id, d, 'later'); sync.enqueue(lead.id, { op: 'outcome', args: { outcome: 'later', reengageDay: d, ref: 'lt_' + lead.id } }); break; }
      default: this.move(lead, 'replied', c.category);
    }
  }
  /** Owner told us when to come back ("later: next Sunday"): moves the reminder. */
  addReminder(leadId: string, dueDay: string, kind: string) {
    const lead = this.store.lead(leadId)!; const s = this.store.settings();
    const draft = draftReply('positive', { ownerName: lead.owner_name, me: s.sender.firstName, company: s.sender.company });
    this.store.db.run('INSERT OR REPLACE INTO reminders(id,lead_id,due_day,kind,draft,done) VALUES (?,?,?,?,?,0)', `rem_${leadId}_${kind}`, leadId, dueDay, kind, draft ? draft.replace('ممتاز!', 'هلا فيك، رجعت أطمئن عليكم.') : null);
  }
  /** Reminders that are due today are sent to the owner as a draft check-in (never sent automatically). */
  dueReminders(): number {
    const today = dayKey(this.store.clock.now(), this.store.settings().timeZone); let n = 0;
    for (const r of this.store.db.all('SELECT * FROM reminders WHERE done=0 AND due_day<=?', today)) {
      const lead = this.store.lead(r.lead_id); this.store.db.run('UPDATE reminders SET done=1 WHERE id=?', r.id); if (!lead || lead.dnc) continue;
      this.d.alert(`⏰ Reminder (${r.kind}): time to check in with «${lead.name}».\nDraft: ${r.draft ?? ''}`); n++;
    }
    return n;
  }
  markHandled(messageId: string) { this.store.db.run('UPDATE reply_class SET handled=1 WHERE message_id=?', messageId); }
  pending(limit = 10) { return this.store.db.all("SELECT rc.*, m.lead_id, m.text, m.created_at FROM reply_class rc JOIN messages m ON m.id=rc.message_id WHERE rc.handled=0 ORDER BY m.created_at DESC LIMIT ?", limit); }
}
