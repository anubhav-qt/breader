import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AniCard, AniListPage, MangaFound, MangaSearchResult } from '@breader/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Manga } from '../src/manga/index.ts';
import { makeWalk, pick, readerAsked, readersQuiet, walkFiles, type WalkKey, type WalkState, type WalkStore } from '../src/manga/walk.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

const state = (today: Partial<Record<WalkKey, number>> = {}, ended: WalkKey[] = []): WalkState => {
  const at: WalkState['at'] = {};
  for (const k of ended) at[k] = { page: 1, next: null, end: true };
  return { today, at, updated: [] };
};

describe('which list the walk goes on with', () => {
  it('goes by the owner’s split, without 18+ first, then 18+, then on in the same split', () => {
    expect(pick(state())).toBe('all:popular');
    // Furthest behind its share: 750 of 1,500 is half; 400 of 1,000 is less.
    expect(pick(state({ 'all:popular': 750, 'all:rated': 750, 'all:latest': 500, 'all:trending': 400 }))).toBe('all:trending');
    // Every share without 18+ met: 18+.
    const met = { 'all:popular': 1_500, 'all:rated': 1_500, 'all:latest': 1_000, 'all:trending': 1_000 } as const;
    expect(pick(state(met))).toBe('adult:popular');
    // Every share met: on, the one furthest behind.
    const all = { ...met, 'adult:popular': 1_500, 'adult:rated': 1_500, 'adult:latest': 1_000, 'adult:trending': 1_000, 'all:rated': 1_600 };
    expect(pick(state(all))).toBe('all:popular');
  });

  it('leaves out a list walked to its end or resting, and says so when none is left', () => {
    expect(pick(state({}, ['all:popular']))).toBe('all:rated');
    expect(pick(state({}, ['all:popular']), (k) => k === 'all:rated')).toBe('all:latest');
    // Without 18+ all at an end: 18+ though its share's met.
    const ends: WalkKey[] = ['all:popular', 'all:rated', 'all:latest', 'all:trending'];
    expect(pick(state({ 'adult:popular': 5_000 }, ends))).toBe('adult:rated');
    expect(pick(state({}, [...ends, 'adult:popular', 'adult:rated', 'adult:latest', 'adult:trending']))).toBeNull();
  });
});

const ani = (id: number, title: string): AniCard => ({ id, title, names: [title] }) as unknown as AniCard;
const sw = (id: string, title: string): MangaFound =>
  ({ kind: 'source', source: 'Asura', card: { id, title, side: false, kind: 'manga', cover: `/v1/manga/source/${id}/cover` }, keys: [title.toLowerCase()], edition: null }) as unknown as MangaFound;

/** A store in memory, as the files keep it. */
function memoryStore(): WalkStore & { state: WalkState; seen: string[] } {
  const s = {
    state: state(),
    seen: [] as string[],
    load: async () => ({ state: structuredClone(s.state), seen: new Set(s.seen) }),
    save: async (st: WalkState) => { s.state = structuredClone(st); },
    saw: async (ids: string[]) => { s.seen.push(...ids); },
  };
  return s;
}

/** AniList's lists, two pages of Popular then none; the sites' Updated, two lots. */
function fakeManga() {
  const asked: string[] = [];
  const pages: Record<number, AniListPage> = {
    1: { items: [ani(1, 'Alpha'), ani(2, 'Beta')], next: 2 },
    2: { items: [ani(3, 'Gamma')], next: null },
  };
  const lots: Record<string, MangaSearchResult> = {
    '': { items: [sw('sw:a', 'Alpha'), sw('sw:n', 'New')], next: 'sw:1' },
    'sw:1': { items: [sw('sw:o', 'Old')], next: null },
  };
  const manga = {
    search: vi.fn(async (q: Parameters<Manga['search']>[0]) => {
      if (q.q) return { items: [], next: null };
      asked.push(`latest ${q.adult ? '18+' : 'all'} ${q.next ?? ''}`);
      return lots[q.next ?? ''];
    }),
    series: vi.fn(async () => ({}) as never),
    sourceSeries: vi.fn(async (id: string) => { asked.push(`series ${id}`); return {} as never; }),
    chapters: vi.fn(async () => ({}) as never),
    sourceChapters: vi.fn(async (id: string) => ({ lang: 'en', chapters: [1, 2, 3].map((n) => ({ id: `${id}.${n}` })) }) as never),
    copies: vi.fn(async () => ({}) as never),
    cover: vi.fn(async () => ({}) as never),
    sourceCover: vi.fn(async () => ({}) as never),
    coversFor: vi.fn(async () => {}),
    page: async () => ({}) as never,
    sourcePages: vi.fn(async (id: string) => { asked.push(`pages ${id}`); return 3; }),
    sourcePage: async () => ({}) as never,
    chapterPages: async () => 0,
    chapterPage: async () => ({}) as never,
    warm: async () => {},
    anilist: {
      list: vi.fn(async (ask: { sort: string; page: number; adult: boolean }) => {
        asked.push(`list ${ask.sort} ${ask.adult ? '18+' : 'all'} ${ask.page}`);
        return pages[ask.page] ?? { items: [], next: null };
      }),
      about: vi.fn(async (id: number) => { asked.push(`about ${id}`); return {} as never; }),
      cover: vi.fn(async (id: number) => { asked.push(`al cover ${id}`); return {} as never; }),
    } as unknown as Manga['anilist'],
    aniFound: vi.fn(async (id: number) => {
      asked.push(`found ${id}`);
      // Gamma isn't read anywhere.
      if (id === 3) return [];
      return [sw(`sw:${id}`, `Series ${id}`)];
    }),
    aniFoundKept: async () => ({}),
  } satisfies Manga;
  return { manga, asked };
}

