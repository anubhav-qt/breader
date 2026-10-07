import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newLibraryKey, seriesName, type MangaFound } from '@breader/shared';
import { describe, expect, it } from 'vitest';
import { makeApp } from '../src/app.ts';
import type { Store } from '../src/lib/cache.ts';
import { find, rank, type Found, type Place } from '../src/manga/find.ts';
import { makeManga } from '../src/manga/index.ts';
import { browser, deps } from './helpers.ts';

/*
 * One search across MangaDex and Breader's Suwayomi sources, each a server of our own answering
 * as the real one does, so what a search shows, in what order, and how it reads
 * a series from each can be checked.
 */

const png = (n: number) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, n]);

/** The start of a PNG this wide, 1600 tall, as a page whose size can be read. */
function pageOf(width: number): Uint8Array {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, width);
  new DataView(b.buffer).setUint32(20, 1600);
  return b;
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const MIN = 60_000;
const HOUR = 60 * MIN;

/** MangaDex with these series, each ended with its three chapters all here, first published in Japanese unless said. */
function fakeDex(titles: string[], originals: Record<string, string>) {
  const uuid = (n: number) => `e0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const data = titles.map((title, i) => ({
    id: uuid(i + 1),
    type: 'manga',
    attributes: { title: { en: title }, altTitles: [], status: 'completed', lastChapter: '3', contentRating: 'safe', tags: [], availableTranslatedLanguages: ['en'], originalLanguage: originals[title] ?? 'ja', latestUploadedChapter: 'up' },
    relationships: [],
  }));
  const chapters = [1, 2, 3].map((n) => ({
    id: `f0000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    type: 'chapter',
    attributes: { chapter: String(n), volume: null, title: null, externalUrl: null, publishAt: '2023-01-01T00:00:00+00:00', readableAt: '2023-01-01T00:00:00+00:00', pages: 3 },
    relationships: [],
  }));
  return (url: URL) => {
    const path = url.pathname;
    if (path === '/manga/tag') return json({ result: 'ok', data: [] });
    if (path === '/manga') {
      const offset = Number(url.searchParams.get('offset'));
      const limit = Number(url.searchParams.get('limit'));
      const only = url.searchParams.getAll('originalLanguage[]');
      const not = url.searchParams.getAll('excludedOriginalLanguage[]');
      let list = data;
      if (only.length > 0) list = list.filter((m) => only.includes(m.attributes.originalLanguage));
      list = list.filter((m) => !not.includes(m.attributes.originalLanguage));
      return json({ result: 'ok', data: list.slice(offset, offset + limit), total: list.length, limit, offset });
    }
    if (/\/feed$/.test(path)) return json({ result: 'ok', data: chapters, total: 3, limit: 500, offset: 0 });
    if (/\/aggregate$/.test(path)) {
      const all = { '1': { chapter: '1' }, '2': { chapter: '2' }, '3': { chapter: '3' } };
      return json({ result: 'ok', volumes: { none: { chapters: all } } });
    }
    return json({ result: 'error' }, 404);
  };
}

interface SwSeries {
  id: number;
  source: string;
  title: string;
  status?: string;
  genre?: string[];
  /** Its chapters' numbers: 1, 2 and 3 when left out. */
  chapters?: number[];
  /** Its uploads instead, each by a group, its pages this wide. */
  uploads?: Array<{ n: number; by: string; width: number }>;
}

