import { resolve } from 'node:path';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { loadEnv } from '../src/env.ts';
import { makeStorage } from '../src/lib/storage.ts';
import { testEnv } from './env.ts';

/** Fresh test databases on both Postgres servers, migrated, and a test bucket. */
export default async function setup() {
  const env = loadEnv({ ...process.env, ...testEnv });
  for (const url of [env.PRIMARY_URL, env.MIRROR_URL!]) {
    const admin = new pg.Client({ connectionString: url.replace(/\/breader_test$/, '/postgres') });
    await admin.connect();
    await admin.query('DROP DATABASE IF EXISTS breader_test WITH (FORCE)');
    await admin.query('CREATE DATABASE breader_test');
    await admin.end();
    const pool = new pg.Pool({ connectionString: url, max: 1 });
    await migrate(drizzle(pool), { migrationsFolder: resolve(import.meta.dirname, '../drizzle') });
    await pool.end();
  }
  await makeStorage(env).ensureBuckets(env.ALLOWED_ORIGINS);
}
