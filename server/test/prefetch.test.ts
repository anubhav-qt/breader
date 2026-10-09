import type { MangaFound, MangaSearchResult } from '@breader/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { freshly, Memo, MemoryStore } from '../src/lib/cache.ts';
import type { Manga } from '../src/manga/index.ts';
import { prefetch, untilPrefetch } from '../src/manga/prefetch.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

/** A clock the test moves. */
function clock(start = 1_000_000) {
  const t = { now: start };
  vi.spyOn(Date, 'now').mockImplementation(() => t.now);
  return t;
}

describe('answers kept on past their time', () => {
  it('are given straight away and fetched again behind, once however many ask', async () => {
    const t = clock();
    const memo = new Memo<number>(new MemoryStore(10), 't', 1_000, 10_000);
    let n = 0;
    let release = () => {};
    const make = async () => {
      n += 1;
      if (n === 2) await new Promise<void>((done) => { release = done; });
      return n;
    };
    expect(await memo.get('k', make)).toBe(1);
    t.now += 500;
    expect(await memo.get('k', make)).toBe(1);
    expect(n).toBe(1);

    // Past its time: what's kept, at once, while it's fetched again (once, however many ask).
    t.now += 1_000;
    expect(await Promise.all([memo.get('k', make), memo.get('k', make)])).toEqual([1, 1]);
    expect(await memo.get('k', make)).toBe(1);
    expect(n).toBe(2);
    release();
    await vi.waitFor(async () => expect(await memo.peek('k')).toBe(2));
    expect(await memo.get('k', make)).toBe(2);

    // Past keeping too: fetched, and waited for.
    t.now += 20_000;
    expect(await memo.get('k', make)).toBe(3);
  });

  it('are fetched again and waited for in freshly(), what was kept doing if that fails', async () => {
    const t = clock();
    const memo = new Memo<string>(new MemoryStore(10), 't', 1_000, 10_000);
    await memo.get('k', async () => 'old');
    t.now += 2_000;
    expect(await freshly(() => memo.get('k', async () => 'new'))).toBe('new');
    t.now += 2_000;
    expect(await freshly(() => memo.get('k', async () => { throw new Error('down'); }))).toBe('new');
    // Within its time, nothing is asked.
    const make = vi.fn(async () => 'newer');
    t.now -= 1_500;
    expect(await freshly(() => memo.get('k', make))).toBe('new');
    expect(make).not.toHaveBeenCalled();
  });

  it('read as they were kept before there was keeping on', async () => {
    const store = new MemoryStore(10);
    await store.set('t:k', 7, 1_000);
    const memo = new Memo<number>(store, 't', 1_000, 10_000);
    expect(await memo.get('k', async () => 8)).toBe(7);
    expect(await memo.peek('k')).toBe(7);
  });
});

