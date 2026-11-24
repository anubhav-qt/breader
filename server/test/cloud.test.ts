import type { MangaChapter, MangaChapters } from '@breader/shared';
import { describe, expect, it } from 'vitest';
import type { Storage } from '../src/lib/storage.ts';
import { cloudKey, makeCloud, type CloudSeries } from '../src/manga/cloud.ts';
import type { Manga } from '../src/manga/index.ts';

const PAGES = 'pages';
const FILES = 'files';
const signal = () => new AbortController().signal;

/** R2 in memory: buckets of objects, and every put and remove in order. */
function fakeStorage() {
  const buckets = new Map<string, Map<string, Uint8Array>>();
  const log: string[] = [];
  const bucketOf = (name: string) => {
    let b = buckets.get(name);
    if (!b) {
      b = new Map();
      buckets.set(name, b);
    }
    return b;
  };
  const storage = {
    async *list(prefix: string, bucket: string) {
      for (const [key, body] of bucketOf(bucket)) {
        if (key.startsWith(prefix)) yield { key, size: body.length, etag: '' };
      }
    },
    async read(key: string, _signal: unknown, bucket: string) {
      const body = bucketOf(bucket).get(key);
      if (!body) return null;
      return Buffer.from(body);
    },
    async putPublic(key: string, body: Uint8Array, _type: string, bucket: string) {
      bucketOf(bucket).set(key, body);
      log.push(`put ${key}`);
    },
    async remove(key: string, bucket: string) {
      bucketOf(bucket).delete(key);
      log.push(`remove ${key}`);
    },
  };
  const keys = (bucket = PAGES) => [...bucketOf(bucket).keys()].sort();
  return { storage: storage as unknown as Storage, bucketOf, log, keys };
}

const chapter = (id: string, pages = 2): MangaChapter => ({
  id,
  chapter: id.split('/').pop() ?? '1',
  volume: null,
  title: null,
  pages,
  external: null,
  groups: [],
  at: 0,
});

/** Pages of `size` bytes each; a source chapter has 3. Chapters named in `broken` can't be read. */
function fakeManga(size = 10, broken: string[] = []) {
  const picture = (id: string) => {
    if (broken.includes(id)) throw new Error('not on the disk');
    return { data: new Uint8Array(size), type: 'image/jpeg' };
  };
  const manga = {
    page: async (id: string) => picture(id),
    sourcePages: async () => 3,
    sourcePage: async (id: string) => picture(id),
  };
  return manga as unknown as Manga;
}

const list = (n: number): MangaChapters => ({ lang: 'en', chapters: [chapter(`sw:1:s:${n}`)] });
const series = (id: string, chapters: MangaChapter[], l: MangaChapters | null = null): CloudSeries => ({ id, chapters, list: l });

