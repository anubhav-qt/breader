import { migrateDb, migrationsBeside } from './db/migrations.ts';
import { loadEnv } from './env.ts';
import { startReporting } from './lib/report.ts';
import { makeStorage } from './lib/storage.ts';
import { log } from './log.ts';

/*
 * Brings Supabase (PRIMARY_URL) and, when MIRROR_URL is set, the laptop's copy to the latest
 * schema. Needs only the database URLs, so infra/ship.sh can run it with nothing else. Migrations only ever
 * expand (new tables, nullable columns); removals ship later as their own step, once no running
 * server reads the old shape. Runs from src/ in development and dist/ in the image. A failure
 * goes to Sentry too, as the new API never starts after one. A server's read copy (COPY_URL) is
 * migrated by that server's API as it starts (mirror/copy.ts).
 */
startReporting('migrate');

const folder = migrationsBeside(import.meta.url);
const { PRIMARY_URL, PRIMARY_SSL, MIRROR_URL, S3_CREATE_BUCKETS } = process.env;
if (!PRIMARY_URL) throw new Error('PRIMARY_URL is required');
await migrateDb(PRIMARY_URL, 'primary', { ssl: PRIMARY_SSL === 'require', folder });
if (MIRROR_URL) await migrateDb(MIRROR_URL, 'mirror', { copy: true, folder });

if (S3_CREATE_BUCKETS === 'true') {
  const env = loadEnv();
  await makeStorage(env).ensureBuckets(env.ALLOWED_ORIGINS);
  log.info('buckets ready');
}
