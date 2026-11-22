import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { Db } from '../db/db.js';

const { backup: sqliteBackup, DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
const MAGIC = Buffer.from('MGMF1');

/** Consistent online copy of the SQLite database (safe while the app is running). */
export async function backupDatabase(db: Db, destFile: string): Promise<void> { mkdirSync(dirname(destFile), { recursive: true }); await sqliteBackup(db.raw, destFile); }

/** AES-256-GCM bundle of the WhatsApp auth state: scrypt-derived key, random salt+IV; a wrong passphrase fails the auth tag. */
export function encryptBundle(plain: Buffer, passphrase: string): Buffer {
  if (!passphrase || passphrase.length < 12) throw new Error('BACKUP_PASSPHRASE must be at least 12 characters');
  const salt = randomBytes(16), iv = randomBytes(12); const key = scryptSync(passphrase, salt, 32);
  const c = createCipheriv('aes-256-gcm', key, iv); const enc = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([MAGIC, salt, iv, c.getAuthTag(), enc]);
}
export function decryptBundle(blob: Buffer, passphrase: string): Buffer {
  if (!blob.subarray(0, 5).equals(MAGIC)) throw new Error('not a backup bundle');
  const salt = blob.subarray(5, 21), iv = blob.subarray(21, 33), tag = blob.subarray(33, 49), enc = blob.subarray(49);
  const d = createDecipheriv('aes-256-gcm', scryptSync(passphrase, salt, 32), iv); d.setAuthTag(tag);
  try { return Buffer.concat([d.update(enc), d.final()]); } catch { throw new Error('wrong passphrase or corrupted backup'); }
}
const walk = (dir: string, base = dir): string[] => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? walk(p, base) : [relative(base, p)]; });
/** Packs a directory into one JSON bundle {path: base64}, then encrypts it. */
export function backupAuthState(authDir: string, destFile: string, passphrase: string) {
  const files: Record<string, string> = {}; if (existsSync(authDir)) for (const f of walk(authDir)) files[f] = readFileSync(join(authDir, f)).toString('base64');
  mkdirSync(dirname(destFile), { recursive: true }); writeFileSync(destFile, encryptBundle(Buffer.from(JSON.stringify(files)), passphrase), { mode: 0o600 });
}
export function restoreAuthState(srcFile: string, destDir: string, passphrase: string): number {
  const files = JSON.parse(decryptBundle(readFileSync(srcFile), passphrase).toString()) as Record<string, string>;
  rmSync(destDir, { recursive: true, force: true }); for (const [f, b64] of Object.entries(files)) { const p = join(destDir, f); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, Buffer.from(b64, 'base64'), { mode: 0o600 }); }
  return Object.keys(files).length;
}
/** Restore drill helper: integrity check + counts of a backup file. */
export function verifyDatabase(file: string): { integrity: string; leads: number; messages: number } {
  const d = new DatabaseSync(file); try { const integrity = String((d.prepare('PRAGMA integrity_check').get() as any).integrity_check); return { integrity, leads: Number((d.prepare('SELECT COUNT(*) c FROM leads').get() as any).c), messages: Number((d.prepare('SELECT COUNT(*) c FROM messages').get() as any).c) }; } finally { d.close(); }
}
/** Keeps the newest `keep` files with a prefix. */
export function prune(dir: string, prefix: string, keep = 14) { const fs = readdirSync(dir).filter((f) => f.startsWith(prefix)).sort().reverse(); for (const f of fs.slice(keep)) rmSync(join(dir, f)); }
