import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0', ''])
  .transform((v) => v === 'true' || v === '1');
const list = z.string().transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean));

const Env = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /** laptop: the home server, with the mirror. fallback: the free-tier copy that only knows Supabase. */
  ROLE: z.enum(['laptop', 'fallback']).default('laptop'),
  PORT: z.coerce.number().int().default(8787),
  RELEASE: z.string().default('dev'),

  /** Supabase (through its session pooler, which works over IPv4). Every write goes here first. */
  PRIMARY_URL: z.string().min(1),
  /** off for local Docker; require for Supabase. */
  PRIMARY_SSL: z.enum(['off', 'require']).default('off'),
  /** The laptop's copy. Unset on the fallback. */
  MIRROR_URL: z.string().optional(),

  /** Secret mixed into the key HMAC. Changing it makes every stored key hash unusable. */
  KEY_PEPPER: z.string().min(32),
  /** Signs session cookies. Must match between the laptop and the fallback. */
  SESSION_SECRET: z.string().min(32),
  /** The parent domain (breader.example) so api. and fb. share the session. Unset for localhost. */
  COOKIE_DOMAIN: z.string().optional(),
  COOKIE_SECURE: bool.default(true),
  ALLOWED_ORIGINS: list.default([]),
  /**
   * Where the reader's address comes from, for rate limits. Only a header the proxy in front sets
   * itself can be trusted: cf-connecting-ip behind Cloudflare (the tunnel, and Render's edge), the
   * right-most x-forwarded-for entry behind one proxy that appends it. Not x-forwarded-for on Render:
   * its last entry is Render's internal proxy. none: the connection's own address, for local
   * development. Anything else lets a script pick its own address.
   */
  CLIENT_IP_HEADER: z.enum(['none', 'cf-connecting-ip', 'x-forwarded-for']).default('none'),
  /** Opens /admin, the status page. The page is off without it. */
  ADMIN_TOKEN: z.string().min(32).optional(),
  /** Sentry project DSN. Errors are only logged without it. */
  SENTRY_DSN: z.string().url().optional(),

  /**
   * Accounts (src/auth.ts). PUBLIC_URL is this server's own address (https://api.… on the laptop,
   * https://fb.… on Render): Google sends readers back to it after they log in. APP_URL is the
   * app, for links in emails; it defaults to the first ALLOWED_ORIGINS entry.
   */
  PUBLIC_URL: z.string().url().optional(),
  APP_URL: z.string().url().optional(),
  /** Log in with Google. Off without both. */
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  /** Account emails through Resend. Without it the links are logged instead of sent. */
  RESEND_API_KEY: z.string().optional(),
  MAIL_FROM: z.string().default('breader <hello@breader.site>'),

  S3_ENDPOINT: z.string().url(),
  /** The endpoint browsers use for signed links, when it differs (Docker: http://localhost:9000). */
  S3_PUBLIC_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().default('auto'),
  S3_BUCKET: z.string().min(1),
  S3_BACKUP_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_FORCE_PATH_STYLE: bool.default(true),
  /** Local stand-ins only: create buckets and their CORS rules on start. */
  S3_CREATE_BUCKETS: bool.default(false),

  /** Worker: where the laptop keeps its copy of every file, and its backups. */
  FILES_DIR: z.string().default('/data/files'),
  BACKUP_DIR: z.string().default('/data/backups'),
  /** age public key (age1…) that backups are encrypted to. Backups are off without it. */
  BACKUP_RECIPIENT: z.string().optional(),
  /** Uptime monitor heartbeat URL. The worker calls it every 5 minutes while the copy is current. */
  HEARTBEAT_URL: z.string().url().optional(),
});

export type Env = z.infer<typeof Env>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  // A blank line in .env (HEARTBEAT_URL=) means "not set".
  const parsed = Env.safeParse(Object.fromEntries(Object.entries(source).filter(([, v]) => v !== '')));
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment:\n${problems}`);
  }
  return parsed.data;
}
