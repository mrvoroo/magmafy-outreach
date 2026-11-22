/** Lead status machine (plan §5). Forward-only; every transition is validated and logged by the caller. */
export const STATUSES = [
  'discovered', 'enriched', 'qualified', 'needs_review', 'too_big', 'rejected', 'message_ready', 'scheduled', 'sending',
  'first_message_sent', 'followup_1_sent', 'followup_2_sent', 'followup_3_sent', 'no_reply_closed',
  'replied', 'call_booked', 'later', 'declined', 'has_agency', 'opted_out', 'wrong_contact', 'parked'
] as const;
export type Status = (typeof STATUSES)[number];

export const SENT_STATES: Status[] = ['first_message_sent', 'followup_1_sent', 'followup_2_sent', 'followup_3_sent'];
/** Terminal for outreach: nothing may ever be sent again. */
export const TERMINAL: Status[] = ['declined', 'opted_out', 'wrong_contact', 'no_reply_closed', 'call_booked'];
export const BLOCKING: Status[] = [...TERMINAL, 'replied', 'later', 'has_agency']; // no automatic follow-up

const reply: Status[] = ['replied'];
const T: Record<Status, Status[]> = {
  discovered: ['enriched', 'rejected', 'too_big', 'wrong_contact'],
  enriched: ['qualified', 'rejected', 'too_big', 'wrong_contact'],
  qualified: ['message_ready', 'needs_review', 'rejected', 'wrong_contact'],
  needs_review: ['message_ready', 'rejected', 'qualified'],
  too_big: [], rejected: [],
  message_ready: ['scheduled', 'needs_review', 'wrong_contact', 'opted_out', 'parked'],
  scheduled: ['sending', 'message_ready', 'needs_review', 'wrong_contact', 'opted_out', 'parked'],
  sending: ['first_message_sent', 'followup_1_sent', 'followup_2_sent', 'followup_3_sent', 'scheduled', 'needs_review', 'wrong_contact'],
  first_message_sent: ['followup_1_sent', 'sending', ...reply, 'opted_out', 'wrong_contact', 'declined'],
  followup_1_sent: ['followup_2_sent', 'sending', ...reply, 'opted_out', 'wrong_contact', 'declined'],
  followup_2_sent: ['followup_3_sent', 'sending', ...reply, 'opted_out', 'wrong_contact', 'declined'],
  followup_3_sent: ['no_reply_closed', ...reply, 'opted_out', 'wrong_contact', 'declined'],
  no_reply_closed: ['replied'], // a late reply is still logged (never re-contacted automatically)
  replied: ['call_booked', 'later', 'declined', 'has_agency', 'opted_out', 'wrong_contact'],
  later: ['replied', 'message_ready', 'opted_out', 'declined'], has_agency: ['replied', 'message_ready', 'opted_out', 'declined'],
  call_booked: [], declined: ['opted_out'], opted_out: [], wrong_contact: [], parked: ['message_ready', 'wrong_contact', 'rejected']
};
// Safety stops: from ANY live state the lead may be stopped (opt-out, wrong contact); pre-send states may be parked.
const DEAD: Status[] = ['opted_out', 'wrong_contact', 'call_booked', 'declined', 'too_big', 'rejected', 'no_reply_closed'];
for (const st of STATUSES) {
  if (DEAD.includes(st)) continue;
  for (const x of ['opted_out', 'wrong_contact'] as Status[]) if (!T[st].includes(x)) T[st].push(x);
}
for (const st of ['discovered', 'enriched', 'qualified', 'needs_review', 'message_ready', 'scheduled', 'sending'] as Status[]) if (!T[st].includes('parked')) T[st].push('parked');
export function canTransition(from: Status, to: Status): boolean { return T[from]?.includes(to) ?? false; }
export class IllegalTransition extends Error { constructor(public from: string, public to: string) { super(`illegal transition ${from} → ${to}`); } }
export function assertTransition(from: Status, to: Status): void { if (!canTransition(from, to)) throw new IllegalTransition(from, to); }
export const isTerminal = (s: Status) => TERMINAL.includes(s);
