import pg from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema.ts';
import type { Env } from '../env.ts';
import { log } from '../log.ts';

export type Db = NodePgDatabase<typeof schema>;

// Postgres bigint and numeric come back as strings by default; every bigint here fits a JS number.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));

export function makePool(url: string, opts: { ssl?: boolean; max?: number; name: string; replica?: boolean }) {
  const pool = new pg.Pool({
    connectionString: url,
    max: opts.max ?? 5,
    // Supabase's pooler presents a certificate for its own domain; the connection is still encrypted.
    ssl: opts.ssl ? { rejectUnauthorized: false } : undefined,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    application_name: `breader-${opts.name}`,
    // The copy replays rows exactly as Supabase wrote them: no change-log triggers, no FK checks.
    options: opts.replica ? '-c session_replication_role=replica' : undefined,
  });
  pool.on('error', (err) => log.warn({ err, pool: opts.name }, 'idle database connection failed'));
  return pool;
}

export function connectPrimary(env: Env, max = 5) {
  const pool = makePool(env.PRIMARY_URL, { ssl: env.PRIMARY_SSL === 'require', max, name: 'primary' });
  return { pool, db: drizzle(pool, { schema }) };
}

export function connectMirror(env: Env, max = 3) {
  if (!env.MIRROR_URL) return null;
  const pool = makePool(env.MIRROR_URL, { max, name: 'mirror', replica: true });
  return { pool, db: drizzle(pool, { schema }) };
}
