import { z } from 'zod';

export const OUTCOMES = ['declined', 'no_reply', 'opted_out', 'wrong_contact', 'employee_only', 'later', 'has_agency'] as const;
export type Outcome = (typeof OUTCOMES)[number];

export const CrmViewSchema = z.object({
  found: z.literal(true), leadId: z.string(), stage: z.string(), owner: z.string().default(''), dnc: z.boolean(), isClient: z.boolean(), attempts: z.number(), ours: z.boolean().optional(),
  updated: z.string().optional(), mustStop: z.boolean().optional(), created: z.boolean().optional(), blocked: z.boolean().optional(), duplicate: z.boolean().optional(), applied: z.boolean().optional(), reason: z.string().optional(),
  placeId: z.string().optional(), meetingBooked: z.boolean().optional()
}).passthrough();
export type CrmView = z.infer<typeof CrmViewSchema>;
export type CrmControl = CrmView | { found: false };

export interface UpsertArgs { placeId: string; business: string; segment: string; city?: string; country?: string; phone?: string | null; link?: string | null; ownerName?: string | null; personalLine?: string; personalSource?: string; variant?: string; quality?: number; isTest?: boolean }
export interface OutboundArgs { leadId: string; ref: string; kind: 'first' | 'followup1' | 'followup2' | 'followup3' | 'reply'; variant?: string | null; text: string; nextFollowUpDay?: string | null }
export interface InboundArgs { leadId: string; ref: string; text: string; category?: string; confidence?: number; suggested?: string }
export interface OutcomeArgs { leadId: string; outcome: Outcome; reengageDay?: string; ref?: string }
export interface ChangesResult { items: CrmView[]; missing: string[]; next: string }

/** The only way the outreach system talks to the Magmafy CRM. Faked in tests; HttpCrm in production. */
export interface CrmPort {
  health(): Promise<{ ok: boolean; version?: number }>;
  upsertLead(a: UpsertArgs): Promise<CrmView>;
  logOutbound(a: OutboundArgs): Promise<CrmView>;
  logInbound(a: InboundArgs): Promise<CrmView>;
  setOutcome(a: OutcomeArgs): Promise<CrmView>;
  control(a: { leadId?: string; placeId?: string; phone?: string }): Promise<CrmControl>;
  changes(cursor: string, knownIds: string[]): Promise<ChangesResult>;
}
/** An answer from the CRM that says "no, and retrying will not help" (do-not-contact, not our lead…). */
export class CrmRefusal extends Error { constructor(public code: string) { super('CRM refused: ' + code); } }