describe('the daily prefetch', () => {
  it('runs at 04:00 in India, 22:30 UTC', () => {
    const hours = (iso: string) => untilPrefetch(new Date(iso)) / 3_600_000;
    expect(hours('2026-10-07T12:00:00Z')).toBe(10.5);
    expect(hours('2026-10-07T22:30:00Z')).toBe(24);
    expect(hours('2026-10-07T23:00:00Z')).toBe(23.5);
  });

  const md = (id: string, title: string): MangaFound =>
    ({ kind: 'mangadex', source: 'MangaDex', card: { id, title, side: false, kind: 'manga', cover: `${id}.jpg` }, keys: [title.toLowerCase()], edition: null }) as unknown as MangaFound;
  const sw = (id: string, title: string): MangaFound =>
    ({ kind: 'source', source: 'Asura', card: { id, title, side: false, kind: 'manga', cover: `/v1/manga/source/${id}/cover` }, keys: [title.toLowerCase()], edition: null }) as unknown as MangaFound;

  function fakeManga() {
    const lots: Record<string, MangaSearchResult> = {
      '': { items: [md('a', 'Alpha'), sw('sw:1', 'Alpha')], next: 'md:10' },
      'md:10': { items: [md('b', 'Beta')], next: null },
    };
    const asked: string[] = [];
    const say = (what: string) => async () => { asked.push(what); return {} as never; };
    const manga = {
      search: vi.fn(async (q: Parameters<Manga['search']>[0]) => {
        // A sheet looking for the series' other places: one more for Alpha.
        if (q.q) {
          asked.push(`places ${q.q} ${q.names?.join('|')}`);
          if (q.q === 'Alpha') return { items: [sw('sw:2', 'Alpha'), md('x', 'Other')], next: null };
          return { items: [], next: null };
        }
        return lots[q.next ?? ''];
      }),
      series: vi.fn(async (id: string) => { asked.push(`series ${id}`); return {} as never; }),
      sourceSeries: vi.fn(async (id: string) => { asked.push(`series ${id}`); return {} as never; }),
      chapters: vi.fn(async (id: string) => { asked.push(`chapters ${id}`); return {} as never; }),
      sourceChapters: vi.fn(async (id: string) => {
        asked.push(`chapters ${id}`);
        return { lang: 'en', chapters: [1, 2, 3].map((n) => ({ id: `${id}.${n}` })) } as never;
      }),
      copies: vi.fn(async (id: string) => { asked.push(`copies ${id}`); return {} as never; }),
      cover: vi.fn(async (id: string, _file: string, size: string) => { asked.push(`cover ${id} ${size}`); return {} as never; }),
      sourceCover: vi.fn(async (id: string, size: string) => { asked.push(`cover ${id} ${size}`); return {} as never; }),
      coversFor: vi.fn(async (id: string, freshFor: number) => { asked.push(`for ${id} ${freshFor / 86_400_000}d`); }),
      page: say('page'),
      sourcePages: vi.fn(async (id: string) => { asked.push(`pages ${id}`); return 3; }),
      sourcePage: say('page'),
      warm: async () => {},
    } satisfies Manga;
    return { manga, asked };
  }

  it('fetches each list’s series, and once each, what its sheet asks for, covers kept by the list that changes most', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      const { manga, asked } = fakeManga();
      const going = prefetch(manga);
      await vi.runAllTimersAsync();
      const r = await going;
      // Three orders, with every kind and each of four alone.
      expect(r.lists).toBe(15);
      expect(r.series).toBe(2);
      expect(r.failed).toBe(0);
      const lists = manga.search.mock.calls.filter(([q]) => !q.q).map(([q]) => `${q.sort} ${q.kinds?.join('+')} ${q.next ?? ''}`);
      expect(lists).toContain('popular manga+manhwa+manhua+comics ');
      expect(lists).toContain('rated comics md:10');
      expect(manga.search.mock.calls.every(([q]) => q.lang === 'en' && !q.adult)).toBe(true);
      // Every series is in Updated too, so its covers are fetched again daily.
      expect(asked).toEqual([
        'series a',
        'places Alpha alpha',
        'for a 1d',
        'cover a 512',
        'chapters a',
        'copies a',
        'for sw:1 1d',
        'cover sw:1 512',
        'chapters sw:1',
        'pages sw:1.1',
        'pages sw:1.2',
        'copies sw:1',
        'for sw:2 1d',
        'cover sw:2 512',
        'chapters sw:2',
        'pages sw:2.1',
        'pages sw:2.2',
        'copies sw:2',
        'series b',
        'places Beta beta',
        'for b 1d',
        'cover b 512',
        'chapters b',
        'copies b',
      ]);

      // In Popular and Top rated alone: Popular's three days, the shorter.
      const other = fakeManga();
      const lists2 = other.manga.search.getMockImplementation()!;
      other.manga.search.mockImplementation(async (q) => (q.sort === 'latest' && !q.q ? { items: [], next: null } : lists2(q)));
      const going2 = prefetch(other.manga);
      await vi.runAllTimersAsync();
      await going2;
      expect(other.asked.filter((a) => a.startsWith('for '))).toEqual(['for a 3d', 'for sw:1 3d', 'for sw:2 3d', 'for b 3d']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('carries on past what fails, and stops when told', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      const { manga } = fakeManga();
      manga.copies.mockRejectedValue(new Error('down'));
      const going = prefetch(manga);
      await vi.runAllTimersAsync();
      const r = await going;
      expect(r.series).toBe(2);
      expect(r.failed).toBe(4);

      const stop = new AbortController();
      stop.abort();
      const none = await prefetch(fakeManga().manga, stop.signal);
      expect(none.series).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
