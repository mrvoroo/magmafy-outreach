import { randomUUID } from 'node:crypto';
import { Db, Row } from './db.js';
import { Status, assertTransition, STATUSES } from '../domain/status.js';
import { Settings, SettingsSchema, defaultSettings } from '../config/settings.js';
import { Clock, systemClock } from '../util/clock.js';

export type Segment = 'furniture' | 'decor' | 'furnishing';
export type MsgKind = 'first' | 'followup1' | 'followup2' | 'followup3' | 'reply' | 'inbound';
export type MsgState = 'draft' | 'ready' | 'scheduled' | 'intent' | 'sent' | 'failed' | 'needs_review' | 'received' | 'skipped';
export interface Lead {
  id: string; place_id: string | null; name: string; segment: Segment; city: string | null; country: string | null; address: string | null;
  website: string | null; instagram: string | null; phone: string | null; phone_type: string; alt_phones: string[]; wa_reachable: boolean | null; owner_name: string | null;
  sources: Record<string, { source: string; at: string }>; rating: number | null; review_count: number | null; business_status: string | null; chain_flag: boolean;
  score: number | null; tier: string | null; score_breakdown: string[]; status: Status; status_note: string | null; variant: string | null;
  dnc: boolean; dnc_reason: string | null; crm_id: string | null; first_sent_at: string | null; reply_at: string | null; places_fetched_at: string | null; created_at: string; updated_at: string;
}
export interface Evidence { id: string; lead_id: string; type: string; snippet: string; source: string; source_url: string | null; captured_at: string; internal_only: boolean; expires_at: string | null }
export interface Message {
  id: string; lead_id: string; direction: 'out' | 'in'; kind: MsgKind; variant: string | null; text: string; personal_line: string | null; evidence_ids: string[];
  validator_results: Record<string, unknown>; state: MsgState; scheduled_at: string | null; intent_at: string | null; sent_at: string | null; wa_message_id: string | null;
  delivery_status: string | null; failure_reason: string | null; created_at: string;
}
const J = (s: any, d: any) => { try { return s == null ? d : JSON.parse(s); } catch { return d; } };
const toLead = (r: Row): Lead => ({ ...r, alt_phones: J(r.alt_phones, []), sources: J(r.sources, {}), score_breakdown: J(r.score_breakdown, []), wa_reachable: r.wa_reachable == null ? null : !!r.wa_reachable, chain_flag: !!r.chain_flag, dnc: !!r.dnc } as Lead);
const toMsg = (r: Row): Message => ({ ...r, evidence_ids: J(r.evidence_ids, []), validator_results: J(r.validator_results, {}) } as Message);
const toEv = (r: Row): Evidence => ({ ...r, internal_only: !!r.internal_only } as Evidence);

export class Store {
  constructor(readonly db: Db, readonly clock: Clock = systemClock) {}
  now() { return this.clock.now().toISOString(); }

  // ---- events (append-only) ----
  event(type: string, actor: string, leadId: string | null, data: object = {}) { this.db.run('INSERT INTO events(at,lead_id,type,actor,data) VALUES (?,?,?,?,?)', this.now(), leadId, type, actor, JSON.stringify(data)); }
  events(leadId?: string, limit = 100): Row[] { return leadId ? this.db.all('SELECT * FROM events WHERE lead_id=? ORDER BY id DESC LIMIT ?', leadId, limit) : this.db.all('SELECT * FROM events ORDER BY id DESC LIMIT ?', limit); }

