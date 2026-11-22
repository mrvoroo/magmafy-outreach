import { createServer, IncomingMessage, ServerResponse, Server } from 'node:http';
import { timingSafeEqual, randomBytes, createHash } from 'node:crypto';
import { AdminAuthPort } from '../crm/contract.js';
import { App } from '../app.js';
import { Stats } from '../dashboard/stats.js';
import { dashboardHtml, loginHtml } from '../dashboard/page.js';

const safeEq = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
const cookieOf = (req: IncomingMessage, name: string) => (req.headers.cookie ?? '').split(/;\s*/).map((c) => c.split('=')).find(([k]) => k === name)?.[1] ?? '';
const json = (res: ServerResponse, code: number, body: unknown) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };

const SESSION_DAYS = 14, RECHECK_MS = 10 * 60_000;
const sha = (x: string) => createHash('sha256').update(x).digest('hex');
const readBody = (req: IncomingMessage) => new Promise<any>((ok) => { let b = ''; req.on('data', (c) => { b += c; if (b.length > 4000) req.destroy(); }); req.on('end', () => { try { ok(JSON.parse(b || '{}')); } catch { ok({}); } }); });

/**
 * Admin server: the standalone outreach dashboard (separate from the CRM) + JSON API + live stream + /health.
 * Sign-in = the CRM's own admins: e-mail → the same 6-digit code the CRM e-mails → a dashboard session (14 days, HttpOnly cookie).
 * Access is re-checked against the CRM every 10 minutes, so removing someone's admin role in the CRM locks them out.
 * `opts.token` is an OPTIONAL break-glass / demo fallback; production uses the CRM sign-in only.
 */