/** Suwayomi with a few sources, answering GraphQL as it does. */
function fakeSuwayomi() {
  const state = {
    sources: [
      { id: '0', name: 'Local source', lang: 'localsourcelang', isNsfw: false, supportsLatest: true },
      { id: '11', name: 'Asura Scans', lang: 'en', isNsfw: false, supportsLatest: true },
      { id: '22', name: 'Manga Demon', lang: 'en', isNsfw: false, supportsLatest: false },
      { id: '33', name: 'Flame Comics', lang: 'en', isNsfw: false, supportsLatest: true },
      { id: '44', name: 'Late Night', lang: 'en', isNsfw: true, supportsLatest: true },
      { id: '55', name: 'Leitura', lang: 'pt-BR', isNsfw: false, supportsLatest: true },
    ],
    series: [] as SwSeries[],
    /** Sources whose searches fail, as Flame Comics' did. */
    broken: new Set<string>(),
    /** Sources whose site says to slow down. */
    slowDown: new Set<string>(),
    /** Sources whose site takes this long (ms) over every call. */
    lag: new Map<string, number>(),
    /** Suwayomi itself not answering. */
    down: false,
    perPage: 20,
  };
  const calls: Array<{ op: string; source?: string; type?: string; page?: number }> = [];
  const refuse = (message: string) => ({ data: null, errors: [{ message: `Exception while fetching data (/x) : ${message}\r\n\r\njava.lang.Exception: ${message}\n\tat somewhere` }] });
  const seriesById = (id: number) => state.series.find((s) => s.id === id);
  const sourceById = (id: string) => state.sources.find((s) => s.id === id)!;

  function graphql(query: string, v: Record<string, any>) {
    if (query.includes('sources {')) return { data: { sources: { nodes: state.sources } } };
    if (query.includes('fetchSourceManga')) {
      const { source, type, page } = v.input;
      calls.push({ op: 'search', source, type, page });
      if (state.broken.has(source)) return refuse('Failed to find buildId');
      if (state.slowDown.has(source)) return refuse('HTTP error 429');
      let list = state.series.filter((s) => s.source === source);
      if (type === 'SEARCH') list = list.filter((s) => s.title.toLowerCase().includes(String(v.input.query).toLowerCase()));
      const from = (page - 1) * state.perPage;
      const mangas = list.slice(from, from + state.perPage).map((s) => ({ id: s.id, title: s.title }));
      return { data: { fetchSourceManga: { hasNextPage: from + state.perPage < list.length, mangas } } };
    }
    if (query.includes('fetchManga')) {
      const s = seriesById(v.id);
      calls.push({ op: 'series' });
      if (!s) return refuse('Collection is empty.');
      const src = sourceById(s.source);
      const manga = { id: s.id, title: s.title, status: s.status ?? 'ONGOING', genre: s.genre ?? [], author: 'Writer, Drawer', artist: 'Drawer', description: 'What it is.\r\n\r\n\r\nMore.', realUrl: 'https://example.com/s', source: { id: src.id, name: src.name, isNsfw: src.isNsfw } };
      return { data: { fetchManga: { manga } } };
    }
    if (query.includes('manga(id')) {
      const s = seriesById(v.id);
      if (!s) return refuse('The field at path /manga was declared as a non null type');
      return { data: { manga: { source: { id: s.source } } } };
    }
    if (query.includes('fetchChapters')) {
      const s = seriesById(v.mangaId ?? v.id)!;
      calls.push({ op: 'chapters' });
      if (s.uploads) {
        const chapters = s.uploads.map((u, i) => ({ id: s.id * 1000 + i, name: `Chapter ${u.n}`, chapterNumber: u.n, scanlator: u.by, uploadDate: '1700000000000', sourceOrder: i + 1 }));
        return { data: { fetchChapters: { chapters } } };
      }
      const numbers = s.chapters ?? [1, 2, 3];
      const chapters = numbers.map((n, i) => ({ id: s.id * 1000 + i, name: `Chapter ${n}`, chapterNumber: n, scanlator: i === 0 ? 'Some Scans' : null, uploadDate: '1700000000000', sourceOrder: i + 1 }));
      return { data: { fetchChapters: { chapters } } };
    }
    if (query.includes('chapter(id')) return { data: { chapter: { mangaId: Math.floor(v.id / 1000) } } };
    if (query.includes('fetchChapterPages')) {
      calls.push({ op: 'pages' });
      const manga = Math.floor(v.id / 1000);
      return { data: { fetchChapterPages: { pages: [0, 1, 2].map((p) => `/api/v1/manga/${manga}/chapter/${v.id}/page/${p}`) } } };
    }
    return refuse('Unknown query');
  }

  /** The source a call asks of its site, if it asks one. */
  function sourceOfCall(query: string, v: Record<string, any>): string | null {
    if (query.includes('fetchSourceManga')) return v.input.source;
    if (query.includes('fetchManga') || query.includes('fetchChapters')) {
      const s = seriesById(v.id ?? v.mangaId);
      if (s) return s.source;
    }
    return null;
  }

  async function answer(url: URL, init: RequestInit) {
    if (state.down) return new Response('Bad Gateway', { status: 502 });
    if (url.pathname === '/api/graphql') {
      const body = JSON.parse(String(init.body));
      const source = sourceOfCall(body.query, body.variables);
      let lag = 0;
      if (source) lag = state.lag.get(source) ?? 0;
      if (lag > 0) await new Promise((done) => setTimeout(done, lag));
      return json(graphql(body.query, body.variables));
    }
    let m = /^\/api\/v1\/manga\/(\d+)\/thumbnail$/.exec(url.pathname);
    if (m) {
      calls.push({ op: 'thumbnail' });
      return new Response(png(9));
    }
    m = /^\/api\/v1\/manga\/(\d+)\/chapter\/(\d+)\/page\/(\d+)$/.exec(url.pathname);
    if (m) {
      calls.push({ op: 'picture' });
      const s = seriesById(Number(m[1]));
      const upload = s?.uploads?.[Number(m[2]) - s.id * 1000];
      if (upload) return new Response(pageOf(upload.width));
      return new Response(png(Number(m[3])));
    }
    return new Response('nope', { status: 404 });
  }
  return { state, calls, answer };
}

