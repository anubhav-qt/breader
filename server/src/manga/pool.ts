import { createHash } from 'node:crypto';
import type pg from 'pg';
import { makeBucket, type BucketStore } from '../lib/bucket.ts';
import { log } from '../log.ts';
import { pictureType, type Picture } from './disk.ts';

/*
 * The storage pool (ADR 0004): readers' chapters in several free buckets on S3-compatible stores,
 * each with its own room (the owner's sizes, POOL_<NAME>_MB), so readers read them from a bucket
 * and its CDN instead of from a server. Built on ADR 0003's layout:
 *
 * - c/<key>/<n>         a page, in the bucket that holds the chapter
 * - c/<key>/index.json  { pages, base }, always in the first bucket (the home, R2 at
 *                       pages.breader.site), put last; `base` is the public address of the bucket
 *                       with the pages. The app asks the home for the index, then `base` for pages.
 * - s/<key>/chapters.json  a Suwayomi series' list, in the home (cloud.ts)
 *
 * pool_chapters says which bucket holds each chapter, and is where the room is counted: a row is
 * made (under a lock) before the pages go, so no bucket goes past its room and no chapter is put
 * twice, from any server. Every other bucket on a bucket's account counts against its room too,
 * measured once a day. Chapters the pool lets go are gone from it; the ThinkPad keeps them on disk.
 */

const MB = 1024 * 1024;
const MEASURE_EVERY = 24 * 3600_000;
/** A row not done this long after it was made is from a server that stopped mid-chapter. */
const STALE_MS = 3600_000;
/** How long where a chapter is, or that it isn't anywhere, is remembered. */
const REMEMBER_MS = 60_000;
const REMEMBER_MAX = 5000;
const FETCH_MS = 10_000;
const LOCK = "hashtext('breader.pool')";

export interface Member {
  name: string;
  store: BucketStore;
  /** Its public address, through Cloudflare (R2) or CloudFront (the others). */
  base: string;
  /** Its room in bytes, every other bucket on its account included. */
  budget: number;
  /** Writes it may take in a month; null for no limit (only where the owner set one). */
  writes: number | null;
}

export const poolKey = (id: string) => createHash('sha256').update(id).digest('hex').slice(0, 32);
const month = (now: number) => new Date(now).toISOString().slice(0, 7);
const json = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));

/** A name as it appears in env: r2 → R2, my-b2 → MY_B2. */
const envName = (name: string) => name.toUpperCase().replace(/[^A-Z0-9]/g, '_');

function required(raw: Record<string, string | undefined>, key: string): string {
  const v = raw[key];
  if (!v) throw new Error(`${key} is needed for the storage pool`);
  return v;
}

function memberFrom(raw: Record<string, string | undefined>, name: string): Member {
  const p = `POOL_${envName(name)}_`;
  const mb = Number(required(raw, `${p}MB`));
  if (!Number.isFinite(mb) || mb <= 0) throw new Error(`${p}MB must be a number of megabytes`);
  let writes: number | null = null;
  if (raw[`${p}WRITES`]) writes = Number(raw[`${p}WRITES`]);
  const base = required(raw, `${p}PUBLIC_URL`).replace(/\/+$/, '');
  const store = makeBucket({
    endpoint: required(raw, `${p}ENDPOINT`),
    region: raw[`${p}REGION`] || 'auto',
    bucket: required(raw, `${p}BUCKET`),
    keyId: required(raw, `${p}KEY_ID`),
    secret: required(raw, `${p}SECRET`),
    pathStyle: raw[`${p}PATH_STYLE`] === 'true',
  });
  return { name, store, base, budget: mb * MB, writes };
}

/**
 * The pool's buckets from env: POOL_MEMBERS, the home first, each with its own POOL_<NAME>_*
 * settings. Empty when POOL_MEMBERS isn't set: no pool.
 */