describe('the manga walk', () => {
  it('saves each series of a page as its sheet asks for it, AniList’s page and cover too, and goes on a page', async () => {
    const { manga, asked } = fakeManga();
    const store = memoryStore();
    const walk = makeWalk(manga, { store, breather: 0 });
    expect(await walk.turn()).toEqual({ key: 'all:popular', saved: 2, failed: 0 });
    expect(asked).toEqual([
      'list popular all 1',
      'about 1',
      'found 1',
      'al cover 1',
      'series sw:1',
      'pages sw:1.1',
      'pages sw:1.2',
      'about 2',
      'found 2',
      'al cover 2',
      'series sw:2',
      'pages sw:2.1',
      'pages sw:2.2',
    ]);
    expect(store.seen).toEqual(['al:1', 'sw:1', 'al:2', 'sw:2']);
    expect(store.state.at['all:popular']).toEqual({ page: 2, next: null, end: false });
    expect(store.state.today['all:popular']).toBe(2);
    // Not read anywhere: AniList's page only, and saved, so it isn't asked again.
    asked.length = 0;
    store.state.today = { ...store.state.today, 'all:rated': 1_500, 'all:latest': 1_000, 'all:trending': 1_000 };
    await makeWalk(manga, { store, breather: 0 }).turn();
    expect(asked).toContain('found 3');
    expect(asked).not.toContain('al cover 3');
    expect(store.seen).toContain('al:3');
  });

  it('never starts over: a new start goes on where it got to, past what it saved', async () => {
    const store = memoryStore();
    const first = fakeManga();
    // Readers come back after the first series.
    let quiet = true;
    first.manga.aniFound.mockImplementation(async (id: number) => {
      quiet = false;
      return [sw(`sw:${id}`, 'x')];
    });
    const walk = makeWalk(first.manga, { store, breather: 0, quiet: () => quiet });
    expect(await walk.turn()).toEqual({ key: 'all:popular', saved: 1, failed: 0 });
    // The page isn't done, so it's where it was.
    expect(store.state.at['all:popular']?.page).toBe(1);

    const again = fakeManga();
    store.state.today = { ...store.state.today, 'all:rated': 1_500, 'all:latest': 1_000, 'all:trending': 1_000 };
    await makeWalk(again.manga, { store, breather: 0 }).turn();
    expect(again.asked.filter((a) => a.startsWith('found'))).toEqual(['found 2']);
    expect(store.state.at['all:popular']?.page).toBe(2);
    expect(store.state.today['all:popular']).toBe(2);
  });

  it('marks a list at its end once its pages come empty', async () => {
    const { manga } = fakeManga();
    const store = memoryStore();
    store.state.at['all:popular'] = { page: 3, next: null, end: false };
    expect(await makeWalk(manga, { store, breather: 0 }).turn()).toEqual({ key: 'all:popular', saved: 0, failed: 0 });
    expect(store.state.at['all:popular']?.end).toBe(true);
  });

  it('walks the sites’ Updated list lot by lot, past series it saved by any of their places', async () => {
    const { manga, asked } = fakeManga();
    const store = memoryStore();
    store.seen.push('sw:a');
    store.state.today = { 'all:popular': 1_500, 'all:rated': 1_500, 'all:trending': 1_000 };
    const walk = makeWalk(manga, { store, breather: 0 });
    expect(await walk.turn()).toEqual({ key: 'all:latest', saved: 1, failed: 0 });
    expect(asked).toContain('series sw:n');
    expect(asked).not.toContain('series sw:a');
    expect(store.state.at['all:latest']).toEqual({ page: 1, next: 'sw:1', end: false });
    await walk.turn();
    expect(store.state.at['all:latest']?.end).toBe(true);
    expect(asked.filter((a) => a.startsWith('latest'))).toEqual(['latest all ', 'latest all sw:1']);
  });

  it('asks 18+ and doujinshi as 18+ readers see them', async () => {
    const { manga } = fakeManga();
    const store = memoryStore();
    store.state.today = { 'all:popular': 1_500, 'all:rated': 1_500, 'all:latest': 1_000, 'all:trending': 1_000 };
    await makeWalk(manga, { store, breather: 0 }).turn();
    expect(manga.anilist.list).toHaveBeenCalledWith(expect.objectContaining({ sort: 'popular', adult: true, adultOnly: true }));
    expect(manga.aniFound).toHaveBeenCalledWith(1, 'en', true);
    expect(manga.sourceSeries).toHaveBeenCalledWith('sw:1', true);
  });

  it('rests a list that failed and goes on with another', async () => {
    const { manga } = fakeManga();
    vi.mocked(manga.anilist.list).mockRejectedValueOnce(new Error('AniList is down'));
    const store = memoryStore();
    const walk = makeWalk(manga, { store, breather: 0 });
    expect(await walk.turn()).toEqual({ key: 'all:popular', saved: 0, failed: 1 });
    expect((await walk.turn())?.key).toBe('all:rated');
  });

  it('counts a step that failed and still saves the series', async () => {
    const { manga } = fakeManga();
    vi.mocked(manga.anilist.about).mockRejectedValue(new Error('busy'));
    const store = memoryStore();
    expect(await makeWalk(manga, { store, breather: 0 }).turn()).toEqual({ key: 'all:popular', saved: 2, failed: 2 });
    expect(store.seen).toContain('al:1');
  });

  it('stops between series when told', async () => {
    const { manga } = fakeManga();
    const stop = new AbortController();
    stop.abort();
    const store = memoryStore();
    expect(await makeWalk(manga, { store, breather: 0 }).turn(stop.signal)).toEqual({ key: 'all:popular', saved: 0, failed: 0 });
    expect(store.seen).toEqual([]);
  });
});