  // ---- settings / kv ----
  settings(): Settings {
    const o: Record<string, unknown> = {};
    for (const r of this.db.all('SELECT key,value FROM settings')) o[r.key] = J(r.value, undefined);
    const p = SettingsSchema.safeParse(o);
    return p.success ? p.data : defaultSettings();
  }
  setSetting(key: keyof Settings, value: unknown, actor = 'system') {
    const merged = SettingsSchema.safeParse({ ...Object.fromEntries(this.db.all('SELECT key,value FROM settings').map((r) => [r.key, J(r.value, undefined)])), [key]: value });
    if (!merged.success) throw new Error('invalid setting ' + String(key) + ': ' + merged.error.message);
    this.db.run('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, JSON.stringify(value));
    this.event('setting_changed', actor, null, { key, value });
  }
  kvGet<T = string>(key: string, def?: T): T | undefined { const r = this.db.get('SELECT value FROM kv WHERE key=?', key); return r ? (J(r.value, def) as T) : def; }
  kvSet(key: string, value: unknown) { this.db.run('INSERT INTO kv(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, JSON.stringify(value)); }
  isPaused() { return this.kvGet<boolean>('paused', false) === true; }
  setPaused(p: boolean, reason: string, actor: string) { this.kvSet('paused', p); this.kvSet('pause_reason', reason); this.event(p ? 'paused' : 'resumed', actor, null, { reason }); }

  // ---- leads ----
  createLead(l: Partial<Lead> & { name: string; segment: Segment }): Lead {
    const id = l.id ?? 'ld_' + randomUUID().slice(0, 12); const now = this.now();
    this.db.run(`INSERT INTO leads(id,place_id,name,segment,city,country,address,website,instagram,phone,phone_type,alt_phones,owner_name,sources,rating,review_count,business_status,chain_flag,status,created_at,updated_at,places_fetched_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, l.place_id ?? null, l.name, l.segment, l.city ?? null, l.country ?? null, l.address ?? null, l.website ?? null, l.instagram ?? null,
      l.phone ?? null, l.phone_type ?? 'unknown', JSON.stringify(l.alt_phones ?? []), l.owner_name ?? null, JSON.stringify(l.sources ?? {}), l.rating ?? null, l.review_count ?? null, l.business_status ?? null, l.chain_flag ? 1 : 0, 'discovered', now, now, l.places_fetched_at ?? null);
    this.event('lead_created', 'sourcer', id, { place_id: l.place_id });
    return this.lead(id)!;
  }
  lead(id: string): Lead | undefined { const r = this.db.get('SELECT * FROM leads WHERE id=?', id); return r ? toLead(r) : undefined; }
  leadByPlace(pid: string) { const r = this.db.get('SELECT * FROM leads WHERE place_id=?', pid); return r ? toLead(r) : undefined; }
  leadByPhone(phone: string) { const r = this.db.get('SELECT * FROM leads WHERE phone=?', phone); return r ? toLead(r) : undefined; }
  /** Matches the main phone OR any alternate number (so a number moved to alt_phones still de-duplicates). */
  leadByAnyPhone(phone: string) { const r = this.db.get('SELECT * FROM leads WHERE phone=? OR alt_phones LIKE ?', phone, `%"${phone}"%`); return r ? toLead(r) : undefined; }
  leadsByStatus(s: Status | Status[], limit = 1000): Lead[] { const a = Array.isArray(s) ? s : [s]; return this.db.all(`SELECT * FROM leads WHERE status IN (${a.map(() => '?').join(',')}) ORDER BY score DESC, created_at ASC LIMIT ?`, ...a, limit).map(toLead); }
  allLeads(): Lead[] { return this.db.all('SELECT * FROM leads').map(toLead); }
  updateLead(id: string, patch: Partial<Lead>, actor = 'system') {
    const cols: string[] = [], vals: any[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'id' || k === 'status') continue;
      cols.push(`${k}=?`); vals.push(typeof v === 'object' && v !== null ? JSON.stringify(v) : typeof v === 'boolean' ? (v ? 1 : 0) : v === undefined ? null : v);
    }
    if (!cols.length) return;
    cols.push('updated_at=?'); vals.push(this.now());
    this.db.run(`UPDATE leads SET ${cols.join(',')} WHERE id=?`, ...vals, id);
    this.event('lead_updated', actor, id, { fields: Object.keys(patch) });
  }
  /** The only way to change a status: validated + logged. */
  transition(id: string, to: Status, actor: string, note?: string): Lead {
    return this.db.tx(() => {
      const l = this.lead(id); if (!l) throw new Error('no such lead ' + id);
      if (l.status === to) return l;
      if (!STATUSES.includes(to)) throw new Error('unknown status ' + to);
      assertTransition(l.status, to);
      this.db.run('UPDATE leads SET status=?, status_note=?, updated_at=? WHERE id=?', to, note ?? null, this.now(), id);
      this.event('status', actor, id, { from: l.status, to, note });
      return this.lead(id)!;
    });
  }

  // ---- evidence ----
  addEvidence(e: Omit<Evidence, 'id' | 'captured_at'> & { captured_at?: string }): Evidence {
    const id = 'ev_' + randomUUID().slice(0, 12);
    this.db.run('INSERT INTO evidence(id,lead_id,type,snippet,source,source_url,captured_at,internal_only,expires_at) VALUES (?,?,?,?,?,?,?,?,?)', id, e.lead_id, e.type, e.snippet, e.source, e.source_url ?? null, e.captured_at ?? this.now(), e.internal_only ? 1 : 0, e.expires_at ?? null);
    return this.evidence(e.lead_id).find((x) => x.id === id)!;
  }
  evidence(leadId: string): Evidence[] { return this.db.all('SELECT * FROM evidence WHERE lead_id=? ORDER BY captured_at', leadId).map(toEv); }
  evidenceByIds(ids: string[]): Evidence[] { return ids.length ? this.db.all(`SELECT * FROM evidence WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids).map(toEv) : []; }
  /** Google-derived evidence is deleted once past its retention (plan §3.6). Returns number purged. */
  purgeExpired(): number { return Number(this.db.run("DELETE FROM evidence WHERE expires_at IS NOT NULL AND expires_at < ?", this.now()).changes); }

  // ---- messages ----
  /** Idempotent by (lead,kind,direction): a second insert returns the existing row instead of a duplicate. */
  createMessage(m: { lead_id: string; kind: MsgKind; direction?: 'out' | 'in'; text: string; state: MsgState; variant?: string | null; personal_line?: string | null; evidence_ids?: string[]; validator_results?: object; scheduled_at?: string | null; wa_message_id?: string | null }): { msg: Message; created: boolean } {
    const direction = m.direction ?? 'out';
    const existing = direction === 'out' && m.kind !== 'reply' ? this.db.get('SELECT * FROM messages WHERE lead_id=? AND kind=? AND direction=?', m.lead_id, m.kind, direction) : undefined;
    if (existing) return { msg: toMsg(existing), created: false };
    const id = 'msg_' + randomUUID().slice(0, 12);
    // inbound messages may share kind; uniqueness for them is by wa id, so give them a unique kind slot
    const kind = direction === 'in' ? ('inbound' as MsgKind) : m.kind;
    const kindKey = direction === 'in' ? kind + ':' + id : m.kind === 'reply' ? 'reply:' + id : m.kind; // many replies / inbound per lead are fine; cold messages stay unique per (lead, kind)
    this.db.run(`INSERT INTO messages(id,lead_id,direction,kind,variant,text,personal_line,evidence_ids,validator_results,state,scheduled_at,wa_message_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, m.lead_id, direction, kindKey, m.variant ?? null, m.text, m.personal_line ?? null, JSON.stringify(m.evidence_ids ?? []), JSON.stringify(m.validator_results ?? {}), m.state, m.scheduled_at ?? null, m.wa_message_id ?? null, this.now());
    return { msg: this.message(id)!, created: true };
  }
  message(id: string): Message | undefined { const r = this.db.get('SELECT * FROM messages WHERE id=?', id); return r ? toMsg(r) : undefined; }
  messagesOf(leadId: string): Message[] { return this.db.all('SELECT * FROM messages WHERE lead_id=? ORDER BY created_at, rowid', leadId).map(toMsg); }
  outboundOf(leadId: string, kind: MsgKind) { const r = this.db.get("SELECT * FROM messages WHERE lead_id=? AND kind=? AND direction='out'", leadId, kind); return r ? toMsg(r) : undefined; }
  updateMessage(id: string, patch: Partial<Message>) {
    const cols: string[] = [], vals: any[] = [];
    for (const [k, v] of Object.entries(patch)) { if (k === 'id') continue; cols.push(`${k}=?`); vals.push(typeof v === 'object' && v !== null ? JSON.stringify(v) : v ?? null); }
    if (cols.length) this.db.run(`UPDATE messages SET ${cols.join(',')} WHERE id=?`, ...vals, id);
  }
  recentOutboundTexts(n: number): Message[] { return this.db.all("SELECT * FROM messages WHERE direction='out' AND state IN ('sent','scheduled','ready','intent') ORDER BY created_at DESC, rowid DESC LIMIT ?", n).map(toMsg); }
  sentCountOn(dayStart: string, dayEnd: string, kinds?: MsgKind[]): number {
    const k = kinds ? `AND kind IN (${kinds.map(() => '?').join(',')})` : '';
    return Number(this.db.get(`SELECT COUNT(*) c FROM messages WHERE direction='out' AND state IN ('sent','intent') AND COALESCE(sent_at,intent_at)>=? AND COALESCE(sent_at,intent_at)<? ${k}`, dayStart, dayEnd, ...(kinds ?? []))!.c);
  }

  // ---- DNC ----
  addDnc(phone: string, trigger: string, reason: string) { this.db.run('INSERT OR REPLACE INTO dnc(phone,at,trigger_text,reason) VALUES (?,?,?,?)', phone, this.now(), trigger, reason); }
  isDnc(phone: string | null | undefined): boolean { return !!phone && !!this.db.get('SELECT 1 x FROM dnc WHERE phone=?', phone); }

  // ---- spend ----
  addSpend(provider: 'google' | 'ai', usd: number, note = '') { this.db.run('INSERT INTO spend(at,provider,usd,note) VALUES (?,?,?,?)', this.now(), provider, usd, note); }
  spendSince(provider: 'google' | 'ai', iso: string): number { return Number(this.db.get('SELECT COALESCE(SUM(usd),0) s FROM spend WHERE provider=? AND at>=?', provider, iso)!.s); }
}
