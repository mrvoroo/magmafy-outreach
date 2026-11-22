import { createServer, IncomingMessage, Server } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { App } from '../app.js';
import { dayKey } from '../util/time.js';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const safeEq = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

/** Very small protected page + health endpoint (plan §6.11). Also put it behind Cloudflare Access. */
export function startAdmin(app: App, token: string, port: number, host = '127.0.0.1'): Server {
  if (!token || token.length < 24) throw new Error('ADMIN_BASIC_TOKEN must be at least 24 characters');
  const authed = (req: IncomingMessage) => { const h = req.headers['x-admin-token'] ?? new URL(req.url ?? '/', 'http://x').searchParams.get('t') ?? ''; return safeEq(String(h), token); };
  return createServer((req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://x');
      if (url.pathname === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); return void res.end(JSON.stringify({ ok: true, paused: app.store.isPaused(), pending_crm: app.sync.pending() })); } // no secrets, no lead data
      if (!authed(req)) { res.writeHead(401); return void res.end('unauthorized'); }
      const store = app.store; const s = store.settings();
      if (req.method === 'POST') {
        if (url.pathname === '/pause') store.setPaused(true, 'admin page', 'admin'); else if (url.pathname === '/resume') app.breaker.resume('admin', true); else if (url.pathname === '/mode' && ['off', 'assisted', 'auto'].includes(url.searchParams.get('m') ?? '')) store.setSetting('sendMode', url.searchParams.get('m'), 'admin');
        res.writeHead(303, { location: '/?t=' + encodeURIComponent(token) }); return void res.end();
      }
      const day = dayKey(store.clock.now(), s.timeZone); const plan = app.planner.ensurePlan(day);
      const rows = store.db.all("SELECT m.created_at, m.kind, m.state, m.text, m.personal_line, l.name FROM messages m JOIN leads l ON l.id=m.lead_id ORDER BY m.rowid DESC LIMIT 20");
      const t = encodeURIComponent(token);
      const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Outreach</title><style>body{font:14px system-ui;max-width:900px;margin:20px auto;padding:0 12px}td,th{border-bottom:1px solid #ddd;padding:4px 8px;text-align:start;vertical-align:top}form{display:inline}</style>
<h1>Magmafy outreach</h1><p>${store.isPaused() ? '⏸ PAUSED — ' + esc(store.kvGet('pause_reason')) : '▶️ running'} · mode <b>${esc(app.sender.mode())}</b> (setting ${esc(s.sendMode)}) · ready pool ${store.leadsByStatus('message_ready').length}</p>
<form method="post" action="/pause?t=${t}"><button>Pause</button></form> <form method="post" action="/resume?t=${t}"><button>Resume</button></form> ${['off', 'assisted', 'auto'].map((m) => `<form method="post" action="/mode?m=${m}&t=${t}"><button>${m}</button></form>`).join(' ')}
<h2>Today ${day} — caps new ${plan.caps.newCap}, follow-ups ${plan.caps.followCap}, warm-up day ${plan.caps.rampIndex}</h2><table>${plan.items.map((i) => `<tr><td>${esc(new Date(i.target_at).toLocaleTimeString('en-GB', { timeZone: s.timeZone }))}</td><td>${esc(store.lead(i.lead_id)?.name)}</td><td>${esc(i.kind)}</td><td>${esc(i.state)}</td></tr>`).join('')}</table>
<h2>Pending replies</h2><table>${app.inbox.pending(10).map((r) => `<tr><td>${esc(store.lead(r.lead_id)?.name)}</td><td>${esc(r.category)}</td><td>${esc(r.text)}</td></tr>`).join('')}</table>
<h2>Last 20 messages</h2><table>${rows.map((r) => `<tr><td>${esc(r.name)}</td><td>${esc(r.kind)} · ${esc(r.state)}</td><td>${esc(r.text)}<br><small>${esc(r.personal_line)}</small></td></tr>`).join('')}</table>
<h2>Settings</h2><pre>${esc(JSON.stringify(s, null, 1))}</pre>`;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'x-frame-options': 'DENY', 'cache-control': 'no-store' }); res.end(html);
    } catch (e) { res.writeHead(500); res.end('error'); }
  }).listen(port, host);
}
