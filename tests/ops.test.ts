import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../src/db/db.js';
import { Store } from '../src/db/store.js';
import { backupDatabase, verifyDatabase, backupAuthState, restoreAuthState, encryptBundle, decryptBundle } from '../src/ops/backup.js';
import { startAdmin } from '../src/ops/admin.js';
import { variantStats, buildDailySummary, buildWeeklyReport } from '../src/metrics/reports.js';
import { redact } from '../src/util/log.js';
import { world } from './helpers.js';

describe('backup + restore drill', () => {
  it('database backup is consistent and restorable; auth-state backup is encrypted and round-trips; wrong passphrase fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bk-')); const dbFile = join(dir, 'live.sqlite'); const db = new Db(dbFile); const s = new Store(db);
    for (let i = 0; i < 25; i++) s.createLead({ name: 'L' + i, segment: 'furniture', place_id: 'p' + i, phone: '+9665' + (1000000 + i) });
    await backupDatabase(db, join(dir, 'b', 'copy.sqlite')); const v = verifyDatabase(join(dir, 'b', 'copy.sqlite')); expect(v).toMatchObject({ integrity: 'ok', leads: 25 });
    // restore on a "clean machine": open the copy as the live DB and keep working
    const restored = new Store(new Db(join(dir, 'b', 'copy.sqlite'))); expect(restored.allLeads()).toHaveLength(25); restored.createLead({ name: 'new', segment: 'decor', place_id: 'pn' });
    const auth = join(dir, 'auth'); mkdirSync(join(auth, 'sub'), { recursive: true }); writeFileSync(join(auth, 'creds.json'), '{"secret":"SESSION-KEY"}'); writeFileSync(join(auth, 'sub', 'k.json'), 'x');
    backupAuthState(auth, join(dir, 'auth.enc'), 'correct horse battery'); expect(readFileSync(join(dir, 'auth.enc')).toString('latin1')).not.toContain('SESSION-KEY');
    expect(() => restoreAuthState(join(dir, 'auth.enc'), join(dir, 'restored'), 'wrong passphrase!!')).toThrow(/wrong passphrase/);
    expect(restoreAuthState(join(dir, 'auth.enc'), join(dir, 'restored'), 'correct horse battery')).toBe(2); expect(readFileSync(join(dir, 'restored', 'creds.json'), 'utf8')).toContain('SESSION-KEY'); expect(existsSync(join(dir, 'restored', 'sub', 'k.json'))).toBe(true);
    expect(() => encryptBundle(Buffer.from('x'), 'short')).toThrow(); const blob = encryptBundle(Buffer.from('hello'), 'a long enough pass'); blob[blob.length - 1] ^= 1; expect(() => decryptBundle(blob, 'a long enough pass')).toThrow();
  });
});

describe('admin page', () => {
  it('requires the token; /health leaks nothing; pause/resume work; HTML is escaped', async () => {
    const w = await world(); await w.app.start(); await w.makeReady(2); await w.app.morning(); const tok = 'x'.repeat(30);
    w.store.updateLead(w.store.leadsByStatus(['scheduled', 'message_ready'])[0].id, { name: '<script>alert(1)</script>' } as any);
    const srv = startAdmin(w.app, tok, 0); await new Promise((r) => srv.once('listening', r)); const base = `http://127.0.0.1:${(srv.address() as any).port}`;
    try {
      expect((await fetch(base + '/')).status).toBe(401); expect((await fetch(base + '/?t=wrong')).status).toBe(401);
      const h = await (await fetch(base + '/health')).text(); expect(h).not.toContain('<script'); expect(JSON.parse(h).ok).toBe(true);
      const page = await (await fetch(base + '/?t=' + tok)).text(); expect(page).toContain('Magmafy outreach'); expect(page).not.toContain('<script>alert(1)'); expect(page).not.toContain('SEND_ENABLED');
      await fetch(base + '/pause?t=' + tok, { method: 'POST', redirect: 'manual' }); expect(w.store.isPaused()).toBe(true);
      await fetch(base + '/resume?t=' + tok, { method: 'POST', redirect: 'manual' }); expect(w.store.isPaused()).toBe(false);
      await fetch(base + '/mode?m=off&t=' + tok, { method: 'POST', redirect: 'manual' }); expect(w.store.settings().sendMode).toBe('off');
    } finally { srv.close(); }
    expect(() => startAdmin(w.app, 'short', 0)).toThrow();
  });
});

describe('metrics and reports', () => {
  it('per-variant stats, daily summary and weekly report (no comparison before 50 sends each)', async () => {
    const w = await world(); await w.app.start(); await w.makeReady(5); await w.app.morning(); await w.runDay();
    const sent = w.store.allLeads().filter((l) => l.first_sent_at); expect(sent.length).toBeGreaterThan(0);
    const l = sent[0]; w.wa.emitInbound({ id: 'm1', from: l.phone!.replace(/\D/g, ''), jid: 'x', text: 'كم السعر', kind: 'text', at: w.store.now() }); await w.settle();
    const v = variantStats(w.store); expect(v.reduce((n, x) => n + x.sent, 0)).toBe(sent.length); expect(v.reduce((n, x) => n + x.replies, 0)).toBe(1); expect(v.reduce((n, x) => n + x.positive, 0)).toBe(1);
    const sum = buildDailySummary(w.store, w.today); expect(sum).toContain('New messages: ' + sent.length); expect(sum).toContain('price 1');
    expect(buildWeeklyReport(w.store, w.today)).toContain('Not enough data');
  });
});

describe('secrets never leak into logs', () => { it('redacts keys, tokens and long strings', () => { const r = redact({ CRM_OUTREACH_KEY: 'abc', nested: { authorization: 'Bearer x', ok: 'fine' }, long: 'x'.repeat(900) }) as any; expect(r.CRM_OUTREACH_KEY).toBe('[redacted]'); expect(r.nested.authorization).toBe('[redacted]'); expect(r.nested.ok).toBe('fine'); expect(r.long.length).toBeLessThan(600); }); });