describe('readers’ next chapters in R2', () => {
  it('puts each chapter’s pages, then its index, and a Suwayomi series’ list', async () => {
    const r2 = fakeStorage();
    const cloud = makeCloud({ storage: r2.storage, bucket: PAGES, others: [], manga: fakeManga() });
    const a = chapter('md-a');
    const b = chapter('sw:1:s:b');
    const r = await cloud.turn([series('mangadex:x', [a]), series('sw:1:s', [b], list(1))], signal());
    const ka = cloudKey('md-a');
    const kb = cloudKey('sw:1:s:b');
    expect(r2.log.filter((l) => l.includes(ka))).toEqual([`put c/${ka}/0`, `put c/${ka}/1`, `put c/${ka}/index.json`]);
    expect(r2.keys()).toContain(`c/${kb}/2`);
    expect(r2.keys()).toContain(`s/${cloudKey('sw:1:s')}/chapters.json`);
    expect(JSON.parse(Buffer.from(r2.bucketOf(PAGES).get(`c/${ka}/index.json`)!).toString())).toEqual({ pages: 2 });
    expect(r).toMatchObject({ chapters: 2, put: 2, removed: 0, full: false, capped: false });
    expect(r.bytes).toBeGreaterThan(50);
  });

  it('keeps under the free room left by the other buckets, the series read longest ago left out', async () => {
    const r2 = fakeStorage();
    r2.bucketOf(FILES).set('lib/book', new Uint8Array(30));
    // 100 free, 30 taken: 70 left, room for three chapters of 20 bytes and their indexes.
    const cloud = makeCloud({ storage: r2.storage, bucket: PAGES, others: [FILES], manga: fakeManga(10), free: 100 });
    const recent = series('mangadex:new', [chapter('n1'), chapter('n2'), chapter('n3')]);
    const older = series('mangadex:old', [chapter('o1')]);
    const r = await cloud.turn([recent, older], signal());
    expect(r).toMatchObject({ chapters: 3, full: true, room: 70 });
    expect(r2.keys().some((k) => k.startsWith(`c/${cloudKey('o1')}/`))).toBe(false);
  });

  it('counts a chapter two series share once', async () => {
    const r2 = fakeStorage();
    const cloud = makeCloud({ storage: r2.storage, bucket: PAGES, others: [], manga: fakeManga() });
    const r = await cloud.turn([series('mangadex:a', [chapter('c1')]), series('mangadex:a', [chapter('c1')])], signal());
    expect(r.put).toBe(1);
  });

  it('removes chapters and lists no longer wanted, the index before the pages', async () => {
    const r2 = fakeStorage();
    const cloud = makeCloud({ storage: r2.storage, bucket: PAGES, others: [], manga: fakeManga() });
    await cloud.turn([series('sw:1:s', [chapter('sw:1:s:1')], list(1))], signal());
    r2.log.length = 0;
    const r = await cloud.turn([series('mangadex:b', [chapter('b1')])], signal());
    const k = cloudKey('sw:1:s:1');
    expect(r2.log.slice(0, 2)).toEqual([`remove c/${k}/index.json`, `remove c/${k}/0`]);
    expect(r2.keys().some((key) => key.includes(k))).toBe(false);
    expect(r2.keys().some((key) => key.startsWith('s/'))).toBe(false);
    expect(r).toMatchObject({ chapters: 1, removed: 1 });
  });

  it('stops at the month’s free writes, never leaving an index on a half put chapter', async () => {
    const r2 = fakeStorage();
    const cloud = makeCloud({ storage: r2.storage, bucket: PAGES, others: [], manga: fakeManga(), freeWrites: 4 });
    // 3 writes for the first chapter, then 1 page of the second.
    const r = await cloud.turn([series('mangadex:a', [chapter('a1'), chapter('a2')])], signal());
    expect(r).toMatchObject({ chapters: 1, put: 1, capped: true, writes: 4 });
    expect(r2.keys()).toContain(`c/${cloudKey('a2')}/0`);
    expect(r2.keys()).not.toContain(`c/${cloudKey('a2')}/index.json`);
  });

  it('starts the count again in a new month', async () => {
    const r2 = fakeStorage();
    let now = Date.UTC(2026, 10, 30);
    const cloud = makeCloud({ storage: r2.storage, bucket: PAGES, others: [], manga: fakeManga(), freeWrites: 3, now: () => now });
    const wanted = [series('mangadex:a', [chapter('a1'), chapter('a2')])];
    expect(await cloud.turn(wanted, signal())).toMatchObject({ chapters: 1, capped: true });
    now = Date.UTC(2026, 11, 1);
    expect(await cloud.turn(wanted, signal())).toMatchObject({ chapters: 2, capped: false, writes: 3 });
  });

  it('after a start, knows what R2 holds and its writes, and tidies a half put chapter it no longer wants', async () => {
    const r2 = fakeStorage();
    const first = makeCloud({ storage: r2.storage, bucket: PAGES, others: [], manga: fakeManga(), freeWrites: 4 });
    await first.turn([series('mangadex:a', [chapter('a1'), chapter('a2')])], signal());
    r2.log.length = 0;
    const again = makeCloud({ storage: r2.storage, bucket: PAGES, others: [], manga: fakeManga(), freeWrites: 10 });
    const r = await again.turn([series('mangadex:a', [chapter('a1')])], signal());
    expect(r).toMatchObject({ chapters: 1, put: 0, writes: 4 });
    expect(r2.log).toEqual([`remove c/${cloudKey('a2')}/0`]);
  });

  it('puts a half put chapter it still wants again from its first page', async () => {
    const r2 = fakeStorage();
    const first = makeCloud({ storage: r2.storage, bucket: PAGES, others: [], manga: fakeManga(), freeWrites: 1 });
    await first.turn([series('mangadex:a', [chapter('a1')])], signal());
    const again = makeCloud({ storage: r2.storage, bucket: PAGES, others: [], manga: fakeManga(), freeWrites: 10 });
    const r = await again.turn([series('mangadex:a', [chapter('a1')])], signal());
    const k = cloudKey('a1');
    expect(r).toMatchObject({ chapters: 1, put: 1 });
    expect(r2.keys().filter((key) => key.includes(k))).toEqual([`c/${k}/0`, `c/${k}/1`, `c/${k}/index.json`]);
  });

  it('puts a series’ list again only when it changes', async () => {
    const r2 = fakeStorage();
    const cloud = makeCloud({ storage: r2.storage, bucket: PAGES, others: [], manga: fakeManga() });
    const c = chapter('sw:1:s:1');
    await cloud.turn([series('sw:1:s', [c], list(1))], signal());
    r2.log.length = 0;
    await cloud.turn([series('sw:1:s', [c], list(1))], signal());
    expect(r2.log.filter((l) => l.startsWith('put s/'))).toEqual([]);
    await cloud.turn([series('sw:1:s', [c], list(2))], signal());
    expect(r2.log.filter((l) => l.startsWith('put s/'))).toHaveLength(1);
  });

  it('leaves out a chapter it can’t read off the disk, and goes on with the rest', async () => {
    const r2 = fakeStorage();
    const cloud = makeCloud({ storage: r2.storage, bucket: PAGES, others: [], manga: fakeManga(10, ['bad']) });
    const r = await cloud.turn([series('mangadex:a', [chapter('bad'), chapter('good')])], signal());
    expect(r).toMatchObject({ chapters: 1, put: 1 });
    expect(r2.keys()).toContain(`c/${cloudKey('good')}/index.json`);
  });
});
