import { createServer, IncomingMessage, ServerResponse, Server } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { App } from '../app.js';
import { Stats } from '../dashboard/stats.js';
import { dashboardHtml, loginHtml } from '../dashboard/page.js';

const safeEq = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
const cookieOf = (req: IncomingMessage, name: string) => (req.headers.cookie ?? '').split(/;\s*/).map((c) => c.split('=')).find(([k]) => k === name)?.[1] ?? '';
const json = (res: ServerResponse, code: number, body: unknown) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };

/** Admin server: the standalone outreach dashboard (separate from the CRM) + JSON API + live stream + /health. Token required for everything except /health. */
export function startAdmin(app: App, token: string, port: number, host = '127.0.0.1'): Server {
  if (!token || token.length < 24) throw new Error('ADMIN_BASIC_TOKEN must be at least 24 characters');
  const stats = new Stats(app.store, app.planner); const store = app.store;
  const tokenOf = (req: IncomingMessage, url: URL) => String(req.headers['x-admin-token'] ?? decodeURIComponent(cookieOf(req, 'adm')) ?? url.searchParams.get('t') ?? '');
  const authed = (req: IncomingMessage, url: URL) => safeEq(tokenOf(req, url), token) || safeEq(String(url.searchParams.get('t') ?? ''), token);
  const days = (url: URL) => { const d = url.searchParams.get('days'); return d === 'all' ? null : Math.max(1, Math.min(365, Number(d) || 30)); };
  const streams = new Set<ServerResponse>(); let lastVersion = '';
  const tick = setInterval(() => { if (!streams.size) return; try { const v = stats.version(); if (v !== lastVersion) { lastVersion = v; for (const r of streams) r.write(`data: ${JSON.stringify({ v })}\n\n`); } else for (const r of streams) r.write(': keep-alive\n\n'); } catch { /* ignore */ } }, 2000);
  const srv = createServer((req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://x'); const path = url.pathname;
      if (path === '/health') return json(res, 200, { ok: true, paused: store.isPaused(), pending_crm: app.sync.pending() }); // no secrets, no lead data
      if (!authed(req, url)) { if (path.startsWith('/api/')) return json(res, 401, { error: 'unauthorized' }); res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); return void res.end(loginHtml()); }
      if (url.searchParams.get('t') && req.method === 'GET' && !path.startsWith('/api/')) { res.writeHead(303, { 'set-cookie': `adm=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`, location: path === '/' ? '/' : path }); return void res.end(); }
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
