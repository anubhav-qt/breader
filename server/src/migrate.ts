import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { makePool } from './db/client.ts';
import { FED_TABLES } from './db/schema.ts';
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

/**
 * The laptop's copy never advances the version sequence, so after Supabase is restored from a
 * backup of it, new writes would get versions older than the rows they replace and the copy
 * would ignore them. Moves the sequence past every stamped version. In normal running nothing is
 * ahead of the sequence, so this changes nothing.
 */
async function repairVersions(pool: ReturnType<typeof makePool>) {
  const tables = [...Object.keys(FED_TABLES), 'change_log', 'mirror_tombstones'];
  const { rowCount } = await pool.query(
    `SELECT setval('row_version_seq', m) FROM (SELECT greatest(${tables.map((t) => `(SELECT max(version) FROM ${t})`).join(', ')}) AS m) x
     WHERE m > (SELECT last_value FROM row_version_seq)`,
  );
  if (rowCount) log.warn('moved the version sequence past restored rows');
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