async function setup(dexTitles: string[] = [], store?: Store, originals: Record<string, string> = {}, browseWithin?: number) {
  const sw = fakeSuwayomi();
  const dex = fakeDex(dexTitles, originals);
  const dexCalls: URL[] = [];
  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    if (url.host === 'api.mangadex.org') {
      dexCalls.push(url);
      return dex(url);
    }
    if (url.host === 'suwayomi.test') return sw.answer(url, init);
    return new Response('no such host', { status: 502 });
  }) as typeof globalThis.fetch;
  const dir = await mkdtemp(join(tmpdir(), 'breader-sources-'));
  const manga = makeManga({
    dir,
    cacheBytes: 64 * 1024 * 1024,
    fetch,
    pace: { api: [1000, 1000], home: [1000, 1000] },
    store,
    suwayomi: 'http://suwayomi.test/',
    browseWithin,
  });
  const app = makeApp({ ...deps, manga });
  const b = browser(undefined, app);
  const r = await b.post('/v1/libraries', { libraryId: crypto.randomUUID(), key: newLibraryKey() });
  expect(r.status).toBe(201);
  return { sw, dexCalls, app, b, manga };
}

const shown = (body: { items: MangaFound[] }) => body.items.map((x) => `${x.source}: ${x.card.title}`);

