import { afterAll, describe, expect, it } from 'vitest';
import type { Picture } from '../src/manga/disk.ts';
import { makePool, poolKey, poolMembers, type Member } from '../src/manga/pool.ts';
import { primary } from './helpers.ts';
import { cdnFetch, fakeMember, jpeg, type FakeBucket } from './pool-fakes.ts';

/* The storage pool: chapters in several buckets, each kept under its own room, from any server. */

type FakeMember = Member & { store: FakeBucket };
const names: string[] = [];

/** Members with names no other test uses, so each test counts only its own rows. */
function members(...specs: Array<[budget: number, writes?: number | null]>): FakeMember[] {
  const run = crypto.randomUUID().slice(0, 8);
  return specs.map(([budget, writes = null], i) => {
    const name = `t${run}-${i}`;
    names.push(name);
    return fakeMember(name, budget, writes);
  });
}

function poolOf(ms: FakeMember[], now?: () => number) {
  return makePool({ db: primary.pool, members: ms, fetch: cdnFetch(ms), now });
}

/** `n` pictures of `size` bytes each. */
function pictures(n: number, size = 20) {
  return async function* (): AsyncGenerator<Picture> {
    for (let i = 0; i < n; i++) yield { data: jpeg(size), type: 'image/jpeg' };
  };
}

const index = (m: FakeMember, id: string) => JSON.parse(Buffer.from(m.store.objects.get(`c/${poolKey(id)}/index.json`)!).toString());
const chapterId = () => `md-${crypto.randomUUID()}`;

afterAll(async () => {
  await primary.pool.query('DELETE FROM pool_chapters WHERE bucket = ANY($1)', [names]);
  await primary.pool.query('DELETE FROM pool_buckets WHERE name = ANY($1)', [names]);
});