export function startAdmin(app: App, opts: string | { token?: string; auth?: AdminAuthPort }, port: number, host = '127.0.0.1'): Server {
  const o = typeof opts === 'string' ? { token: opts } : opts; const token = o.token ?? ''; const auth = o.auth;
  if (token && token.length < 24) throw new Error('ADMIN_BASIC_TOKEN, if set, must be at least 24 characters');
  if (!token && !auth) throw new Error('admin sign-in needs the CRM (CRM_URL + CRM_OUTREACH_KEY) or an ADMIN_BASIC_TOKEN');
  const stats = new Stats(app.store, app.planner); const store = app.store; const db = store.db;
  const hits = new Map<string, number[]>(); // simple rate limit for the sign-in endpoints: 8 tries / 15 min per IP
  const limited = (ip: string) => { const now = Date.now(); const l = (hits.get(ip) ?? []).filter((t) => now - t < 900_000); l.push(now); hits.set(ip, l); return l.length > 8; };
  const session = async (req: IncomingMessage): Promise<{ email: string; name: string } | null> => {
    const c = decodeURIComponent(cookieOf(req, 'adm') ?? ''); if (!c) return null;
    const row = db.get('SELECT * FROM admin_sessions WHERE token_hash=?', sha(c)); if (!row || row.expires_at < store.now()) return null;
    if (auth && Date.now() - Date.parse(row.checked_at) > RECHECK_MS) { // still an admin in the CRM?
      try { if (!(await auth.adminCheck(row.email))) { db.run('DELETE FROM admin_sessions WHERE token_hash=?', row.token_hash); return null; } db.run('UPDATE admin_sessions SET checked_at=? WHERE token_hash=?', store.now(), row.token_hash); } catch { /* CRM unreachable: keep the session, re-check next time */ }
    }
    return { email: row.email, name: row.name };
  };
  const newSession = (email: string, name: string) => { const t = randomBytes(32).toString('hex'); const now = store.now(); db.run('INSERT INTO admin_sessions(token_hash,email,name,created_at,expires_at,checked_at) VALUES (?,?,?,?,?,?)', sha(t), email, name, now, new Date(Date.now() + SESSION_DAYS * 86400000).toISOString(), now); db.run('DELETE FROM admin_sessions WHERE expires_at<?', now); return t; };
  const cookie = (req: IncomingMessage, t: string, maxAge: number) => `adm=${encodeURIComponent(t)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''}`;
  const authed = async (req: IncomingMessage, url: URL) => !!(await session(req)) || (!!token && (safeEq(String(req.headers['x-admin-token'] ?? ''), token) || safeEq(String(url.searchParams.get('t') ?? ''), token)));
  const days = (url: URL) => { const d = url.searchParams.get('days'); return d === 'all' ? null : Math.max(1, Math.min(365, Number(d) || 30)); };
  const streams = new Set<ServerResponse>(); let lastVersion = '';
  const tick = setInterval(() => { if (!streams.size) return; try { const v = stats.version(); if (v !== lastVersion) { lastVersion = v; for (const r of streams) r.write(`data: ${JSON.stringify({ v })}\n\n`); } else for (const r of streams) r.write(': keep-alive\n\n'); } catch { /* ignore */ } }, 2000);
  const srv = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://x'); const path = url.pathname;
      if (path === '/health') return json(res, 200, { ok: true, paused: store.isPaused(), pending_crm: app.sync.pending() }); // no secrets, no lead data
      const ip = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',')[0].trim();
      if (path === '/auth/request' && req.method === 'POST' && auth) {
        if (limited(ip)) return json(res, 429, { error: 'محاولات كتير، جرّب بعد شوية' }); const b = await readBody(req);
        try { await auth.adminRequestCode(String(b.email ?? '').trim().toLowerCase()); return json(res, 200, { ok: true }); } catch (e) { return json(res, 400, { error: String((e as Error).message).slice(0, 200) }); }
      }
      if (path === '/auth/verify' && req.method === 'POST' && auth) {
        if (limited(ip)) return json(res, 429, { error: 'محاولات كتير، جرّب بعد شوية' }); const b = await readBody(req);
        try { const r = await auth.adminLogin(String(b.email ?? '').trim().toLowerCase(), String(b.code ?? '')); const t = newSession(r.email, r.name); store.event('dashboard_login', r.email, null, { ip }); res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': cookie(req, t, SESSION_DAYS * 86400) }); return void res.end(JSON.stringify({ ok: true, name: r.name })); } catch (e) { return json(res, 401, { error: String((e as Error).message).slice(0, 200) }); }
      }
      if (path === '/auth/logout') { const c = decodeURIComponent(cookieOf(req, 'adm') ?? ''); if (c) db.run('DELETE FROM admin_sessions WHERE token_hash=?', sha(c)); res.writeHead(303, { 'set-cookie': cookie(req, '', 0), location: '/' }); return void res.end(); }
      if (!(await authed(req, url))) { if (path.startsWith('/api/')) return json(res, 401, { error: 'unauthorized' }); res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); return void res.end(loginHtml(!!auth, !!token)); }
      if (token && url.searchParams.get('t') && req.method === 'GET' && !path.startsWith('/api/') && safeEq(String(url.searchParams.get('t')), token)) { const t = newSession('break-glass', 'Admin'); res.writeHead(303, { 'set-cookie': cookie(req, t, SESSION_DAYS * 86400), location: '/' }); return void res.end(); }
      if (path === '/api/stream') { res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' }); res.write(`data: ${JSON.stringify({ v: stats.version() })}\n\n`); streams.add(res); req.on('close', () => streams.delete(res)); return; }
      if (req.method === 'POST') {
        const q = url.searchParams; const act = path.replace('/api', '');
        if (act === '/pause') store.setPaused(true, 'dashboard', 'admin');
        else if (act === '/resume') { const r = app.breaker.resume('admin', app.waStatus() === 'open' || app.sender.mode() === 'off'); if (!r.ok) return json(res, 409, r); }
        else if (act === '/mode' && ['off', 'assisted', 'auto'].includes(q.get('m') ?? '')) store.setSetting('sendMode', q.get('m'), 'admin');
        else if (act === '/skip') { if (!app.planner.skipItem(q.get('id') ?? '', 'dashboard_skip')) return json(res, 404, { error: 'not planned' }); }
        else if (act === '/handled') app.inbox.markHandled(q.get('id') ?? '');
        else if (act === '/dnc') { const l = store.lead(q.get('lead') ?? ''); if (!l?.phone) return json(res, 404, { error: 'no lead' }); store.addDnc(l.phone, 'dashboard', 'manual'); store.updateLead(l.id, { dnc: true, dnc_reason: 'manual' }, 'admin'); app.inbox.stopSequence(l.id, 'dnc'); }
        else return json(res, 404, { error: 'unknown action' });
        if (!path.startsWith('/api/')) { res.writeHead(303, { location: '/' }); return void res.end(); }
        return json(res, 200, { ok: true });
      }
      if (path === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'x-frame-options': 'DENY', 'cache-control': 'no-store' }); return void res.end(dashboardHtml()); }
      if (path === '/api/overview') return json(res, 200, stats.overview(app.waStatus(), app.sender.mode()));
      if (path === '/api/series') return json(res, 200, stats.series(Math.min(60, Number(url.searchParams.get('days')) || 14)));
      if (path === '/api/funnel') return json(res, 200, stats.funnel(days(url)));
      if (path === '/api/results') return json(res, 200, stats.results(days(url)));
      if (path === '/api/reasons') return json(res, 200, stats.reasons(days(url)));
      if (path === '/api/quality') return json(res, 200, stats.quality(days(url)));
      if (path === '/api/leads') return json(res, 200, { ...stats.leads({ text: url.searchParams.get('q') ?? undefined, status: url.searchParams.get('status') ?? undefined, offset: Number(url.searchParams.get('offset')) || 0 }), statuses: stats.statusCounts() });
      if (path.startsWith('/api/lead/')) { const c = stats.conversation(decodeURIComponent(path.slice(10))); return c ? json(res, 200, c) : json(res, 404, { error: 'not found' }); }
      if (path === '/api/replies') return json(res, 200, app.inbox.pending(30).map((r) => ({ ...r, lead: store.lead(r.lead_id)?.name })));
      if (path === '/api/settings') return json(res, 200, store.settings());
      res.writeHead(404); res.end('not found');
    } catch (e) { json(res, 500, { error: 'server error' }); }
  }).listen(port, host);
  srv.on('close', () => clearInterval(tick));
  return srv;
}
