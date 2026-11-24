import { describe, expect, it } from 'vitest';
import type { Picture } from '../src/manga/disk.ts';
import { makeUploads } from '../src/manga/uploads.ts';
import { jpeg } from './pool-fakes.ts';

/* A regional server's chapters into the storage pool, once a reader has had the last page. */

function fakes(opts: { pages?: number; inPool?: boolean; failPages?: boolean } = {}) {
  const pages = opts.pages ?? 3;
  const read: string[] = [];
  const put: Array<{ chapter: string; pages: number; bytes: number; pictures: number }> = [];
  const manga = {
    async chapterPages() {
      if (opts.failPages) throw new Error('the site is away');
      return pages;
    },
    async chapterPage(chapterId: string, n: number, quiet?: boolean): Promise<Picture> {
      read.push(`${chapterId}:${n}:${quiet ? 'quiet' : 'read'}`);
      return { data: jpeg(20 + n), type: 'image/jpeg' };
    },
  };
  const pool = {
    async find() {
      if (opts.inPool) return { member: {} as never, pages, key: 'k' };
      return null;
    },
    async put(chapter: string, n: number, bytes: number, pictures: () => AsyncIterable<Picture>) {
      let count = 0;
      for await (const _ of pictures()) count += 1;
      put.push({ chapter, pages: n, bytes, pictures: count });
      return 'put' as const;
    },
  };
  return { uploads: makeUploads({ pool, manga }), read, put };
}

describe('a regional server’s chapters into the pool', () => {
  it('puts a chapter after its last page is served, its pages read quietly', async () => {
    const f = fakes();
    await f.uploads.saw('md-1', 0);
    await f.uploads.saw('md-1', 1);
    await f.uploads.settled();
    expect(f.put).toEqual([]);
    await f.uploads.saw('md-1', 2);
    await f.uploads.settled();
    expect(f.put).toEqual([{ chapter: 'md-1', pages: 3, bytes: 20 + 21 + 22, pictures: 3 }]);
    expect(f.read.every((r) => r.endsWith(':quiet'))).toBe(true);
  });

  it('puts a chapter once, however often its last page is served', async () => {
    const f = fakes();
    await f.uploads.saw('md-1', 2);
    await f.uploads.saw('md-1', 2);
    await f.uploads.settled();
    expect(f.put).toHaveLength(1);
  });

  it('leaves a chapter the pool has already, reading none of its pages', async () => {
    const f = fakes({ inPool: true });
    await f.uploads.saw('md-1', 2);
    await f.uploads.settled();
    expect(f.put).toEqual([]);
    expect(f.read).toEqual([]);
  });

  it('carries on quietly when the chapter’s pages can’t be counted', async () => {
    const f = fakes({ failPages: true });
    await f.uploads.saw('md-1', 2);
    await f.uploads.settled();
    expect(f.put).toEqual([]);
  });
});