describe('one search everywhere', () => {
  it('shows the same series once for each place that has it, side by side, the one searched for first', async () => {
    const { b, sw } = await setup(['Omniscient Reader’s Viewpoint', 'Omniscient Reader Fan Club']);
    sw.state.series = [
      { id: 1, source: '11', title: 'Omniscient Reader’s Viewpoint' },
      { id: 2, source: '22', title: 'Omniscient' },
      { id: 3, source: '22', title: "Omniscient Reader's Viewpoint" },
    ];
    const r = await b.get('/v1/manga/search?q=omniscient&lang=en');
    expect(r.status).toBe(200);
    expect(shown(r.body)).toEqual([
      'Manga Demon: Omniscient',
      'Asura Scans: Omniscient Reader’s Viewpoint',
      'MangaDex: Omniscient Reader’s Viewpoint',
      "Manga Demon: Omniscient Reader's Viewpoint",
      'MangaDex: Omniscient Reader Fan Club',
    ]);
    const kinds = r.body.items.map((x: MangaFound) => x.kind);
    expect(kinds).toEqual(['source', 'source', 'mangadex', 'source', 'mangadex']);
    expect(r.body.items[1].card).toEqual({ id: 'sw:1', title: 'Omniscient Reader’s Viewpoint', cover: '/v1/manga/source/sw:1/cover', status: 'ongoing', adult: false, side: false, kind: null });
    expect(r.body.items[2].card.kind).toBe('manga');
    // Every place had nothing more.
    expect(r.body.next).toBeNull();
    // Every source in English, Late Night's too, as its series are judged one by one.
    expect(sw.calls.filter((c) => c.op === 'search').map((c) => c.source)).toEqual(['11', '33', '44', '22']);
    expect(sw.calls.filter((c) => c.op === 'search').map((c) => c.type)).toEqual(['SEARCH', 'SEARCH', 'SEARCH', 'SEARCH']);
  });

  it('goes on without a source that fails, and answers an empty lot when the rest found nothing', async () => {
    const { b, sw } = await setup();
    sw.state.series = [{ id: 1, source: '11', title: 'Solo Leveling' }];
    sw.state.broken.add('33');
    const r = await b.get('/v1/manga/search?q=solo&lang=en');
    expect(r.status).toBe(200);
    expect(shown(r.body)).toEqual(['Asura Scans: Solo Leveling']);

    sw.state.broken = new Set(['11', '22', '33']);
    const none = await b.get('/v1/manga/search?q=none&lang=en');
    // MangaDex answered, with nothing: an empty lot, not an error.
    expect(none.status).toBe(200);
    expect(none.body).toEqual({ items: [], next: null });
  });

  it('shows from a source only series every chapter of it has, an ongoing one lacking at most its newest two', async () => {
    const { b, sw } = await setup();
    sw.state.series = [
      { id: 1, source: '11', title: 'All here', chapters: [1, 2, 3, 4, 5] },
      { id: 2, source: '11', title: 'A gap', chapters: [1, 2, 4, 5, 6] },
      { id: 3, source: '11', title: 'A gap near the newest', chapters: [1, 2, 3, 5] },
      { id: 4, source: '11', title: 'Ended with a gap', status: 'COMPLETED', chapters: [1, 2, 3, 5] },
      { id: 5, source: '11', title: 'No chapters', chapters: [] },
      { id: 6, source: '11', title: 'In parts', status: 'COMPLETED', chapters: [0, 1, 2.1, 2.2, 3] },
    ];
    const r = await b.get('/v1/manga/search?lang=en');
    expect(shown(r.body)).toEqual(['Asura Scans: All here', 'Asura Scans: A gap near the newest', 'Asura Scans: In parts']);
  });

  it('keeps 18+ out unless asked, by each series’ own genres, loli and shota always, and doujinshi and anthologies unless asked, after the rest', async () => {
    const { b, sw } = await setup();
    sw.state.series = [
      { id: 1, source: '11', title: 'Plain' },
      { id: 2, source: '11', title: 'Spicy', genre: ['Hentai'] },
      { id: 3, source: '11', title: 'Never', genre: ['Loli'] },
      { id: 4, source: '11', title: 'Fan work', genre: ['Doujinshi'] },
      { id: 5, source: '11', title: 'Many hands', genre: ['Anthology'] },
      // A site with some series for adults isn't for adults whole.
      { id: 6, source: '44', title: 'Late show' },
      { id: 7, source: '44', title: 'After hours', genre: ['Romance', 'Smut'] },
    ];
    const plain = await b.get('/v1/manga/search');
    expect(shown(plain.body).sort()).toEqual(['Asura Scans: Plain', 'Late Night: Late show']);
    const adult = await b.get('/v1/manga/search?adult=1');
    expect(shown(adult.body).sort()).toEqual(['Asura Scans: Plain', 'Asura Scans: Spicy', 'Late Night: After hours', 'Late Night: Late show']);
    const marked = adult.body.items.filter((x: MangaFound) => x.kind === 'source' && x.card.adult);
    expect(shown({ items: marked }).sort()).toEqual(['Asura Scans: Spicy', 'Late Night: After hours']);
    const side = await b.get('/v1/manga/search?doujinshi=1');
    expect(shown(side.body)).toEqual(['Asura Scans: Plain', 'Late Night: Late show', 'Asura Scans: Fan work', 'Asura Scans: Many hands']);
    expect(side.body.items.map((x: MangaFound) => x.card.side)).toEqual([false, false, true, true]);
  });

  it('shows only the kinds asked, by a series’ genres or first language, one of no known kind only with every kind', async () => {
    const { b, sw, dexCalls } = await setup(['Dex Manga', 'Dex Manhwa', 'Dex Comic'], undefined, { 'Dex Manhwa': 'ko', 'Dex Comic': 'en' });
    sw.state.series = [
      { id: 1, source: '11', title: 'Source Manga', genre: ['Manga', 'Action'] },
      { id: 2, source: '11', title: 'Source Manhwa', genre: ['Action', 'Manwha'] },
      { id: 3, source: '11', title: 'Source Manhua', genre: ['Manhua'] },
      { id: 4, source: '11', title: 'Source Untyped', genre: ['Action'] },
    ];
    const kinds = (body: { items: MangaFound[] }) => body.items.map((x) => `${x.card.title}: ${x.card.kind}`).sort();
    const all = await b.get('/v1/manga/search?q=source');
    expect(kinds(all.body)).toEqual([
      'Dex Comic: comics',
      'Dex Manga: manga',
      'Dex Manhwa: manhwa',
      'Source Manga: manga',
      'Source Manhua: manhua',
      'Source Manhwa: manhwa',
      'Source Untyped: null',
    ]);
    const some = await b.get('/v1/manga/search?q=source&kinds=manhwa,manga');
    expect(kinds(some.body)).toEqual(['Dex Manga: manga', 'Dex Manhwa: manhwa', 'Source Manga: manga', 'Source Manhwa: manhwa']);
    const comics = await b.get('/v1/manga/search?q=source&kinds=comics');
    expect(kinds(comics.body)).toEqual(['Dex Comic: comics']);
    // MangaDex is asked for those first published in their languages, or for any but the others'.
    const lists = dexCalls.filter((u) => u.pathname === '/manga');
    expect(lists).toHaveLength(3);
    expect(lists[0].searchParams.has('originalLanguage[]')).toBe(false);
    expect(lists[0].searchParams.has('excludedOriginalLanguage[]')).toBe(false);
    expect(lists[1].searchParams.getAll('originalLanguage[]')).toEqual(['ja', 'ko']);
    expect(lists[2].searchParams.getAll('excludedOriginalLanguage[]')).toEqual(['ja', 'ko', 'zh', 'zh-hk']);
    expect((await b.get('/v1/manga/search?kinds=books')).status).toBe(400);
  });

  it('looks only in sources of the language asked, and in all of them for any', async () => {
    const { b, sw } = await setup();
    sw.state.series = [
      { id: 1, source: '11', title: 'In English' },
      { id: 2, source: '55', title: 'Em português' },
    ];
    expect(shown((await b.get('/v1/manga/search?lang=en')).body)).toEqual(['Asura Scans: In English']);
    expect(shown((await b.get('/v1/manga/search?lang=pt-br')).body)).toEqual(['Leitura: Em português']);
    expect(shown((await b.get('/v1/manga/search')).body).sort()).toEqual(['Asura Scans: In English', 'Leitura: Em português']);
    // Suwayomi's own folder is never looked in.
    expect(sw.calls.filter((c) => c.op === 'search').map((c) => c.source)).not.toContain('0');
  });

  it('carries on where each place got to, and asks only those with more', async () => {
    const { b, sw, dexCalls } = await setup(['Dex 1']);
    sw.state.series = [
      ...Array.from({ length: 15 }, (_, i) => ({ id: 101 + i, source: '11', title: `Asura ${i + 1}` })),
      ...Array.from({ length: 25 }, (_, i) => ({ id: i + 1, source: '22', title: `Demon ${i + 1}` })),
    ];
    const first = await b.get('/v1/manga/search?lang=en&sort=latest');
    expect(first.body.items).toHaveLength(20);
    expect(first.body.next).toBe('sw11:1.10,sw22:1.10');
    // Manga Demon has no Latest, so its Popular instead.
    expect(sw.calls.find((c) => c.source === '11')?.type).toBe('LATEST');
    expect(sw.calls.find((c) => c.source === '22')?.type).toBe('POPULAR');

    const second = await b.get(`/v1/manga/search?lang=en&sort=latest&next=${first.body.next}`);
    expect(shown(second.body).slice(0, 3)).toEqual(['Asura Scans: Asura 11', 'Manga Demon: Demon 11', 'Asura Scans: Asura 12']);
    expect(second.body.items).toHaveLength(15);
    expect(second.body.next).toBe('sw22:2');

    const third = await b.get(`/v1/manga/search?lang=en&sort=latest&next=${second.body.next}`);
    expect(shown(third.body)).toEqual(['Manga Demon: Demon 21', 'Manga Demon: Demon 22', 'Manga Demon: Demon 23', 'Manga Demon: Demon 24', 'Manga Demon: Demon 25']);
    expect(third.body.next).toBeNull();
    // Browsing, MangaDex isn't asked beside the sources.
    expect(dexCalls).toEqual([]);
    expect(sw.calls.filter((c) => c.op === 'search' && c.source === '22').map((c) => c.page)).toEqual([1, 2]);
    expect((await b.get('/v1/manga/search?next=nope')).status).toBe(400);
  });

  it('leaves a source alone for a minute when its site says to slow down', async () => {
    const { b, sw } = await setup();
    sw.state.series = [{ id: 1, source: '11', title: 'Steady' }];
    sw.state.slowDown.add('22');
    expect(shown((await b.get('/v1/manga/search?q=x&lang=en')).body)).toEqual([]);
    expect(shown((await b.get('/v1/manga/search?q=st&lang=en')).body)).toEqual(['Asura Scans: Steady']);
    expect(sw.calls.filter((c) => c.source === '22')).toHaveLength(1);
  });

  it('keeps what a source said as long as its kind keeps', async () => {
    const keys = new Map<string, number>();
    const store: Store = {
      async get() {
        return undefined;
      },
      async set(key, _value, ttl) {
        keys.set(key, ttl);
      },
    };
    const { b, sw } = await setup([], store);
    sw.state.series = [{ id: 1, source: '11', title: 'Kept' }];
    await b.get('/v1/manga/search?lang=en');
    expect(keys.get('manga:v1:sw-sources:all')).toBe(10 * MIN);
    expect(keys.get('manga:v1:sw-search:11:POPULAR:1:')).toBe(10 * MIN);
    expect(keys.get('manga:v1:sw-series:1')).toBe(6 * HOUR);
    expect(keys.get('manga:v1:sw-chapters:1')).toBe(10 * MIN);
    expect(keys.get('manga:v1:sw-readable:1')).toBe(24 * HOUR);
    // Which series a chapter is in is kept only once a reader opens it, not for every chapter a search checks.
    const chapterKeys = [...keys.keys()].filter((k) => k.startsWith('manga:v1:sw-chapter-series:'));
    expect(chapterKeys).toEqual([]);
  });
});

