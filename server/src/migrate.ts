import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { makePool } from './db/client.ts';
import { repairVersions } from './db/restored.ts';
import { loadEnv } from './env.ts';
import { makeStorage } from './lib/storage.ts';
import { log } from './log.ts';

/*
 * Brings Supabase (PRIMARY_URL) and, when MIRROR_URL is set, the laptop's copy to the latest
 * schema. Needs only the database URLs, so CI can run it with nothing else. Migrations only ever
 * expand (new tables, nullable columns); removals ship later as their own step, once no running
 * server reads the old shape. Runs from src/ in development and dist/ in the image.
 */
const migrationsFolder = process.env.MIGRATIONS_DIR ?? resolve(dirname(fileURLToPath(import.meta.url)), '../drizzle');

const LOCK = "hashtext('breader:migrate')";

async function run(url: string, name: string, opts: { ssl?: boolean; replica?: boolean } = {}) {
  const pool = makePool(url, { max: 2, name: `migrate-${name}`, ...opts });
  // After a release, CI and the laptop both migrate Supabase. The second waits here, then finds
  // nothing left to do. (Session locks need a session: use the session pooler, not port 6543.)
  const lock = await pool.connect();
  try {
    await lock.query(`SELECT pg_advisory_lock(${LOCK})`);
    await migrate(drizzle(pool), { migrationsFolder });
    if (!opts.replica) await repairVersions(pool);
    await lock.query(`SELECT pg_advisory_unlock(${LOCK})`);
  } finally {
    lock.release();
    await pool.end();
  }
  log.info(`${name} migrated`);
}

const { PRIMARY_URL, PRIMARY_SSL, MIRROR_URL, S3_CREATE_BUCKETS } = process.env;
if (!PRIMARY_URL) throw new Error('PRIMARY_URL is required');
await run(PRIMARY_URL, 'primary', { ssl: PRIMARY_SSL === 'require' });
if (MIRROR_URL) await run(MIRROR_URL, 'mirror', { replica: true });

if (S3_CREATE_BUCKETS === 'true') {
  const env = loadEnv();
  await makeStorage(env).ensureBuckets(env.ALLOWED_ORIGINS);
  log.info('buckets ready');
}
