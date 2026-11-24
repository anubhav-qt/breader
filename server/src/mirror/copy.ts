import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { makePool } from '../db/client.ts';
import type { Db } from '../db/client.ts';
import { migrateDb } from '../db/migrations.ts';
import * as schema from '../db/schema.ts';
import type { Env } from '../env.ts';
import { log } from '../log.ts';
import { makeFeed } from './feed.ts';

/*
 * A server's read copy (ADR 0001, point 5): any Postgres in any region, COPY_URL. Each server that
 * has one migrates it as it starts and reads from it what may come from a copy (db/reads.ts).
 * PRIMARY_URL stays the only writer. Servers may share a copy: whichever holds the copy's feed lock
 * keeps it current, and when that one stops, another takes over within HOLD_AGAIN.
 */

export interface Copy {
  db: Db;
  pool: pg.Pool;
  /** This copy's name in feed_copies. */
  name: string;
  url: string;
  ssl: boolean;
}

/** The copy's feed lock: one feeder per copy. */
export const FEED_LOCK = 'hashtext(\'breader.feed\')';
/** How often a server that isn't feeding its copy asks whether it may. */
const HOLD_AGAIN = 30_000;

/** A copy's name in feed_copies, from its address without the password: who connects, where, to which database. */
export function copyName(url: string): string {
  const u = new URL(url);
  const user = decodeURIComponent(u.username);
  const db = u.pathname.replace(/^\//, '') || 'postgres';
  return `${user}@${u.hostname}/${db}`;
}

/** This server's read copy, or null where it has none (COPY_URL unset). */
export function connectCopy(env: Env, max = 4): Copy | null {
  if (!env.COPY_URL) return null;
  const ssl = env.COPY_SSL === 'require';
  const pool = makePool(env.COPY_URL, { max, name: 'copy', ssl, replay: true });
  const name = env.COPY_NAME ?? copyName(env.COPY_URL);
  return { pool, db: drizzle(pool, { schema }), name, url: env.COPY_URL, ssl };
}

/**
 * The copy's feed lock, held on a connection of its own while this server feeds the copy; null
 * when another server holds it.
 */
export async function holdFeed(pool: pg.Pool): Promise<pg.PoolClient | null> {
  const client = await pool.connect();
  try {
    const { rows } = await client.query<{ held: boolean }>(`SELECT pg_try_advisory_lock(${FEED_LOCK}) AS held`);
    if (rows[0]?.held) return client;
  } catch (err) {
    client.release(true);
    throw err;
  }
  client.release();
  return null;
}

function wait(ms: number, signal: AbortSignal) {
  return new Promise<void>((done) => {
    const t = setTimeout(done, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      done();
    }, { once: true });
  });
}

/**
 * Makes every foreign key on the copy wait for the end of its transaction, and returns how many
 * changed. The feed replays records in the order the primary gave out transaction ids, not the
 * order they were committed in, so within a batch a child can come before its parent, or (just
 * after a reload) a row can come back a moment before the record that removed it. At the end of
 * each batch the copy matches the primary, so the check holds there. The tables' owner may do this;
 * it needs no superuser. Run after every migration, as a new key starts out checked at once.
 */
export async function deferKeys(pool: pg.Pool): Promise<number> {
  const { rows } = await pool.query<{ sql: string }>(
    `SELECT format('ALTER TABLE %s ALTER CONSTRAINT %I DEFERRABLE INITIALLY DEFERRED', c.conrelid::regclass, c.conname) AS sql
     FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
     WHERE c.contype = 'f' AND n.nspname = 'public' AND NOT (c.condeferrable AND c.condeferred)`,
  );
  for (const r of rows) await pool.query(r.sql);
  return rows.length;
}

/** Brings the copy to the latest schema, its foreign keys checked as each batch ends (deferKeys). */
export async function readyCopy(copy: Copy, folder: string) {
  await migrateDb(copy.url, 'copy', { ssl: copy.ssl, copy: true, folder });
  const deferred = await deferKeys(copy.pool);
  if (deferred > 0) log.info({ copy: copy.name, deferred }, 'the read copy’s foreign keys now wait for the end of each batch');
}

/**
 * Brings the copy to the latest schema, then keeps it current whenever this server holds its feed
 * lock, until `signal` aborts. A copy that can't be migrated isn't fed, and reads stay on
 * PRIMARY_URL (db/reads.ts sees it never caught up).
 */
export async function runCopy(primary: pg.Pool, copy: Copy, folder: string, signal: AbortSignal) {
  try {
    await readyCopy(copy, folder);
  } catch (err) {
    log.error({ err, copy: copy.name }, 'couldn’t migrate the read copy, so it isn’t fed and reads stay on the primary');
    return;
  }
  const feed = makeFeed(primary, copy.pool, { name: copy.name });
  while (!signal.aborted) {
    let holder: pg.PoolClient | null = null;
    try {
      holder = await holdFeed(copy.pool);
    } catch (err) {
      log.warn({ err, copy: copy.name }, 'couldn’t ask for the read copy’s feed lock');
    }
    if (!holder) {
      await wait(HOLD_AGAIN, signal);
      continue;
    }
    await feedWhileHeld(feed, holder, copy.name, signal);
  }
}

/** Feeds the copy until `signal` aborts or the lock's connection is lost, then lets the lock go. */
async function feedWhileHeld(feed: ReturnType<typeof makeFeed>, holder: pg.PoolClient, name: string, signal: AbortSignal) {
  const held = new AbortController();
  const stop = () => held.abort();
  signal.addEventListener('abort', stop, { once: true });
  holder.on('error', stop);
  holder.on('end', stop);
  log.info({ copy: name }, 'feeding the read copy');
  try {
    await feed.run(held.signal);
  } finally {
    signal.removeEventListener('abort', stop);
    holder.removeListener('error', stop);
    holder.removeListener('end', stop);
    // Destroyed, not returned: its session holds the lock.
    holder.release(true);
  }
  if (!signal.aborted) log.warn({ copy: name }, 'lost the read copy’s feed lock; asking again');
}