describe('a series from a source', () => {
  it('opens a Suwayomi series, its chapters and pages, pages for signed-in readers only and kept', async () => {
    const { b, app, sw } = await setup();
    sw.state.series = [
      { id: 7, source: '11', title: 'Read me', chapters: [1, 2] },
      { id: 8, source: '44', title: 'After dark', genre: ['Adult'] },
      { id: 10, source: '44', title: 'Quiet night' },
      { id: 9, source: '11', title: 'Never', genre: ['Shota'] },
    ];
    const r = await b.get('/v1/manga/source/sw:7');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      id: 'sw:7',
      title: 'Read me',
      cover: '/v1/manga/source/sw:7/cover',
      status: 'ongoing',
      adult: false,
      side: false,
      kind: null,
      source: 'Asura Scans',
      authors: ['Writer', 'Drawer'],
      description: 'What it is.\n\nMore.',
      genres: [],
      link: 'https://example.com/s',
    });
    const list = await b.get('/v1/manga/source/sw:7/chapters');
    expect(list.body.lang).toBe('en');
    expect(list.body.chapters).toEqual([
      { id: 'sw:7000', chapter: '1', volume: null, title: 'Chapter 1', pages: 0, external: null, groups: [{ id: 'Some Scans', name: 'Some Scans' }], at: 1700000000000 },
      { id: 'sw:7001', chapter: '2', volume: null, title: 'Chapter 2', pages: 0, external: null, groups: [], at: 1700000000000 },
    ]);

    const stranger = browser(undefined, app);
    expect((await stranger.get('/v1/manga/source/chapter/sw:7001')).status).toBe(401);
    expect((await stranger.get('/v1/manga/source/chapter/sw:7001/0')).status).toBe(401);
    expect((await b.get('/v1/manga/source/chapter/sw:7001')).body).toEqual({ pages: 3 });
    const page = await b.get('/v1/manga/source/chapter/sw:7001/2');
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toBe('image/png');
    await b.get('/v1/manga/source/chapter/sw:7001/2');
    expect(sw.calls.filter((c) => c.op === 'picture')).toHaveLength(1);
    const past = await b.get('/v1/manga/source/chapter/sw:7001/3');
    expect(past.status).toBe(404);
    expect(past.body.message).toBe('That chapter has no page there.');
    const cover = await b.get('/v1/manga/source/sw:7/cover');
    expect(cover.headers.get('content-type')).toBe('image/png');

    const shut = await b.get('/v1/manga/source/sw:8');
    expect(shut.status).toBe(403);
    expect(shut.body.code).toBe('manga_adult');
    expect((await b.get('/v1/manga/source/sw:8?adult=1')).status).toBe(200);
    expect((await b.get('/v1/manga/source/sw:10')).status).toBe(200);
    for (const path of ['/v1/manga/source/sw:9?adult=1', '/v1/manga/source/sw:9/cover', '/v1/manga/source/sw:404']) {
      expect((await b.get(path)).status, path).toBe(404);
    }
    expect((await b.get('/v1/manga/source/sw:abc')).status).toBe(400);
  });
});