describe('the daily update pass', () => {
  it('fetches again what the sites updated, down to where the last pass got to, then starts a new day', async () => {
    const { manga, asked } = fakeManga();
    const store = memoryStore();
    store.state.today = { 'all:popular': 900 };
    const walk = makeWalk(manga, { store, breather: 0 });
    const first = await walk.update();
    // 18+ has the same lots here: each series is fetched once.
    expect(first.series).toBe(3);
    expect(store.state.today).toEqual({});
    expect(store.state.updated.sort()).toEqual(['sw:a', 'sw:n', 'sw:o']);

    // The next day one more on top: it, and the lot it's in, then a lot all fetched last time ends it.
    asked.length = 0;
    vi.mocked(manga.search).mockImplementation(async (q) => {
      if (q.q) return { items: [], next: null };
      asked.push(`latest ${q.next ?? ''}`);
      if (!q.next) return { items: [sw('sw:z', 'Zeta'), sw('sw:a', 'Alpha')], next: 'sw:1' };
      if (q.next === 'sw:1') return { items: [sw('sw:n', 'New'), sw('sw:o', 'Old')], next: 'sw:2' };
      return { items: [sw('sw:never', 'Never')], next: null };
    });
    const second = await walk.update();
    expect(second.series).toBe(2);
    expect(asked.filter((a) => a.startsWith('latest'))).toEqual(['latest ', 'latest sw:1', 'latest ', 'latest sw:1']);
    expect(store.state.updated.sort()).toEqual(['sw:a', 'sw:z']);
  });

  it('reads at most a day’s Updated share the first time', async () => {
    const { manga } = fakeManga();
    let n = 0;
    vi.mocked(manga.search).mockImplementation(async (q) => {
      if (q.q) return { items: [], next: null };
      const items = Array.from({ length: 100 }, () => sw(`sw:${n}`, `S${n++}`));
      return { items, next: `sw:${n}` };
    });
    const r = await makeWalk(manga, { store: memoryStore(), breather: 0 }).update();
    expect(r.series).toBe(2_000);
  });

  it('keeps the day’s count when it was stopped', async () => {
    const { manga } = fakeManga();
    const store = memoryStore();
    store.state.today = { 'all:popular': 900 };
    const stop = new AbortController();
    stop.abort();
    await makeWalk(manga, { store, breather: 0 }).update(stop.signal);
    expect(store.state.today).toEqual({ 'all:popular': 900 });
  });
});

describe('readers', () => {
  it('are quiet 20 seconds after their last ask for manga', () => {
    readerAsked(1_000_000);
    expect(readersQuiet(1_010_000)).toBe(false);
    expect(readersQuiet(1_020_001)).toBe(true);
  });
});

describe('the walk’s files', () => {
  it('keep its place and what it saved, and read back a broken place as the top', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'walk-'));
    try {
      const files = walkFiles(join(dir, 'walk'));
      expect(await files.load()).toEqual({ state: { today: {}, at: {}, updated: [] }, seen: new Set() });
      const st = state({ 'all:popular': 3 });
      st.at['all:latest'] = { page: 1, next: 'sw:1', end: false };
      await Promise.all([files.save(state()), files.save(st)]);
      await files.saw(['al:1', 'sw:1']);
      await files.saw(['al:2']);
      const back = await walkFiles(join(dir, 'walk')).load();
      expect(back.state).toEqual(st);
      expect([...back.seen]).toEqual(['al:1', 'sw:1', 'al:2']);

      await writeFile(join(dir, 'walk', 'walk.json'), '{ broken');
      const broken = await walkFiles(join(dir, 'walk')).load();
      expect(broken.state).toEqual(state());
      expect(broken.seen.size).toBe(3);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
