import type { MangaChapter, MangaChapters } from '@breader/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { cloudKey, makeCloud, type CloudSeries } from '../src/manga/cloud.ts';
import type { Manga } from '../src/manga/index.ts';
import { makePool } from '../src/manga/pool.ts';
import { primary } from './helpers.ts';
import { cdnFetch, fakeMember, jpeg } from './pool-fakes.ts';

/* The keeper's turn: readers' next chapters, most wanted first, into the storage pool. */

const signal = () => new AbortController().signal;
const names: string[] = [];

/** A pool of one bucket of `budget` bytes (and a second when `second` is set), its name used by no other test. */
function poolOf(budget: number, second = 0) {
  const run = crypto.randomUUID().slice(0, 8);
  const home = fakeMember(`c${run}-home`, budget);
  const ms = [home];
  names.push(home.name);
  if (second) {
    const b2 = fakeMember(`c${run}-b2`, second);
    ms.push(b2);
    names.push(b2.name);
  }
  return { home, members: ms, pool: makePool({ db: primary.pool, members: ms, fetch: cdnFetch(ms) }) };
}

afterAll(async () => {
  await primary.pool.query('DELETE FROM pool_chapters WHERE bucket = ANY($1)', [names]);
  await primary.pool.query('DELETE FROM pool_buckets WHERE name = ANY($1)', [names]);
});

const run = crypto.randomUUID().slice(0, 8);
/** A chapter id no other test uses: the pool's rows are shared. */
const id = (name: string) => `${name}-${run}`;

const chapter = (name: string, pages = 2): MangaChapter => ({
  id: id(name),
  chapter: '1',
  volume: null,
  title: null,
  pages,
  external: null,
  groups: [],
  at: 0,
});

/** Pages of `size` bytes each; a source chapter has 3. Chapters named in `broken` can't be read. */
function fakeManga(size = 20, broken: string[] = []) {
  const picture = (chapterId: string) => {
    if (broken.map(id).includes(chapterId)) throw new Error('not on the disk');
    return { data: jpeg(size), type: 'image/jpeg' };
  };
  const manga = {
    page: async (chapterId: string) => picture(chapterId),
    sourcePages: async () => 3,
    sourcePage: async (chapterId: string) => picture(chapterId),
  };
  return manga as unknown as Manga;
}

const list = (n: number): MangaChapters => ({ lang: 'en', chapters: [chapter(`sw:1:s:${n}`)] });
const series = (sid: string, chapters: MangaChapter[], l: MangaChapters | null = null): CloudSeries => ({ id: id(sid), chapters, list: l });

describe('readers’ next chapters in the pool', () => {
  it('puts each chapter’s pages, then its index, and a Suwayomi series’ list in the home', async () => {
    const { home, pool } = poolOf(10_000);
    const cloud = makeCloud({ pool, manga: fakeManga() });
    const a = chapter('md-a');
    const b = chapter('sw:1:s:b');
    const r = await cloud.turn([series('mangadex:x', [a]), series('sw:1:s', [b], list(1))], signal());
    const ka = cloudKey(a.id);
    const kb = cloudKey(b.id);
    expect(home.store.log.filter((l) => l.includes(ka))).toEqual([`put c/${ka}/0`, `put c/${ka}/1`, `put c/${ka}/index.json`]);
    expect(home.store.keys()).toContain(`c/${kb}/2`);
    expect(home.store.keys()).toContain(`s/${cloudKey(id('sw:1:s'))}/chapters.json`);
    expect(r).toMatchObject({ chapters: 2, put: 2, full: false, capped: false });
    expect(r.rooms[0].left).toBe(10_000 - 40 - 60);
  });

  it('fills the next bucket when the home has no room left', async () => {
    const { members, pool } = poolOf(50, 1000);
    const cloud = makeCloud({ pool, manga: fakeManga() });
    const r = await cloud.turn([series('mangadex:a', [chapter('f1'), chapter('f2')])], signal());
    expect(r).toMatchObject({ chapters: 2, put: 2 });
    expect(members[0].store.keys()).toContain(`c/${cloudKey(id('f2'))}/index.json`);
    expect(members[1].store.keys()).toContain(`c/${cloudKey(id('f2'))}/1`);
  });

  it('when full, lets go what’s wanted least, never the chapters it wants, and stops', async () => {
    const { home, pool } = poolOf(100);
    const cloud = makeCloud({ pool, manga: fakeManga() });
    await cloud.turn([series('mangadex:old', [chapter('o1')])], signal());
    const r = await cloud.turn([series('mangadex:new', [chapter('n1'), chapter('n2'), chapter('n3')])], signal());
    expect(r).toMatchObject({ chapters: 2, full: true });
    expect(home.store.keys().some((k) => k.includes(cloudKey(id('o1'))))).toBe(false);
    expect(home.store.keys()).toContain(`c/${cloudKey(id('n2'))}/index.json`);
    expect(home.store.keys()).not.toContain(`c/${cloudKey(id('n3'))}/index.json`);
  });

  it('counts a chapter two series share once, and puts nothing again on the next turn', async () => {
    const { home, pool } = poolOf(10_000);
    const cloud = makeCloud({ pool, manga: fakeManga() });
    const wanted = [series('mangadex:a', [chapter('c1')]), series('mangadex:a', [chapter('c1')])];
    expect((await cloud.turn(wanted, signal())).put).toBe(1);
    home.store.log.length = 0;
    expect(await cloud.turn(wanted, signal())).toMatchObject({ chapters: 1, put: 0 });
    expect(home.store.log).toEqual([]);
  });

  it('removes lists no longer wanted, and puts a list again only when it changes', async () => {
    const { home, pool } = poolOf(10_000);
    const cloud = makeCloud({ pool, manga: fakeManga() });
    const c = chapter('sw:1:s:1');
    await cloud.turn([series('sw:1:s', [c], list(1))], signal());
    home.store.log.length = 0;
    await cloud.turn([series('sw:1:s', [c], list(1))], signal());
    expect(home.store.log.filter((l) => l.startsWith('put s/'))).toEqual([]);
    await cloud.turn([series('sw:1:s', [c], list(2))], signal());
    expect(home.store.log.filter((l) => l.startsWith('put s/'))).toHaveLength(1);
    await cloud.turn([series('mangadex:b', [chapter('b1')])], signal());
    expect(home.store.keys().some((k) => k.startsWith('s/'))).toBe(false);
  });

  it('after a start, reads the lists already in the home and doesn’t put them again', async () => {
    const { home, pool } = poolOf(10_000);
    const wanted = [series('sw:1:t', [chapter('sw:1:t:1')], list(3))];
    await makeCloud({ pool, manga: fakeManga() }).turn(wanted, signal());
    home.store.log.length = 0;
    await makeCloud({ pool, manga: fakeManga() }).turn(wanted, signal());
    expect(home.store.log).toEqual([]);
  });

  it('leaves out a chapter it can’t read off the disk, and goes on with the rest', async () => {
    const { home, pool } = poolOf(10_000);
    const cloud = makeCloud({ pool, manga: fakeManga(20, ['bad']) });
    const r = await cloud.turn([series('mangadex:a', [chapter('bad'), chapter('good')])], signal());
    expect(r).toMatchObject({ chapters: 1, put: 1 });
    expect(home.store.keys()).toContain(`c/${cloudKey(id('good'))}/index.json`);
  });
});