describe('a series’ copies', () => {
  const uploadsBy = (groups: Array<[string, number]>) => {
    const out: Array<{ n: number; by: string; width: number }> = [];
    for (const [by, width] of groups) {
      for (let n = 1; n <= 4; n++) out.push({ n, by, width });
    }
    return out;
  };

  it('measures each group’s pages on the same chapter, and keeps what it found a day', async () => {
    const keys = new Map<string, number>();
    const store: Store = {
      async get() {
        return undefined;
      },
      async set(key, _value, ttl) {
        keys.set(key, ttl);
      },
    };
    const { b, sw } = await setup([], store);
    sw.state.series = [{ id: 7, source: '11', title: 'Haikyu!!', uploads: uploadsBy([['official', 700], ['unofficial', 1067]]) }];
    const r = await b.get('/v1/manga/source/sw:7/copies');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      chapters: 4,
      copies: [
        { group: { id: 'official', name: 'official' }, chapters: 4, width: 700, height: 1600 },
        { group: { id: 'unofficial', name: 'unofficial' }, chapters: 4, width: 1067, height: 1600 },
      ],
    });
    // Two pages from the middle of chapter 3 in each.
    expect(sw.calls.filter((c) => c.op === 'picture')).toHaveLength(4);
    expect(keys.get('manga:v1:copies:sw:7:')).toBe(24 * HOUR);
  });

  it('says so when not one page could be measured, and keeps nothing', async () => {
    const keys = new Map<string, number>();
    const store: Store = {
      async get() {
        return undefined;
      },
      async set(key, _value, ttl) {
        keys.set(key, ttl);
      },
    };
    const { b, sw } = await setup([], store);
    // Its pages are too short to say their size.
    sw.state.series = [{ id: 8, source: '11', title: 'Blank' }];
    const r = await b.get('/v1/manga/source/sw:8/copies');
    expect(r.status).toBe(503);
    expect(r.body.code).toBe('manga_unreachable');
    expect(keys.has('manga:v1:copies:sw:8:')).toBe(false);
    expect((await b.get('/v1/manga/source/sw:abc/copies')).status).toBe(400);
  });

  it('keys each series a search finds by its names, an edition said apart', async () => {
    const { b, sw } = await setup();
    sw.state.series = [
      { id: 7, source: '11', title: 'Haikyuu!!' },
      { id: 9, source: '33', title: 'Haikyu!! (Color)' },
    ];
    const r = await b.get('/v1/manga/search?q=haikyu&lang=en');
    const named = r.body.items.map((x: MangaFound) => [x.card.title, x.keys, x.edition]);
    expect(named).toEqual([
      ['Haikyuu!!', ['haikyu'], null],
      ['Haikyu!! (Color)', ['haikyu'], 'Color'],
    ]);
  });
});

