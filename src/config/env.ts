import { z } from 'zod';
const bool = (d = false) => z.string().optional().transform((v) => (v === undefined ? d : v === 'true'));
export const EnvSchema = z.object({
  DB_PATH: z.string().default('./data/outreach.sqlite'), AUTH_STATE_DIR: z.string().default('./data/auth_state'), BACKUP_DIR: z.string().default('./data/backups'), LOG_LEVEL: z.string().default('info'),
  SEND_ENABLED: bool(false), AUTO_REPLY: z.string().default('off'),
  CRM_URL: z.string().default(''), CRM_OUTREACH_KEY: z.string().default(''),
  GOOGLE_PLACES_API_KEY: z.string().default(''), ANTHROPIC_API_KEY: z.string().default(''), ANTHROPIC_MODEL: z.string().default('claude-sonnet-5-5'),
  TELEGRAM_BOT_TOKEN: z.string().default(''), TELEGRAM_OWNER_ID: z.string().default(''),
  ADMIN_PORT: z.coerce.number().default(8080), ADMIN_BASIC_TOKEN: z.string().default(''), BACKUP_PASSPHRASE: z.string().default('')
});
export type Env = z.infer<typeof EnvSchema>;
/** Which external pieces are configured. Anything missing falls back to a SAFE stand-in (never a live send). */
export function readiness(e: Env) { return { crm: !!(e.CRM_URL && e.CRM_OUTREACH_KEY), places: !!e.GOOGLE_PLACES_API_KEY, ai: !!e.ANTHROPIC_API_KEY, telegram: !!(e.TELEGRAM_BOT_TOKEN && e.TELEGRAM_OWNER_ID), admin: e.ADMIN_BASIC_TOKEN.length >= 24, backups: e.BACKUP_PASSPHRASE.length >= 12 }; }
