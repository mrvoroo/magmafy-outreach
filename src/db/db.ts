import { createRequire } from 'node:module';
import type { DatabaseSync as DB } from 'node:sqlite';
import { MIGRATIONS } from './schema.js';

// vite-node strips the `node:` prefix of the experimental sqlite module, so load it through require.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
export type Row = Record<string, any>;
export class Db {
  readonly raw: DB;
  constructor(path = ':memory:') {
    this.raw = new DatabaseSync(path);
    this.raw.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    this.migrate();
  }
  private migrate() {
    this.raw.exec('CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY)');
    const done = new Set(this.all('SELECT id FROM _migrations').map((r) => r.id as number));
    for (const m of MIGRATIONS) if (!done.has(m.id)) { this.tx(() => { this.raw.exec(m.sql); this.run('INSERT INTO _migrations(id) VALUES (?)', m.id); }); }
  }
  run(sql: string, ...p: any[]) { return this.raw.prepare(sql).run(...p); }
  get(sql: string, ...p: any[]): Row | undefined { return this.raw.prepare(sql).get(...p) as Row | undefined; }
  all(sql: string, ...p: any[]): Row[] { return this.raw.prepare(sql).all(...p) as Row[]; }
  /** Synchronous transaction; rolls back on throw. Nested calls join the outer one. */
  private depth = 0;
  tx<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.raw.exec('BEGIN IMMEDIATE'); this.depth++;
    try { const r = fn(); this.raw.exec('COMMIT'); return r; } catch (e) { this.raw.exec('ROLLBACK'); throw e; } finally { this.depth--; }
  }
  close() { this.raw.close(); }
}