describe('the storage pool', () => {
  it('puts a chapter’s pages in the first bucket with room, and its index last, in the home', async () => {
    const [home, b2] = members([100], [1000]);
    const pool = poolOf([home, b2]);
    const small = chapterId();
    const big = chapterId();
    expect(await pool.put(small, 2, 40, pictures(2))).toBe('put');
    expect(await pool.put(big, 3, 300, pictures(3, 100))).toBe('put');
    expect(home.store.keys()).toContain(`c/${poolKey(small)}/1`);
    expect(b2.store.keys()).toContain(`c/${poolKey(big)}/2`);
    expect(b2.store.keys()).not.toContain(`c/${poolKey(big)}/index.json`);
    expect(index(home, small)).toEqual({ pages: 2, base: home.base });
    expect(index(home, big)).toEqual({ pages: 3, base: b2.base });
    expect(home.store.log.filter((l) => l.includes(poolKey(small))).at(-1)).toBe(`put c/${poolKey(small)}/index.json`);
    expect(await pool.where(big)).toEqual({ base: b2.base, pages: 3, key: poolKey(big) });
  });

  it('puts a chapter once, however many servers put it at once, and never past a bucket’s room', async () => {
    const [home] = members([100]);
    const servers = [poolOf([home]), poolOf([home]), poolOf([home])];
    const same = chapterId();
    const once = await Promise.all(servers.map((p) => p.put(same, 2, 40, pictures(2))));
    expect(once.filter((r) => r === 'put')).toHaveLength(1);
    expect(once.filter((r) => r === 'had')).toHaveLength(2);
    // 60 bytes left: room for one of these, not two.
    const others = await Promise.all(servers.map((p) => p.put(chapterId(), 2, 50, pictures(2))));
    expect(others.filter((r) => r === 'put')).toHaveLength(1);
    expect(others.filter((r) => r === 'full')).toHaveLength(2);
  });

  it('counts the other buckets on each bucket’s account against its room', async () => {
    const [home] = members([100]);
    home.store.others = 70;
    const pool = poolOf([home]);
    await pool.measure(true);
    expect((await pool.rooms())[0].left).toBe(30);
    expect(await pool.put(chapterId(), 2, 40, pictures(2))).toBe('full');
  });

  it('measures the other buckets once a day, not every turn', async () => {
    const [home] = members([100]);
    let now = Date.now();
    const pool = poolOf([home], () => now);
    await pool.measure();
    home.store.others = 50;
    await pool.measure();
    expect((await pool.rooms())[0].left).toBe(100);
    now += 25 * 3600_000;
    await pool.measure();
    expect((await pool.rooms())[0].left).toBe(50);
  });

  it('makes room for the keeper, the chapter wanted least lately going first, never one it keeps', async () => {
    const [home] = members([100]);
    const pool = poolOf([home]);
    const old = chapterId();
    const kept = chapterId();
    await pool.put(old, 2, 40, pictures(2));
    await pool.put(kept, 2, 40, pictures(2));
    await primary.pool.query(`UPDATE pool_chapters SET wanted_at = now() - interval '1 hour' WHERE key = $1`, [poolKey(kept)]);
    const next = chapterId();
    // A regional server only puts where there's room.
    expect(await pool.put(next, 2, 40, pictures(2))).toBe('full');
    expect(await pool.put(next, 2, 40, pictures(2), new Set([poolKey(kept), poolKey(next)]))).toBe('put');
    expect(await pool.find(old)).toBeNull();
    expect(home.store.keys().some((k) => k.includes(poolKey(old)))).toBe(false);
    expect(await pool.find(kept)).not.toBeNull();
  });

  it('reads a page through its bucket’s public address, and none it hasn’t', async () => {
    const [home] = members([100]);
    const pool = poolOf([home]);
    const id = chapterId();
    await pool.put(id, 2, 40, pictures(2));
    expect((await pool.page(id, 0))?.type).toBe('image/jpeg');
    expect(await pool.page(id, 2)).toBeNull();
    expect(await pool.page(chapterId(), 0)).toBeNull();
  });

  it('stops at a bucket’s writes for the month, where the owner set a limit, and leaves no row', async () => {
    const [home] = members([1000, 4]);
    const pool = poolOf([home]);
    // 2 pages and the index: 3 writes.
    expect(await pool.put(chapterId(), 2, 40, pictures(2))).toBe('put');
    const capped = chapterId();
    expect(await pool.put(capped, 2, 40, pictures(2))).toBe('capped');
    const { rowCount } = await primary.pool.query('SELECT 1 FROM pool_chapters WHERE key = $1', [poolKey(capped)]);
    expect(rowCount).toBe(0);
  });

  it('starts the writes again in a new month', async () => {
    const [home] = members([1000, 3]);
    let now = Date.UTC(2026, 10, 30);
    const pool = poolOf([home], () => now);
    expect(await pool.put(chapterId(), 2, 40, pictures(2))).toBe('put');
    expect(await pool.put(chapterId(), 2, 40, pictures(2))).toBe('capped');
    now = Date.UTC(2026, 11, 1);
    expect(await pool.put(chapterId(), 2, 40, pictures(2))).toBe('put');
  });

  it('takes back a chapter whose pictures ran out mid-way: its pages, and its row', async () => {
    const [home] = members([1000]);
    const pool = poolOf([home]);
    const id = chapterId();
    async function* broken(): AsyncGenerator<Picture> {
      yield { data: jpeg(20), type: 'image/jpeg' };
      throw new Error('the site went away');
    }
    await expect(pool.put(id, 2, 40, broken)).rejects.toThrow('the site went away');
    expect(home.store.keys().some((k) => k.includes(poolKey(id)))).toBe(false);
    expect(await pool.put(id, 2, 40, pictures(2))).toBe('put');
  });

  it('clears a chapter a server began and never finished', async () => {
    const [home] = members([1000]);
    const pool = poolOf([home]);
    const key = poolKey(chapterId());
    await primary.pool.query(`INSERT INTO pool_chapters (key, chapter, bucket, bytes, at) VALUES ($1, 'x', $2, 40, now() - interval '2 hours')`, [key, home.name]);
    await home.store.put(`c/${key}/0`, jpeg(20), 'image/jpeg');
    expect(await pool.clearStale()).toBe(1);
    expect(home.store.keys()).toEqual([]);
    expect((await pool.rooms())[0].left).toBe(1000);
  });
});

describe('the pool’s buckets from env', () => {
  const bucket = (name: string) => ({
    [`POOL_${name}_ENDPOINT`]: 'https://s3.test',
    [`POOL_${name}_BUCKET`]: 'b',
    [`POOL_${name}_KEY_ID`]: 'k',
    [`POOL_${name}_SECRET`]: 's',
    [`POOL_${name}_MB`]: '10',
    [`POOL_${name}_PUBLIC_URL`]: `https://${name}.test/`,
  });

  it('is empty without POOL_MEMBERS', () => {
    expect(poolMembers({})).toEqual([]);
  });

  it('takes the buckets in order, the home first', () => {
    const ms = poolMembers({ POOL_MEMBERS: 'r2, b2', ...bucket('R2'), ...bucket('B2'), POOL_B2_WRITES: '500' });
    expect(ms.map((m) => [m.name, m.budget, m.writes, m.base])).toEqual([
      ['r2', 10 * 1024 * 1024, null, 'https://R2.test'],
      ['b2', 10 * 1024 * 1024, 500, 'https://B2.test'],
    ]);
  });

  it('says which setting is missing', () => {
    const raw: Record<string, string | undefined> = { POOL_MEMBERS: 'r2', ...bucket('R2') };
    delete raw.POOL_R2_MB;
    expect(() => poolMembers(raw)).toThrow('POOL_R2_MB');
  });
});
