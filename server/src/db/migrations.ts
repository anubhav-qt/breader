import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { log } from '../log.ts';
import { makePool } from './client.ts';
import { repairVersions } from './restored.ts';

/**
 * Where the migrations are, from an entry point's own address (its import.meta.url): drizzle/ beside
 * src/ in development, and beside dist/ in the image, where each entry point is one bundled file.
 */
export function migrationsBeside(entry: string): string {
  if (process.env.MIGRATIONS_DIR) return process.env.MIGRATIONS_DIR;
  return resolve(dirname(fileURLToPath(entry)), '../drizzle');
}

const LOCK = "hashtext('breader:migrate')";

export interface MigrateOptions {
  ssl?: boolean;
  /**
   * A read copy: its rows are Supabase's, so what a migration changes in them is neither stamped nor
   * logged (Supabase's own changes reach it through the feed), and its version sequence is left alone.
   */
  copy?: boolean;
  /** Where the migrations are (migrationsBeside). */
  folder: string;
}

/**
 * Brings one database to the latest schema. Two at once (after a release, CI and the laptop both
 * migrate Supabase) take turns: the second waits on the lock, then finds nothing left to do.
 * Session locks need a session: use the session pooler, not port 6543.
 */
export async function migrateDb(url: string, name: string, opts: MigrateOptions) {
  const pool = makePool(url, { max: 2, name: `migrate-${name}`, ssl: opts.ssl, replay: opts.copy });
  const lock = await pool.connect();
  try {
    await lock.query(`SELECT pg_advisory_lock(${LOCK})`);
    await migrate(drizzle(pool), { migrationsFolder: opts.folder });
    if (!opts.copy) await repairVersions(pool);
    await lock.query(`SELECT pg_advisory_unlock(${LOCK})`);
  } finally {
    lock.release();
    await pool.end();
  }
  log.info(`${name} migrated`);
}
