import type { MangaChapter } from '@breader/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Manga } from '../src/manga/index.ts';
import { makeKeeper } from '../src/manga/keeper.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

const series = (n: number) => `0000000${n}-0000-4000-8000-000000000000`;
const chapter = (s: string, n: number, more: Partial<MangaChapter> = {}): MangaChapter => ({
  id: `${s}/${n}`,
  chapter: String(n),
  volume: null,
  title: null,
  pages: 2,
  external: null,
  groups: [{ id: 'g', name: 'G' }],
  at: n,
  ...more,
});
/** Where a reader is: a chapter's first page, as the app writes it. */
const at = (n: number) => ({ block: (Math.round(n * 100) + 1) * 1000 });

/** MangaDex and a source with the chapters given, noting each page read. */
function fakeManga(lists: Record<string, MangaChapter[]>) {
  const read: string[] = [];
  const quiet: boolean[] = [];
  const manga = {
    chapters: async (id: string) => ({ chapters: lists[id] ?? [] }),
    sourceChapters: async (id: string) => ({ chapters: lists[id] ?? [] }),
    page: async (id: string, n: number, _saver: boolean, q?: boolean) => { read.push(`${id}:${n}`); quiet.push(!!q); },
    sourcePages: async () => 3,
    sourcePage: async (id: string, n: number, q?: boolean) => { read.push(`${id}:${n}`); quiet.push(!!q); },
  };
  return { manga: manga as unknown as Manga, read, quiet, chapters: () => [...new Set(read.map((r) => r.slice(0, r.lastIndexOf(':'))))] };
}

const poolOf = (rows: { library_id: string; url: string; position: { block: number } | null }[]) => ({
  query: async () => ({ rows }),
}) as never;

const run = (keeper: ReturnType<typeof makeKeeper>) => keeper.run(new AbortController().signal);

describe('keeping libraries’ manga on disk', () => {
  it('keeps the chapter a series is read to and the ten after it, every page, leaving out what can’t be read here', async () => {
    const s = series(1);
    const list = Array.from({ length: 20 }, (_, i) => chapter(s, i + 1, i + 1 === 8 ? { external: 'https://mangaplus' } : {}));
    const f = fakeManga({ [s]: list });
    const r = await run(makeKeeper(f.manga, poolOf([{ library_id: 'a', url: `mangadex:${s}`, position: at(5) }]), 0));
    expect(f.chapters()).toEqual([5, 6, 7, 9, 10, 11, 12, 13, 14, 15].map((n) => `${s}/${n}`));
    expect(f.read).toContain(`${s}/5:0`);
    expect(f.read).toContain(`${s}/5:1`);
    expect(r).toMatchObject({ libraries: 1, series: 1, chapters: 10, pages: 20, failed: 0 });
  });

  it('starts at the first chapter before a series is opened, and at the last once it’s read past', async () => {
    const s = series(1);
    const t = series(2);
    const f = fakeManga({ [s]: Array.from({ length: 15 }, (_, i) => chapter(s, i + 1)), [t]: [1, 2, 3].map((n) => chapter(t, n)) });
    await run(makeKeeper(f.manga, poolOf([
      { library_id: 'a', url: `mangadex:${s}`, position: null },
      { library_id: 'a', url: `mangadex:${t}`, position: at(9) },
    ]), 0));
    expect(f.chapters()).toEqual([...Array.from({ length: 11 }, (_, i) => `${s}/${i + 1}`), `${t}/3`]);
  });

  it('takes each library’s queue in turn, a chapter at a time, and fetches a series two libraries read once', async () => {
    const s = series(1);
    const t = series(2);
    const f = fakeManga({ [s]: [1, 2, 3].map((n) => chapter(s, n)), [t]: [1, 2].map((n) => chapter(t, n)) });
    const r = await run(makeKeeper(f.manga, poolOf([
      { library_id: 'a', url: `mangadex:${s}`, position: null },
      { library_id: 'b', url: `mangadex:${t}`, position: null },
      { library_id: 'b', url: `mangadex:${s}`, position: null },
    ]), 0));
    expect(f.chapters()).toEqual([`${s}/1`, `${t}/1`, `${s}/2`, `${t}/2`, `${s}/3`]);
    expect(r).toMatchObject({ libraries: 2, series: 3, chapters: 5 });
  });

  it('leaves chapters it kept while the server runs, and reads quietly, so they don’t count as read', async () => {
    const s = series(1);
    const f = fakeManga({ [s]: [1, 2].map((n) => chapter(s, n)) });
    const keeper = makeKeeper(f.manga, poolOf([{ library_id: 'a', url: `mangadex:${s}`, position: null }]), 0);
    expect((await run(keeper)).chapters).toBe(2);
    expect((await run(keeper)).chapters).toBe(0);
    expect(f.read).toHaveLength(4);
    expect(f.quiet.every(Boolean)).toBe(true);
  });

  it('reads a source’s pages through Suwayomi, and its group’s uploads with the copies after | filling in', async () => {
    const s = series(1);
    const sw = 'sw:1:x';
    const f = fakeManga({
      [s]: [chapter(s, 1, { groups: [{ id: 'other', name: 'O' }] }), chapter(s, 1, { id: `${s}/1-mine`, groups: [{ id: 'mine', name: 'M' }] })],
      [sw]: [chapter(sw, 1), chapter(sw, 2)],
    });
    await run(makeKeeper(f.manga, poolOf([
      { library_id: 'a', url: `mangadex:${s}#mine|${sw}`, position: null },
      { library_id: 'b', url: sw, position: at(2) },
    ]), 0));
    expect(f.chapters()).toEqual([`${s}/1-mine`, `${sw}/2`]);
    // b's chapter 2 is a's fill-in too, kept once, its three pages through Suwayomi.
    expect(f.read.filter((r) => r.startsWith(`${sw}/2:`))).toHaveLength(3);
    expect(f.read.filter((r) => r.startsWith(`${s}/1-mine:`))).toHaveLength(2);
  });

  it('fetches a MangaDex series’ fill-in chapter from the source it came from', async () => {
    const s = series(1);
    const sw = 'sw:1:x';
    const f = fakeManga({ [s]: [chapter(s, 1)], [sw]: [chapter(sw, 1), chapter(sw, 2)] });
    const r = await run(makeKeeper(f.manga, poolOf([{ library_id: 'a', url: `mangadex:${s}|${sw}`, position: at(2) }]), 0));
    expect(f.read).toEqual([`${sw}/2:0`, `${sw}/2:1`, `${sw}/2:2`]);
    expect(r).toMatchObject({ chapters: 1, pages: 3 });
  });

  it('counts a series that won’t list and carries on with the rest', async () => {
    const s = series(1);
    const f = fakeManga({ [s]: [chapter(s, 1)] });
    const broken = { ...f.manga, chapters: async (id: string) => { if (id === series(2)) throw new Error('down'); return f.manga.chapters(id, 'en'); } } as Manga;
    const r = await run(makeKeeper(broken, poolOf([
      { library_id: 'a', url: `mangadex:${series(2)}`, position: null },
      { library_id: 'a', url: `mangadex:${s}`, position: null },
    ]), 0));
    expect(r).toMatchObject({ series: 1, chapters: 1, failed: 1 });
  });
});
