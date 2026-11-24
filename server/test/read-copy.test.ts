import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeApp } from '../src/app.ts';
import { migrationsBeside } from '../src/db/migrations.ts';
import { makeReads, WROTE } from '../src/db/reads.ts';
import { loadEnv } from '../src/env.ts';
import { connectCopy, copyName, holdFeed, runCopy, type Copy } from '../src/mirror/copy.ts';
import { book, browser, deps, primary, push, registered } from './helpers.ts';
import { testEnv } from './env.ts';

/*
 * A read copy on any Postgres, reached as a user that is no superuser (as on a hosted database):
 * its own database and role on the mirror's server.
 */
const ADMIN_URL = 'postgres://breader:breader@localhost:54333/postgres';
const COPY_URL = 'postgres://breader_copy:copy-pass@localhost:54333/breader_copy_test';
const NAME = 'test-region';

let copy: Copy;
const feeding = new AbortController();
let fed: Promise<void>;

async function asAdmin(...sqls: string[]) {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  for (const s of sqls) await admin.query(s);
  await admin.end();
}

/** Waits until `check` holds, asking every 100 ms, for up to 30 s. */
async function until(check: () => Promise<boolean>) {
  for (let i = 0; i < 300; i++) {
    if (await check()) return;
    await new Promise((ok) => setTimeout(ok, 100));
  }
  throw new Error('never happened');
}

beforeAll(async () => {
  await asAdmin(
    'DROP DATABASE IF EXISTS breader_copy_test WITH (FORCE)',
    'DROP ROLE IF EXISTS breader_copy',
    "CREATE ROLE breader_copy LOGIN PASSWORD 'copy-pass' NOSUPERUSER",
    'CREATE DATABASE breader_copy_test OWNER breader_copy',
  );
  const env = loadEnv({ ...testEnv, ROLE: 'fallback', COPY_URL, COPY_NAME: NAME, COPY_SSL: 'off' });
  copy = connectCopy(env)!;
  fed = runCopy(primary.pool, copy, migrationsBeside(new URL('../src/api.ts', import.meta.url).href), feeding.signal);
  // Migrated and loaded once its place in the feed is kept.
  await until(async () => (await primary.pool.query('SELECT 1 FROM feed_copies WHERE name = $1', [NAME])).rowCount === 1);
}, 60_000);

afterAll(async () => {
  feeding.abort();
  await fed;
  await copy.pool.end();
  await primary.pool.query('DELETE FROM feed_copies WHERE name = $1', [NAME]);
  await asAdmin('DROP DATABASE IF EXISTS breader_copy_test WITH (FORCE)', 'DROP ROLE IF EXISTS breader_copy');
}, 60_000);

describe('copy config', () => {
  it('names a copy by who, where and which database, without the password', () => {
    expect(copyName('postgres://reader.abc:s3cret@db.example.com:5432/postgres')).toBe('reader.abc@db.example.com/postgres');
    expect(copyName('postgres://u:p@h')).toBe('u@h/postgres');
    expect(copyName('postgres://us%40er:p@h/x')).toBe('us@er@h/x');
  });

  it('has a copy only when COPY_URL is set, on any kind of server', () => {
    expect(connectCopy(loadEnv({ ...testEnv }))).toBeNull();
    for (const ROLE of ['laptop', 'fallback']) {
      const c = connectCopy(loadEnv({ ...testEnv, ROLE, COPY_URL }))!;
      expect(c.name).toBe('breader_copy@localhost/breader_copy_test');
      expect(c.ssl).toBe(true);
      void c.pool.end();
    }
  });
});

describe('a read copy', () => {
  it('is migrated and fed by a user that is no superuser, rows exactly as the primary has them', async () => {
    const { b, libraryId } = await registered();
    const a = book();
    await b.post('/v1/sync/push', push('c', { type: 'book.put', book: a }));
    const row = async (pool: pg.Pool) =>
      (await pool.query('SELECT to_jsonb(x) AS r FROM library_items x WHERE library_id = $1 AND book_id = $2', [libraryId, a.id])).rows[0]?.r;
    await until(async () => (await row(copy.pool)) !== undefined);
    expect(await row(copy.pool)).toEqual(await row(primary.pool));
  });

  it('keeps its own place in the feed, by its name, and says when it caught up', async () => {
    const { rows } = await primary.pool.query('SELECT ack_txid FROM feed_copies WHERE name = $1', [NAME]);
    expect(rows).toHaveLength(1);
    await until(async () => {
      const { rows: [s] } = await copy.pool.query('SELECT caught_up_at FROM mirror_state WHERE id = 1');
      return s?.caught_up_at instanceof Date;
    });
  });

  it('logs nothing of its own while replaying', async () => {
    const { rows: [n] } = await copy.pool.query('SELECT count(*)::int AS n FROM change_log');
    expect(n.n).toBe(0);
  });

  it('is fed by one server at a time', async () => {
    // This server feeds it, so another server sharing the copy doesn't get the lock.
    expect(await holdFeed(copy.pool)).toBeNull();
  });
});

describe('reading from a copy', () => {
  it('sends a reader who wrote to the primary for their next reads', async () => {
    const { b } = await registered();
    expect(b.has(WROTE)).toBe(true);
  });

  it('lets the next server feed once the feeder stops', async () => {
    feeding.abort();
    await fed;
    const next = await holdFeed(copy.pool);
    expect(next).not.toBeNull();
    next!.release(true);
  });

  it('lets a reader in whose library the copy hasn’t got yet', async () => {
    // The feed has stopped: the copy is still current (it caught up moments ago), but this
    // library reaches only the primary.
    const { b, libraryId } = await registered();
    const behind = makeApp({ ...deps, reads: makeReads(primary, copy) });
    const reader = browser(undefined, behind);
    const { rows } = await copy.pool.query('SELECT 1 FROM libraries WHERE id = $1', [libraryId]);
    expect(rows).toHaveLength(0);
    const res = await reader.get('/v1/me', { cookie: b.cookie });
    expect(res.status).toBe(200);
  });
});
