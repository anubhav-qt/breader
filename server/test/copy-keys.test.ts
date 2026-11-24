import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makePool } from '../src/db/client.ts';
import { migrateDb, migrationsBeside } from '../src/db/migrations.ts';
import { FED_TABLES } from '../src/db/schema.ts';
import { loadEnv } from '../src/env.ts';
import { connectCopy, readyCopy, type Copy } from '../src/mirror/copy.ts';
import { makeFeed } from '../src/mirror/feed.ts';
import { primary } from './helpers.ts';
import { testEnv } from './env.ts';

/*
 * A read copy on a hosted Postgres (Neon, say), and a primary on any Postgres: each reached as a
 * plain user that owns its database and is no superuser. The copy's foreign keys stay on, so the feed
 * must never leave a child without its parent at the end of a batch.
 */
const FOLDER = migrationsBeside(new URL('../src/api.ts', import.meta.url).href);
const MIRROR_ADMIN = 'postgres://breader:breader@localhost:54333/postgres';
const PRIMARY_ADMIN = testEnv.PRIMARY_URL.replace(/\/breader_test$/, '/postgres');
const COPY_URL = 'postgres://breader_keys:keys-pass@localhost:54333/breader_keys_test';
const NAME = 'test-keys';

let copy: Copy;

async function asAdmin(url: string, ...sqls: string[]) {
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  for (const s of sqls) await admin.query(s);
  await admin.end();
}

/** A plain role that owns a fresh database of its own, on the server `admin` reaches. */
async function plainDatabase(admin: string, role: string, db: string) {
  await asAdmin(
    admin,
    `DROP DATABASE IF EXISTS ${db} WITH (FORCE)`,
    `DROP ROLE IF EXISTS ${role}`,
    `CREATE ROLE ${role} LOGIN PASSWORD 'keys-pass' NOSUPERUSER NOCREATEDB NOCREATEROLE`,
    `CREATE DATABASE ${db} OWNER ${role}`,
  );
  const url = new URL(admin);
  url.username = role;
  url.password = 'keys-pass';
  url.pathname = `/${db}`;
  return url.toString();
}

async function dropPlain(admin: string, role: string, db: string) {
  await asAdmin(admin, `DROP DATABASE IF EXISTS ${db} WITH (FORCE)`, `DROP ROLE IF EXISTS ${role}`);
}

async function drain(feed: ReturnType<typeof makeFeed>) {
  for (let i = 0; i < 50; i++) {
    if ((await feed.step()) === 0) return;
  }
  throw new Error('feed did not settle');
}

async function loadedAt(pool: pg.Pool): Promise<number> {
  const { rows } = await pool.query<{ at: Date }>('SELECT loaded_at AS at FROM mirror_state WHERE id = 1');
  return rows[0].at.getTime();
}

async function settingsOn(pool: pg.Pool, library: string): Promise<number> {
  const { rowCount } = await pool.query('SELECT 1 FROM library_settings WHERE library_id = $1', [library]);
  return rowCount ?? 0;
}

const newLibrary = () => `keys-${crypto.randomUUID()}`;

beforeAll(async () => {
  await plainDatabase(MIRROR_ADMIN, 'breader_keys', 'breader_keys_test');
  const env = loadEnv({ ...testEnv, ROLE: 'fallback', COPY_URL, COPY_NAME: NAME, COPY_SSL: 'off' });
  copy = connectCopy(env)!;
  await readyCopy(copy, FOLDER);
}, 60_000);

afterAll(async () => {
  await copy.pool.end();
  await primary.pool.query('DELETE FROM feed_copies WHERE name = $1', [NAME]);
  await dropPlain(MIRROR_ADMIN, 'breader_keys', 'breader_keys_test');
}, 60_000);

describe('fed tables and their foreign keys', () => {
  it('lists every table after the fed tables it points to, and points only at fed tables', async () => {
    const { rows } = await primary.pool.query<{ child: string; parent: string }>(
      `SELECT conrelid::regclass::text AS child, confrelid::regclass::text AS parent FROM pg_constraint WHERE contype = 'f'`,
    );
    const order: string[] = Object.keys(FED_TABLES);
    const fed = rows.filter((r) => order.includes(r.child));
    expect(fed.length).toBeGreaterThan(0);
    for (const r of fed) {
      expect(order, `${r.child} points at ${r.parent}`).toContain(r.parent);
      expect(order.indexOf(r.parent), `${r.parent} before ${r.child}`).toBeLessThan(order.indexOf(r.child));
    }
  });
});