describe('how a search ranks', () => {
  const found = (source: string, title: string, side = false, names = [title]): Found => ({
    item: { kind: 'source', source, card: { id: `sw:${title.length}`, title, cover: null, status: null, adult: false, side, kind: null } },
    names,
  });
  const place = (key: string, name: string, lot: Place['lot']): Place => ({ key, name, lot });
  const titlesOf = (items: MangaFound[]) => items.map((x) => `${x.source}: ${x.card.title}`);

  it('puts what was searched for first, then what more places have, then each place in turn, side works last', () => {
    const a = place('sw1', 'A', async () => ({ found: [], next: null }));
    const c = place('sw2', 'C', async () => ({ found: [], next: null }));
    const items = rank('berserk', [
      { place: a, found: [found('A', 'Vagabond'), found('A', 'Berserk: Fan Book', true), found('A', 'Monster')] },
      { place: c, found: [found('C', 'Monster'), found('C', 'Bérserk!'), found('C', 'Pluto')] },
    ]);
    expect(titlesOf(items)).toEqual(['C: Bérserk!', 'C: Monster', 'A: Monster', 'A: Vagabond', 'C: Pluto', 'A: Berserk: Fan Book']);
  });

  it('tells the same series by any of its names', () => {
    const md = place('md', 'MangaDex', async () => ({ found: [], next: null }));
    const sw = place('sw1', 'Asura Scans', async () => ({ found: [], next: null }));
    const items = rank(undefined, [
      { place: sw, found: [found('Asura Scans', 'Other'), found('Asura Scans', 'Frieren: Beyond Journey’s End')] },
      { place: md, found: [found('MangaDex', 'Sousou no Frieren', false, ['Sousou no Frieren', 'Frieren: Beyond Journey’s End'])] },
    ]);
    expect(titlesOf(items)).toEqual(['MangaDex: Sousou no Frieren', 'Asura Scans: Frieren: Beyond Journey’s End', 'Asura Scans: Other']);
    expect(seriesName('Omniscient Reader’s Viewpoint').key).toBe(seriesName("OMNISCIENT  reader's viewpoint!").key);
  });

  it('asks a late place again with the next lot, and leaves out one that failed', async () => {
    const quick = place('md', 'MangaDex', async () => ({ found: [found('MangaDex', 'Quick')], next: '10' }));
    const late = place('sw7', 'Late Scans', () => new Promise(() => {}));
    const broken = place('sw5', 'Broken', async () => {
      throw new Error('nope');
    });
    const r = await find([quick, late, broken], undefined, undefined, 50);
    expect(titlesOf(r.items)).toEqual(['MangaDex: Quick']);
    expect(r.next).toBe('sw7:0,md:10');

    const asked: string[] = [];
    const watch = (p: Place): Place => place(p.key, p.name, (at) => {
      asked.push(`${p.key}:${at}`);
      return p.lot(at);
    });
    await find([watch(quick), watch(late), watch(broken)], undefined, 'md:10', 50);
    expect(asked).toEqual(['md:10']);
  });

  it('waits a while longer for the first place to come when every one is late', async () => {
    const slow = place('sw1', 'Slow Scans', () => new Promise((done) => setTimeout(() => done({ found: [found('Slow Scans', 'Slow')], next: '10' }), 100)));
    const stuck = place('sw2', 'Stuck Scans', () => new Promise(() => {}));
    const r = await find([slow, stuck], undefined, undefined, 20);
    expect(titlesOf(r.items)).toEqual(['Slow Scans: Slow']);
    expect(r.next).toBe('sw1:10,sw2:0');
  });

  it('says why when every place failed', async () => {
    const broken = place('sw5', 'Broken', async () => {
      throw new Error('nope');
    });
    await expect(find([broken], undefined, undefined, 50)).rejects.toThrow('nope');
  });
});

