import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrationsBeside } from '../src/db/migrations.ts';
import { holdLease } from '../src/jobs/lease.ts';
import { connectCopyAt, type Copy } from '../src/mirror/copy.ts';
import { feedEvery, heardFrom, makeStandby, sayUp } from '../src/mirror/standby.ts';
import { primary } from './helpers.ts';

/*
 * The standby on GCP: it feeds every read copy while the ThinkPad is quiet, and hands back as soon
 * as the ThinkPad is heard from. Two copies, each a plain user's own database.
 */
const FOLDER = migrationsBeside(new URL('../src/api.ts', import.meta.url).href);
const ADMIN = 'postgres://breader:breader@localhost:54333/postgres';
const LAPTOP = 'test-laptop';
const GCP = 'test-gcp';
const NAMES = ['standby_a', 'standby_b'];

let copies: Copy[] = [];

async function asAdmin(...sqls: string[]) {
  const admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  for (const s of sqls) await admin.query(s);
  await admin.end();
}

async function plainCopy(name: string): Promise<Copy> {
  await asAdmin(
    `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`,
    `DROP ROLE IF EXISTS ${name}`,
    `CREATE ROLE ${name} LOGIN PASSWORD 'standby-pass' NOSUPERUSER NOCREATEDB NOCREATEROLE`,
    `CREATE DATABASE ${name} OWNER ${name}`,
  );
  return connectCopyAt(`postgres://${name}:standby-pass@localhost:54333/${name}`, false, 2, `test-${name}`);
}

/** The laptop went quiet a while ago, and its lease ran out. */
async function laptopQuiet() {
  await primary.pool.query(`UPDATE worker_seen SET at = now() - interval '5 minutes' WHERE machine = $1`, [LAPTOP]);
  await primary.pool.query(`UPDATE worker_lease SET until = now() - interval '1 second' WHERE holder = $1`, [LAPTOP]);
}

async function hasLibrary(copy: Copy, id: string): Promise<boolean> {
  try {
    const { rowCount } = await copy.pool.query('SELECT 1 FROM libraries WHERE id = $1', [id]);
    return (rowCount ?? 0) > 0;
  } catch {
    return false;
  }
}

async function until(check: () => Promise<boolean>, ms = 60_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('waited too long');
}

const standbyWith = (held?: () => Promise<boolean>) =>
  makeStandby({
    primary: primary.pool,
    machine: GCP,
    standsFor: LAPTOP,
    feed: (signal) => feedEvery(primary.pool, copies, FOLDER, signal),
    held,
  });

beforeAll(async () => {
  copies = await Promise.all(NAMES.map(plainCopy));
  await primary.pool.query('DELETE FROM worker_lease');
}, 60_000);

afterAll(async () => {
  for (const c of copies) await c.pool.end();
  await primary.pool.query('DELETE FROM worker_lease');
  await primary.pool.query('DELETE FROM worker_seen WHERE machine = ANY($1)', [[LAPTOP, GCP]]);
  await primary.pool.query('DELETE FROM feed_copies WHERE name = ANY($1)', [NAMES.map((n) => `test-${n}`)]);
  for (const n of NAMES) await asAdmin(`DROP DATABASE IF EXISTS ${n} WITH (FORCE)`, `DROP ROLE IF EXISTS ${n}`);
}, 60_000);

describe('the standby', () => {
  it('stands by while the ThinkPad is heard from and holds the lease', async () => {
    await sayUp(primary.pool, LAPTOP);
    expect(await holdLease(primary.pool, LAPTOP)).toBe(true);
    const standby = standbyWith();
    expect(await standby.check()).toBe('standing by');
    expect(standby.feeding()).toBe(false);
  });

  it('waits for the ThinkPad’s lease to run out, even once it’s quiet', async () => {
    await primary.pool.query(`UPDATE worker_seen SET at = now() - interval '5 minutes' WHERE machine = $1`, [LAPTOP]);
    expect(await holdLease(primary.pool, LAPTOP)).toBe(true);
    const standby = standbyWith();
    expect(await standby.check()).toBe('standing by');
    expect(standby.feeding()).toBe(false);
  });

  it('takes over feeding every copy when the ThinkPad goes quiet, and hands back when it’s heard from', async () => {
    await laptopQuiet();
    const standby = standbyWith();
    expect(await standby.check()).toBe('standing in');
    expect(standby.feeding()).toBe(true);
    const library = `standby-${crypto.randomUUID()}`;
    await primary.pool.query('INSERT INTO libraries (id, quota_bytes, file_bytes) VALUES ($1, 0, 0)', [library]);
    for (const c of copies) await until(() => hasLibrary(c, library));
    // Checked again: still standing in, still the lease's holder.
    expect(await standby.check()).toBe('standing in');
    expect(await holdLease(primary.pool, LAPTOP)).toBe(false);

    // The ThinkPad's worker starts again: it says it's up before asking for the lease.
    await sayUp(primary.pool, LAPTOP);
    expect(await holdLease(primary.pool, LAPTOP)).toBe(false);
    expect(await standby.check()).toBe('standing by');
    expect(standby.feeding()).toBe(false);
    expect(await holdLease(primary.pool, LAPTOP)).toBe(true);
    // Fed no more from here: a new row stays off the copies.
    const later = `standby-${crypto.randomUUID()}`;
    await primary.pool.query('INSERT INTO libraries (id, quota_bytes, file_bytes) VALUES ($1, 0, 0)', [later]);
    await new Promise((r) => setTimeout(r, 2000));
    for (const c of copies) expect(await hasLibrary(c, later)).toBe(false);
  }, 120_000);

  it('never stands in while it’s held back (near its egress limit), and lets the lease go', async () => {
    await laptopQuiet();
    let near = false;
    const standby = standbyWith(async () => near);
    expect(await standby.check()).toBe('standing in');
    near = true;
    expect(await standby.check()).toBe('standing by');
    expect(standby.feeding()).toBe(false);
    expect(await holdLease(primary.pool, LAPTOP)).toBe(true);
  }, 120_000);

  it('lets the lease go as it stops', async () => {
    await laptopQuiet();
    const standby = standbyWith();
    expect(await standby.check()).toBe('standing in');
    await standby.stop();
    expect(standby.feeding()).toBe(false);
    expect(await holdLease(primary.pool, LAPTOP)).toBe(true);
  }, 120_000);

  it('hears from a machine only within the time given', async () => {
    await sayUp(primary.pool, GCP);
    expect(await heardFrom(primary.pool, GCP, 60)).toBe(true);
    await primary.pool.query(`UPDATE worker_seen SET at = now() - interval '2 minutes' WHERE machine = $1`, [GCP]);
    expect(await heardFrom(primary.pool, GCP, 60)).toBe(false);
  });
});