describe('a copy on a plain role with its foreign keys on', () => {
  const feed = () => makeFeed(primary.pool, copy.pool, { name: NAME });

  it('is migrated by a user that is no superuser, every foreign key checked as a batch ends', async () => {
    const { rows: [who] } = await copy.pool.query<{ su: boolean }>('SELECT rolsuper AS su FROM pg_roles WHERE rolname = current_user');
    expect(who.su).toBe(false);
    const { rows } = await copy.pool.query<{ name: string; deferred: boolean }>(
      `SELECT conname AS name, condeferrable AND condeferred AS deferred FROM pg_constraint WHERE contype = 'f'`,
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.deferred, r.name).toBe(true);
  });

  it('loads every fed table from the primary, parents before children', async () => {
    const f = feed();
    await drain(f);
    for (const t of Object.keys(FED_TABLES)) {
      const { rows: [p] } = await primary.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t}`);
      const { rows: [c] } = await copy.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t}`);
      expect(c.n, t).toBe(p.n);
    }
  });

  it('takes a child whose transaction began before its parent’s, without loading afresh', async () => {
    const f = feed();
    await drain(f);
    const before = await loadedAt(copy.pool);
    const library = newLibrary();
    // The child's transaction gets its id first, then the parent is made and committed, then the
    // child goes in: in the feed's order (transaction ids), the child comes first.
    const early = await primary.pool.connect();
    try {
      await early.query('BEGIN');
      await early.query('SELECT pg_current_xact_id()');
      await primary.pool.query('INSERT INTO libraries (id, quota_bytes, file_bytes) VALUES ($1, 0, 0)', [library]);
      await early.query('INSERT INTO library_settings (library_id, rev) VALUES ($1, 0)', [library]);
      await early.query('COMMIT');
    } finally {
      early.release();
    }
    const { rows } = await primary.pool.query<{ tbl: string }>(
      `SELECT tbl FROM change_log WHERE pk->>'id' = $1 OR pk->>'library_id' = $1 ORDER BY txid, id`,
      [library],
    );
    expect(rows.map((r) => r.tbl)).toEqual(['library_settings', 'libraries']);
    await drain(f);
    expect(await settingsOn(copy.pool, library)).toBe(1);
    expect(await loadedAt(copy.pool)).toBe(before);
  });

  it('replays a child whose parent was gone when the copy loaded, without loading afresh', async () => {
    const f = feed();
    const library = newLibrary();
    await primary.pool.query('INSERT INTO libraries (id, quota_bytes, file_bytes) VALUES ($1, 0, 0)', [library]);
    await drain(f);
    // A transaction still open holds the feed's starting point back, so the reload below starts
    // before the child and the removal that follow, though its snapshot has neither.
    const open = await primary.pool.connect();
    let loaded = 0;
    try {
      await open.query('BEGIN');
      await open.query('SELECT pg_current_xact_id()');
      await primary.pool.query('INSERT INTO library_settings (library_id, rev) VALUES ($1, 0)', [library]);
      await primary.pool.query('DELETE FROM libraries WHERE id = $1', [library]);
      await f.reload();
      loaded = await loadedAt(copy.pool);
      await open.query('COMMIT');
    } finally {
      open.release();
    }
    await drain(f);
    expect(await settingsOn(copy.pool, library)).toBe(0);
    expect(await loadedAt(copy.pool)).toBe(loaded);
  });

  it('loads afresh, rather than sticking, when a child’s parent is a batch away', async () => {
    const f = feed();
    await drain(f);
    const before = await loadedAt(copy.pool);
    const { rows: [at] } = await copy.pool.query<{ txid: number }>('SELECT cursor_txid AS txid FROM mirror_state WHERE id = 1');
    // A child record whose parent's record is not in this batch.
    const orphan = newLibrary();
    const { rows: [record] } = await primary.pool.query<{ id: number }>(
      `INSERT INTO change_log (txid, tbl, pk, op, row, version) VALUES ($1, 'library_settings', $2, 'I', $3, 1) RETURNING id`,
      [at.txid, { library_id: orphan }, { library_id: orphan, prefs: {}, rev: 0, version: 1 }],
    );
    try {
      await f.step();
      expect(await loadedAt(copy.pool)).toBeGreaterThan(before);
      expect(await settingsOn(copy.pool, orphan)).toBe(0);
      await drain(f);
    } finally {
      await primary.pool.query('DELETE FROM change_log WHERE id = $1', [record.id]);
    }
  });
});

describe('a primary on a plain role', () => {
  it('migrates, stamps and logs its writes, and feeds a copy, with no superuser at either end', async () => {
    const primaryUrl = await plainDatabase(PRIMARY_ADMIN, 'breader_plain', 'breader_plain_test');
    const copyUrl = await plainDatabase(MIRROR_ADMIN, 'breader_plain_copy', 'breader_plain_copy_test');
    const writer = makePool(primaryUrl, { name: 'plain-primary', max: 2 });
    const env = loadEnv({ ...testEnv, ROLE: 'fallback', COPY_URL: copyUrl, COPY_NAME: 'plain', COPY_SSL: 'off' });
    const reader = connectCopy(env)!;
    try {
      await migrateDb(primaryUrl, 'plain', { folder: FOLDER });
      await readyCopy(reader, FOLDER);
      const library = newLibrary();
      await writer.query('INSERT INTO libraries (id, quota_bytes, file_bytes) VALUES ($1, 0, 0)', [library]);
      await writer.query('INSERT INTO library_settings (library_id, rev) VALUES ($1, 0)', [library]);
      const { rows: logged } = await writer.query<{ tbl: string; version: number }>('SELECT tbl, version FROM change_log ORDER BY id');
      expect(logged.map((r) => r.tbl)).toEqual(['libraries', 'library_settings']);
      for (const r of logged) expect(r.version).toBeGreaterThan(0);
      await drain(makeFeed(writer, reader.pool, { name: 'plain' }));
      expect(await settingsOn(reader.pool, library)).toBe(1);
      const { rows: [kept] } = await writer.query<{ n: number }>("SELECT count(*)::int AS n FROM feed_copies WHERE name = 'plain'");
      expect(kept.n).toBe(1);
    } finally {
      await writer.end();
      await reader.pool.end();
      await dropPlain(PRIMARY_ADMIN, 'breader_plain', 'breader_plain_test');
      await dropPlain(MIRROR_ADMIN, 'breader_plain_copy', 'breader_plain_copy_test');
    }
  }, 120_000);
});