export function poolMembers(raw: Record<string, string | undefined>): Member[] {
  const names = (raw.POOL_MEMBERS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return names.map((n) => memberFrom(raw, n));
}

export type PutResult = 'put' | 'had' | 'full' | 'capped';

export interface Where {
  member: Member;
  pages: number;
  key: string;
}

export interface PoolOptions {
  db: Pick<pg.Pool, 'query' | 'connect'>;
  members: Member[];
  now?: () => number;
  fetch?: typeof fetch;
}

interface Row {
  key: string;
  chapter: string;
  bucket: string;
  pages: number;
  bytes: number;
}

export function makePool(opts: PoolOptions) {
  const { db } = opts;
  const now = opts.now ?? Date.now;
  const fetchFn = opts.fetch ?? fetch;
  const members = opts.members;
  if (!members.length) throw new Error('the storage pool needs at least one bucket in POOL_MEMBERS');
  const home = members[0];
  const byName = new Map(opts.members.map((m) => [m.name, m]));
  const remembered = new Map<string, { where: Where | null; at: number }>();

  function remember(chapterId: string, where: Where | null) {
    if (remembered.size >= REMEMBER_MAX) remembered.clear();
    remembered.set(chapterId, { where, at: now() });
  }

  /** Where a whole chapter is, or null. */
  async function find(chapterId: string): Promise<Where | null> {
    const had = remembered.get(chapterId);
    if (had && now() - had.at < REMEMBER_MS) return had.where;
    const key = poolKey(chapterId);
    const { rows } = await db.query<Row>('SELECT key, bucket, pages FROM pool_chapters WHERE key = $1 AND done', [key]);
    let where: Where | null = null;
    const member = rows[0] ? byName.get(rows[0].bucket) : undefined;
    if (member) where = { member, pages: rows[0].pages, key };
    remember(chapterId, where);
    return where;
  }

  /** Each bucket's room left, in bytes: its budget, less what it holds and its account's other buckets. */
  async function roomOf(q: Pick<pg.Pool, 'query'>): Promise<Map<string, number>> {
    const { rows: used } = await q.query<{ bucket: string; bytes: number }>('SELECT bucket, sum(bytes)::bigint AS bytes FROM pool_chapters GROUP BY bucket');
    const { rows: others } = await q.query<{ name: string; others: number }>('SELECT name, others FROM pool_buckets');
    const room = new Map<string, number>();
    for (const m of members) {
      let left = m.budget;
      for (const u of used) if (u.bucket === m.name) left -= u.bytes;
      for (const o of others) if (o.name === m.name) left -= o.others;
      room.set(m.name, left);
    }
    return room;
  }

  /** Takes `n` of a bucket's writes this month, or false when its limit would be passed. */
  async function takeWrites(m: Member, n: number): Promise<boolean> {
    const at = month(now());
    await db.query('INSERT INTO pool_buckets (name) VALUES ($1) ON CONFLICT DO NOTHING', [m.name]);
    const { rowCount } = await db.query(
      `UPDATE pool_buckets SET writes = CASE WHEN month = $2 THEN writes + $3 ELSE $3 END, month = $2
       WHERE name = $1 AND ($4::int IS NULL OR CASE WHEN month = $2 THEN writes + $3 ELSE $3 END <= $4)`,
      [m.name, at, n, m.writes],
    );
    return (rowCount ?? 0) > 0;
  }

  /**
   * Makes the chapter's row in the first bucket of `among` with room, under the pool's lock; null
   * when none has room. 'had' when some server has it, or is putting it.
   */
  async function reserve(key: string, chapterId: string, bytes: number, among: Member[]): Promise<Member | 'had' | null> {
    const c = await db.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT pg_advisory_xact_lock(${LOCK})`);
      const { rows } = await c.query('SELECT 1 FROM pool_chapters WHERE key = $1', [key]);
      if (rows.length) {
        await c.query('UPDATE pool_chapters SET wanted_at = now() WHERE key = $1', [key]);
        await c.query('COMMIT');
        return 'had';
      }
      const room = await roomOf(c);
      let chosen: Member | null = null;
      for (const m of among) {
        if ((room.get(m.name) ?? 0) >= bytes) {
          chosen = m;
          break;
        }
      }
      if (chosen) {
        await c.query('INSERT INTO pool_chapters (key, chapter, bucket, bytes) VALUES ($1, $2, $3, $4)', [key, chapterId, chosen.name, bytes]);
      }
      await c.query('COMMIT');
      return chosen;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      c.release();
    }
  }

  async function removePages(m: Member, key: string, pages: number) {
    for (let n = 0; n < pages; n++) await m.store.remove(`c/${key}/${n}`);
  }

  /** Puts pictures as a chapter's pages in `m`; their count, or null when they ran out mid-way. */
  async function upload(m: Member, key: string, pictures: () => AsyncIterable<Picture>, expected: number): Promise<number> {
    let n = 0;
    try {
      for await (const pic of pictures()) {
        if (n >= expected) break;
        await m.store.put(`c/${key}/${n}`, pic.data, pic.type);
        n += 1;
      }
    } catch (e) {
      await removePages(m, key, n).catch(() => {});
      throw e;
    }
    return n;
  }

  /**
   * Puts a chapter of `pages` pages and `bytes` bytes in the first bucket with room, its index
   * last. With `keep` (the keeper), chapters wanted least lately and not in `keep` leave first to
   * make room; without, it's put only where there's room already (regional servers).
   */
  async function put(chapterId: string, pages: number, bytes: number, pictures: () => AsyncIterable<Picture>, keep: Set<string> | null = null): Promise<PutResult> {
    const key = poolKey(chapterId);
    let chosen = await reserve(key, chapterId, bytes, members);
    while (chosen === null && keep) {
      if (!(await letOneGo(keep))) break;
      chosen = await reserve(key, chapterId, bytes, members);
    }
    if (chosen === 'had') return 'had';
    if (chosen === null) return 'full';
    const m = chosen;
    try {
      // Every page, and the index in the home.
      if (!(await takeWrites(m, pages))) {
        await db.query('DELETE FROM pool_chapters WHERE key = $1', [key]);
        return 'capped';
      }
      if (!(await takeWrites(home, 1))) {
        await db.query('DELETE FROM pool_chapters WHERE key = $1', [key]);
        return 'capped';
      }
      const put = await upload(m, key, pictures, pages);
      await home.store.put(`c/${key}/index.json`, json({ pages: put, base: m.base }), 'application/json');
      await db.query('UPDATE pool_chapters SET done = true, pages = $2, at = now(), wanted_at = now() WHERE key = $1', [key, put]);
    } catch (e) {
      await db.query('DELETE FROM pool_chapters WHERE key = $1', [key]).catch(() => {});
      throw e;
    }
    remembered.delete(chapterId);
    return 'put';
  }

  /** Takes a chapter out of the pool: its index first, so the app stops reading it, then its pages and its row. */
  async function drop(row: Row) {
    const m = byName.get(row.bucket);
    await home.store.remove(`c/${row.key}/index.json`);
    if (m) await removePages(m, row.key, row.pages);
    await db.query('DELETE FROM pool_chapters WHERE key = $1', [row.key]);
    remembered.delete(row.chapter);
  }

  /** Lets the chapter wanted least lately, and not in `keep`, go. False when there's none to let go. */
  async function letOneGo(keep: Set<string>): Promise<boolean> {
    const { rows } = await db.query<Row>(
      `SELECT key, chapter, bucket, pages, bytes FROM pool_chapters
       WHERE done AND bucket = ANY($1) AND NOT (key = ANY($2)) ORDER BY wanted_at LIMIT 1`,
      [members.map((m) => m.name), [...keep]],
    );
    if (!rows[0]) return false;
    await drop(rows[0]);
    return true;
  }

  return {
    home,
    find,

    /** Where readers read a chapter: its bucket's address and its pages; null when none holds it. */
    async where(chapterId: string): Promise<{ base: string; pages: number; key: string } | null> {
      const w = await find(chapterId);
      if (!w) return null;
      return { base: w.member.base, pages: w.pages, key: w.key };
    },

    /** A page from the pool, for a server about to ask the site; null when the pool hasn't it. */
    async page(chapterId: string, n: number): Promise<Picture | null> {
      let w: Where | null;
      try {
        w = await find(chapterId);
      } catch (err) {
        log.debug({ err }, 'the storage pool couldn’t be asked');
        return null;
      }
      if (!w || n >= w.pages) return null;
      let body: Uint8Array | null = null;
      try {
        const res = await fetchFn(`${w.member.base}/c/${w.key}/${n}`, { signal: AbortSignal.timeout(FETCH_MS) });
        if (res.ok) body = new Uint8Array(await res.arrayBuffer());
      } catch (err) {
        log.debug({ err, chapter: chapterId }, 'a page couldn’t be read from the storage pool');
        return null;
      }
      if (!body) return null;
      const type = pictureType(body);
      if (!type) return null;
      return { data: body, type };
    },

    put,

    /** The keeper still wants these: they leave last. */
    async touch(chapterIds: string[]) {
      if (!chapterIds.length) return;
      await db.query('UPDATE pool_chapters SET wanted_at = now() WHERE key = ANY($1)', [chapterIds.map(poolKey)]);
    },

    /** Measures each bucket's account's other buckets, once a day. */
    async measure(force = false) {
      for (const m of members) {
        const { rows } = await db.query<{ at: Date | null }>('SELECT measured_at AS at FROM pool_buckets WHERE name = $1', [m.name]);
        const at = rows[0]?.at;
        if (!force && at && now() - at.getTime() < MEASURE_EVERY) continue;
        const others = await m.store.othersBytes();
        await db.query(
          `INSERT INTO pool_buckets (name, others, measured_at) VALUES ($1, $2, now())
           ON CONFLICT (name) DO UPDATE SET others = EXCLUDED.others, measured_at = now()`,
          [m.name, others],
        );
      }
    },

    /** Chapters a server began and never finished: their pages and rows go. */
    async clearStale() {
      const { rows } = await db.query<Row>(
        `SELECT key, chapter, bucket, pages, bytes FROM pool_chapters WHERE NOT done AND at < now() - make_interval(secs => $1)`,
        [STALE_MS / 1000],
      );
      for (const r of rows) {
        const m = byName.get(r.bucket);
        if (m) {
          for await (const o of m.store.list(`c/${r.key}/`)) await m.store.remove(o.key);
        }
        await db.query('DELETE FROM pool_chapters WHERE key = $1 AND NOT done', [r.key]);
      }
      return rows.length;
    },

    /** Each bucket: its room, what it holds, and what's left. */
    async rooms() {
      const left = await roomOf(db);
      return members.map((m) => ({ name: m.name, budget: m.budget, left: left.get(m.name) ?? 0 }));
    },

    takeWrites,
  };
}

export type Pool = ReturnType<typeof makePool>;
