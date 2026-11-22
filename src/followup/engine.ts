import { Store, Lead } from '../db/store.js';
import { Personalizer } from '../personalize/personalizer.js';
import { CrmSync } from '../crm/sync.js';
import { DueFollowup } from '../planner/planner.js';
import { addDays, dayKey } from '../util/time.js';
import { Status } from '../domain/status.js';

const SEQ: { kind: 'followup1' | 'followup2' | 'followup3'; from: Status; idx: 0 | 1 | 2 }[] = [
  { kind: 'followup1', from: 'first_message_sent', idx: 0 }, { kind: 'followup2', from: 'followup_1_sent', idx: 1 }, { kind: 'followup3', from: 'followup_2_sent', idx: 2 }
];
const CLOSE_AFTER_DAYS = 3; // after the final message, a few quiet days, then «no reply»

/** Follow-ups after 2 / 5 / 9 days from the FIRST message, then close as «no reply» (plan §6.8, course rule). */
export class FollowupEngine {
  constructor(private store: Store, private personalizer: Personalizer, private sync: CrmSync) {}

  /** Follow-ups due on `day`: prepared (validated) on demand, oldest first. Skips anyone who replied / opted out / is flagged. */
  async dueFor(day: string): Promise<DueFollowup[]> {
    const s = this.store.settings(); const out: DueFollowup[] = [];
    const leads = this.store.leadsByStatus(['first_message_sent', 'followup_1_sent', 'followup_2_sent'], 5000).filter((l) => !l.dnc && !this.store.isDnc(l.phone) && l.first_sent_at);
    const due: { l: Lead; step: (typeof SEQ)[number]; overdue: number }[] = [];
    for (const l of leads) {
      const step = SEQ.find((x) => x.from === l.status); if (!step) continue;
      const base = dayKey(new Date(l.first_sent_at!), s.timeZone); const dueDay = addDays(base, s.followUpDelaysDays[step.idx]);
      if (day >= dueDay) due.push({ l, step, overdue: (Date.parse(day) - Date.parse(dueDay)) / 86400000 });
    }
    due.sort((a, b) => b.overdue - a.overdue);
    for (const { l, step } of due) {
      const r = await this.personalizer.prepareFollowup(l.id, step.kind);
      if (r.ok) out.push({ leadId: l.id, messageId: r.message.id, kind: step.kind });
      else this.store.event('followup_prepare_failed', 'followup', l.id, { kind: step.kind, reasons: r.reasons });
    }
    return out;
  }
  /** Leads whose final message got no reply: close them (also in the CRM) and stop everything. */
  closeNoReply(day: string): number {
    const s = this.store.settings(); let n = 0;
    for (const l of this.store.leadsByStatus('followup_3_sent', 5000)) {
      const m = this.store.outboundOf(l.id, 'followup3'); if (!m?.sent_at) continue;
      if (day >= addDays(dayKey(new Date(m.sent_at), s.timeZone), CLOSE_AFTER_DAYS)) {
        this.store.transition(l.id, 'no_reply_closed', 'followup', 'no reply after final message');
        this.sync.enqueue(l.id, { op: 'outcome', args: { outcome: 'no_reply', ref: 'nr_' + l.id } }); n++;
      }
    }
    return n;
  }
}