describe('browsing the quick sources, searching every one', () => {
  /** Four series in Asura Scans, four in Manga Demon, whose site takes 150 ms over every call. */
  function quickAndSlow(sw: ReturnType<typeof fakeSuwayomi>) {
    for (const n of [1, 2, 3, 4]) {
      sw.state.series.push({ id: n, source: '11', title: `Quick ${n}` });
      sw.state.series.push({ id: 10 + n, source: '22', title: `Slow ${n}` });
    }
    sw.state.lag.set('22', 150);
  }
  const listsOf = (sw: ReturnType<typeof fakeSuwayomi>, source: string) => sw.calls.filter((c) => c.op === 'search' && c.source === source).length;

  it('leaves out of browsing a source too slow over a lot it hasn’t seen, and still searches it by name', async () => {
    const { b, sw } = await setup([], undefined, {}, 500);
    quickAndSlow(sw);
    // Not timed yet: asked, and timed.
    let r = await b.get('/v1/manga/search?lang=en');
    expect(shown(r.body)).toContain('Manga Demon: Slow 1');
    const lists = listsOf(sw, '22');

    r = await b.get('/v1/manga/search?lang=en&sort=new');
    expect(shown(r.body).filter((t) => t.startsWith('Manga Demon'))).toEqual([]);
    expect(shown(r.body)).toContain('Asura Scans: Quick 1');
    expect(listsOf(sw, '22')).toBe(lists);

    r = await b.get('/v1/manga/search?q=slow&lang=en');
    expect(shown(r.body)).toContain('Manga Demon: Slow 1');
  });

  it('browses the sources only, and MangaDex too in a search by name', async () => {
    const { b, sw, dexCalls } = await setup(['Dex One']);
    sw.state.series = [{ id: 1, source: '11', title: 'Asura One' }];
    let r = await b.get('/v1/manga/search?lang=en');
    expect(shown(r.body)).toEqual(['Asura Scans: Asura One']);
    expect(dexCalls).toEqual([]);

    r = await b.get('/v1/manga/search?q=one&lang=en');
    expect(shown(r.body).sort()).toEqual(['Asura Scans: Asura One', 'MangaDex: Dex One']);
  });

  it('browses MangaDex when Suwayomi is down', async () => {
    const { b, sw } = await setup(['Dex One']);
    sw.state.down = true;
    const r = await b.get('/v1/manga/search?lang=en');
    expect(r.status).toBe(200);
    expect(shown(r.body)).toEqual(['MangaDex: Dex One']);
  });

  it('browses the quickest source when not one is quick enough', async () => {
    const { b, sw } = await setup([], undefined, {}, 500);
    sw.state.sources = sw.state.sources.filter((s) => s.id === '11' || s.id === '22');
    quickAndSlow(sw);
    sw.state.lag.set('11', 100);
    // Not timed yet: both asked, and both found too slow.
    let r = await b.get('/v1/manga/search?lang=en');
    expect(shown(r.body)).toContain('Manga Demon: Slow 1');
    const lists = listsOf(sw, '22');

    r = await b.get('/v1/manga/search?lang=en&sort=new');
    expect(shown(r.body)).toEqual(['Asura Scans: Quick 1', 'Asura Scans: Quick 2', 'Asura Scans: Quick 3', 'Asura Scans: Quick 4']);
    expect(listsOf(sw, '22')).toBe(lists);
  });

  it('looking for one series’ copies, checks only the series going by its name', async () => {
    const { b, sw, dexCalls } = await setup(['Haikyuu!!', 'Haikyu Fan Book']);
    sw.state.series = [
      { id: 1, source: '11', title: 'Haikyu!!' },
      { id: 2, source: '11', title: 'Haikyu!! dj - Rally' },
      { id: 3, source: '11', title: 'Haikyu!! (Color)' },
    ];
    const r = await b.get('/v1/manga/search?q=haikyu&lang=en&names=haikyu');
    expect(r.status).toBe(200);
    expect(shown(r.body).sort()).toEqual(['Asura Scans: Haikyu!!', 'Asura Scans: Haikyu!! (Color)', 'MangaDex: Haikyuu!!']);
    expect(sw.calls.filter((c) => c.op === 'series')).toHaveLength(2);
    expect(dexCalls.filter((u) => u.pathname.endsWith('/feed'))).toHaveLength(1);

    const bad = await b.get('/v1/manga/search?q=haikyu&lang=en&names=haikyu!!');
    expect(bad.status).toBe(400);
  });

  it('looking for one series’ copies, takes one list from MangaDex a lot, even with none of them', async () => {
    const others = Array.from({ length: 25 }, (_, i) => `Other ${i + 1}`);
    const { b, dexCalls } = await setup(others);
    const r = await b.get('/v1/manga/search?q=haikyu&lang=en&names=haikyu');
    expect(r.status).toBe(200);
    expect(r.body.items).toEqual([]);
    expect(dexCalls.filter((u) => u.pathname === '/manga')).toHaveLength(1);
    expect(r.body.next).toBe('md:10');
  });

  it('checks each quick source’s Popular and Updated first lots ahead of readers, and stops at a slow one', async () => {
    const { b, sw, manga, dexCalls } = await setup(['Dex One'], undefined, {}, 500);
    quickAndSlow(sw);
    await manga.warm();
    // MangaDex isn't browsed beside the sources, so isn't checked ahead either.
    expect(dexCalls).toEqual([]);
    // Asura Scans: Popular and Updated. Manga Demon has no Updated, and one lot showed it slow.
    expect(listsOf(sw, '11')).toBe(2);
    expect(listsOf(sw, '22')).toBe(1);

    // Browse as it first opens: Asura Scans' series all checked already, Manga Demon left out.
    const before = sw.calls.length;
    const r = await b.get('/v1/manga/search?lang=en');
    expect(shown(r.body)).toEqual(['Asura Scans: Quick 1', 'Asura Scans: Quick 2', 'Asura Scans: Quick 3', 'Asura Scans: Quick 4']);
    expect(sw.calls.slice(before).filter((c) => c.op === 'series' || c.op === 'chapters')).toEqual([]);
  });
});
