import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newLibraryKey, type MangaFound } from '@breader/shared';
import { describe, expect, it } from 'vitest';
import { makeApp } from '../src/app.ts';
import type { Store } from '../src/lib/cache.ts';
import { find, plainTitle, rank, type Found, type Place } from '../src/manga/find.ts';
import { makeManga } from '../src/manga/index.ts';
import { browser, deps } from './helpers.ts';

/*
 * One search across MangaDex, Breader's Suwayomi sources and its Komga library, each a server of
 * our own answering as the real one does, so what a search shows, in what order, and how it reads
 * a series from each can be checked.
 */

const png = (n: number) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, n]);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const MIN = 60_000;
const HOUR = 60 * MIN;

/** MangaDex with these series, each ended with its three chapters all here. */
function fakeDex(titles: string[]) {
  const uuid = (n: number) => `e0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const data = titles.map((title, i) => ({
    id: uuid(i + 1),
    type: 'manga',
    attributes: { title: { en: title }, altTitles: [], status: 'completed', lastChapter: '3', contentRating: 'safe', tags: [], availableTranslatedLanguages: ['en'], originalLanguage: 'ja', latestUploadedChapter: 'up' },
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
      return json({ result: 'ok', data: data.slice(offset, offset + limit), total: data.length, limit, offset });
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
      const numbers = s.chapters ?? [1, 2, 3];
      const chapters = numbers.map((n, i) => ({ id: s.id * 1000 + i, name: `Chapter ${n}`, chapterNumber: n, scanlator: i === 0 ? 'Some Scans' : null, uploadDate: '1700000000000', sourceOrder: i + 1 }));
      return { data: { fetchChapters: { chapters } } };
    }
    if (query.includes('chapter(id')) return { data: { chapter: { mangaId: Math.floor(v.id / 1000) } } };
    if (query.includes('fetchChapterPages')) {
      calls.push({ op: 'pages' });
      const manga = Math.floor(v.id / 1000);
      return { data: { fetchChapterPages: { pages: [0, 1, 2].map((p) => `/api/v1/manga/${manga}/chapter/1/page/${p}`) } } };
    }
    return refuse('Unknown query');
  }

  async function answer(url: URL, init: RequestInit) {
    if (url.pathname === '/api/graphql') {
      const body = JSON.parse(String(init.body));
      return json(graphql(body.query, body.variables));
    }
    let m = /^\/api\/v1\/manga\/(\d+)\/thumbnail$/.exec(url.pathname);
    if (m) {
      calls.push({ op: 'thumbnail' });
      return new Response(png(9));
    }
    m = /^\/api\/v1\/manga\/(\d+)\/chapter\/\d+\/page\/(\d+)$/.exec(url.pathname);
    if (m) {
      calls.push({ op: 'picture' });
      return new Response(png(Number(m[2])));
    }
    return new Response('nope', { status: 404 });
  }
  return { state, calls, answer };
}

interface KgSeries {
  id: string;
  title: string;
  ageRating?: number | null;
  genres?: string[];
  language?: string;
  /** Its books: pictures (DIVINA) or text (EPUB). */
  profile?: string;
  books?: number;
}

/** Komga with a library, answering only with Breader's key. */
function fakeKomga() {
  const KEY = 'komga-test-key';
  const state = { series: [] as KgSeries[] };
  const calls: URL[] = [];
  const raw = (s: KgSeries) => ({
    id: s.id,
    name: s.title,
    booksCount: s.books ?? 2,
    metadata: { title: s.title, status: 'ENDED', ageRating: s.ageRating ?? null, language: s.language ?? '', summary: 'A comic.', genres: s.genres ?? [], tags: [], alternateTitles: [], links: [{ url: 'javascript:alert(1)' }] },
    booksMetadata: { authors: [{ name: 'An Artist', role: 'penciller' }], tags: [] },
  });
  const books = (s: KgSeries) =>
    Array.from({ length: s.books ?? 2 }, (_, i) => ({
      id: `${s.id}B${i + 1}`,
      seriesId: s.id,
      created: '2026-10-07T05:39:46Z',
      metadata: { number: String(i + 1), title: `${s.title} v0${i + 1}` },
      media: { pagesCount: 8, mediaProfile: s.profile ?? 'DIVINA', epubDivinaCompatible: false },
    }));
  function answer(url: URL, init: RequestInit) {
    calls.push(url);
    if (new Headers(init.headers).get('x-api-key') !== KEY) return new Response('{}', { status: 401 });
    const path = url.pathname;
    if (path === '/api/v1/series') {
      let list = state.series;
      const search = url.searchParams.get('search');
      if (search) list = list.filter((s) => s.title.toLowerCase().includes(search.toLowerCase()));
      const page = Number(url.searchParams.get('page'));
      const size = Number(url.searchParams.get('size'));
      const content = list.slice(page * size, page * size + size).map(raw);
      return json({ content, last: page * size + size >= list.length });
    }
    let m = /^\/api\/v1\/series\/([0-9A-Z]+)$/.exec(path);
    if (m) {
      const s = state.series.find((x) => x.id === m![1]);
      if (!s) return json({}, 404);
      return json(raw(s));
    }
    m = /^\/api\/v1\/series\/([0-9A-Z]+)\/books$/.exec(path);
    if (m) {
      const s = state.series.find((x) => x.id === m![1])!;
      let content = books(s);
      if (url.searchParams.get('size') === '1') content = content.slice(0, 1);
      return json({ content, last: true });
    }
    m = /^\/api\/v1\/books\/([0-9A-Z]+)$/.exec(path);
    if (m) {
      const all = state.series.flatMap(books);
      const b = all.find((x) => x.id === m![1]);
      if (!b) return json({}, 404);
      return json(b);
    }
    m = /^\/api\/v1\/books\/([0-9A-Z]+)\/pages\/(\d+)$/.exec(path);
    if (m) return new Response(png(Number(m[2])));
    if (/^\/api\/v1\/series\/[0-9A-Z]+\/thumbnail$/.test(path)) return new Response(png(7));
    return json({}, 404);
  }
  return { state, calls, answer };
}

async function setup(dexTitles: string[] = [], store?: Store) {
  const sw = fakeSuwayomi();
  const kg = fakeKomga();
  const dex = fakeDex(dexTitles);
  const dexCalls: URL[] = [];
  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    if (url.host === 'api.mangadex.org') {
      dexCalls.push(url);
      return dex(url);
    }
    if (url.host === 'suwayomi.test') return sw.answer(url, init);
    if (url.host === 'komga.test') return kg.answer(url, init);
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
    komga: { url: 'http://komga.test', key: 'komga-test-key' },
  });
  const app = makeApp({ ...deps, manga });
  const b = browser(undefined, app);
  const r = await b.post('/v1/libraries', { libraryId: crypto.randomUUID(), key: newLibraryKey() });
  expect(r.status).toBe(201);
  return { sw, kg, dexCalls, app, b };
}

const shown = (body: { items: MangaFound[] }) => body.items.map((x) => `${x.source}: ${x.card.title}`);

describe('one search everywhere', () => {
  it('shows the same series once for each place that has it, side by side, the one searched for first', async () => {
    const { b, sw, kg } = await setup(['Omniscient Reader’s Viewpoint', 'Omniscient Reader Fan Club']);
    sw.state.series = [
      { id: 1, source: '11', title: 'Omniscient Reader’s Viewpoint' },
      { id: 2, source: '22', title: 'Omniscient' },
      { id: 3, source: '22', title: "Omniscient Reader's Viewpoint" },
    ];
    kg.state.series = [{ id: 'KSERIES001', title: "OMNISCIENT READER'S VIEWPOINT" }];
    const r = await b.get('/v1/manga/search?q=omniscient&lang=en');
    expect(r.status).toBe(200);
    expect(shown(r.body)).toEqual([
      'Manga Demon: Omniscient',
      'Asura Scans: Omniscient Reader’s Viewpoint',
      "Komga: OMNISCIENT READER'S VIEWPOINT",
      'MangaDex: Omniscient Reader’s Viewpoint',
      "Manga Demon: Omniscient Reader's Viewpoint",
      'MangaDex: Omniscient Reader Fan Club',
    ]);
    const kinds = r.body.items.map((x: MangaFound) => x.kind);
    expect(kinds).toEqual(['source', 'source', 'source', 'mangadex', 'source', 'mangadex']);
    expect(r.body.items[1].card).toEqual({ id: 'sw:1', title: 'Omniscient Reader’s Viewpoint', cover: '/v1/manga/source/sw:1/cover', status: 'ongoing', adult: false, side: false });
    expect(r.body.items[2].card).toMatchObject({ id: 'kg:KSERIES001', status: 'completed' });
    // Every place had nothing more.
    expect(r.body.next).toBeNull();
    expect(sw.calls.filter((c) => c.op === 'search').map((c) => c.type)).toEqual(['SEARCH', 'SEARCH', 'SEARCH']);
  });

  it('goes on without a source that fails, and answers an empty lot when the rest found nothing', async () => {
    const { b, sw, kg } = await setup();
    sw.state.series = [{ id: 1, source: '11', title: 'Solo Leveling' }];
    sw.state.broken.add('33');
    const r = await b.get('/v1/manga/search?q=solo&lang=en');
    expect(r.status).toBe(200);
    expect(shown(r.body)).toEqual(['Asura Scans: Solo Leveling']);

    sw.state.broken = new Set(['11', '22', '33']);
    kg.state.series = [];
    const none = await b.get('/v1/manga/search?q=none&lang=en');
    // MangaDex and Komga answered, with nothing: an empty lot, not an error.
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

  it('keeps 18+ out unless asked, loli and shota always, and doujinshi and anthologies unless asked, after the rest', async () => {
    const { b, sw, kg } = await setup();
    sw.state.series = [
      { id: 1, source: '11', title: 'Plain' },
      { id: 2, source: '11', title: 'Spicy', genre: ['Hentai'] },
      { id: 3, source: '11', title: 'Never', genre: ['Loli'] },
      { id: 4, source: '11', title: 'Fan work', genre: ['Doujinshi'] },
      { id: 5, source: '11', title: 'Many hands', genre: ['Anthology'] },
      { id: 6, source: '44', title: 'Late show' },
    ];
    kg.state.series = [
      { id: 'KSERIES001', title: 'Grown-up comic', ageRating: 18 },
      { id: 'KSERIES002', title: 'A novel', profile: 'EPUB' },
      { id: 'KSERIES003', title: 'Shota thing', genres: ['shota'] },
    ];
    const plain = await b.get('/v1/manga/search');
    expect(shown(plain.body)).toEqual(['Asura Scans: Plain']);
    const adult = await b.get('/v1/manga/search?adult=1');
    expect(shown(adult.body).sort()).toEqual(['Asura Scans: Plain', 'Asura Scans: Spicy', 'Komga: Grown-up comic', 'Late Night: Late show']);
    expect(adult.body.items.filter((x: MangaFound) => x.kind === 'source' && x.card.adult)).toHaveLength(3);
    const side = await b.get('/v1/manga/search?doujinshi=1');
    expect(shown(side.body)).toEqual(['Asura Scans: Plain', 'Asura Scans: Fan work', 'Asura Scans: Many hands']);
    expect(side.body.items.map((x: MangaFound) => x.card.side)).toEqual([false, true, true]);
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
    const titles = Array.from({ length: 15 }, (_, i) => `Dex ${i + 1}`);
    const { b, sw, kg, dexCalls } = await setup(titles);
    sw.state.series = Array.from({ length: 25 }, (_, i) => ({ id: i + 1, source: '22', title: `Demon ${i + 1}` }));
    kg.state.series = Array.from({ length: 12 }, (_, i) => ({ id: `KSERIES${String(i + 1).padStart(3, '0')}`, title: `Comic ${i + 1}` }));
    const first = await b.get('/v1/manga/search?lang=en&sort=latest');
    expect(first.body.items).toHaveLength(30);
    expect(first.body.next).toBe('kg:1,sw22:1.10,md:10');
    // Manga Demon has no Latest, so its Popular instead.
    expect(sw.calls.find((c) => c.source === '22')?.type).toBe('POPULAR');

    const second = await b.get(`/v1/manga/search?lang=en&sort=latest&next=${first.body.next}`);
    expect(shown(second.body).slice(0, 3)).toEqual(['Komga: Comic 11', 'Manga Demon: Demon 11', 'MangaDex: Dex 11']);
    expect(second.body.items).toHaveLength(17);
    expect(second.body.next).toBe('sw22:2');

    const asked = dexCalls.length;
    const third = await b.get(`/v1/manga/search?lang=en&sort=latest&next=${second.body.next}`);
    expect(shown(third.body)).toEqual(['Manga Demon: Demon 21', 'Manga Demon: Demon 22', 'Manga Demon: Demon 23', 'Manga Demon: Demon 24', 'Manga Demon: Demon 25']);
    expect(third.body.next).toBeNull();
    expect(dexCalls).toHaveLength(asked);
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
    expect(keys.get('manga:v1:kg-search:page=0&size=10&sort=metadata.titleSort%2Casc')).toBe(MIN);
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
      { id: 8, source: '44', title: 'After dark' },
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
    for (const path of ['/v1/manga/source/sw:9?adult=1', '/v1/manga/source/sw:9/cover', '/v1/manga/source/sw:404']) {
      expect((await b.get(path)).status, path).toBe(404);
    }
    expect((await b.get('/v1/manga/source/sw:abc')).status).toBe(400);
  });

  it('opens a Komga series, its books as chapters and their pages, and leaves books as text out', async () => {
    const { b, app, kg } = await setup();
    kg.state.series = [
      { id: 'KSERIES001', title: 'Komga Test Comic', language: 'en' },
      { id: 'KSERIES002', title: 'Alice', profile: 'EPUB' },
    ];
    const r = await b.get('/v1/manga/source/kg:KSERIES001');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: 'kg:KSERIES001', title: 'Komga Test Comic', status: 'completed', source: 'Komga', authors: ['An Artist'], description: 'A comic.', link: null });
    const list = await b.get('/v1/manga/source/kg:KSERIES001/chapters');
    expect(list.body.chapters.map((c: { id: string; chapter: string; pages: number }) => [c.id, c.chapter, c.pages])).toEqual([
      ['kg:KSERIES001B1', '1', 8],
      ['kg:KSERIES001B2', '2', 8],
    ]);
    expect((await browser(undefined, app).get('/v1/manga/source/chapter/kg:KSERIES001B2/0')).status).toBe(401);
    expect((await b.get('/v1/manga/source/chapter/kg:KSERIES001B2')).body).toEqual({ pages: 8 });
    const page = await b.get('/v1/manga/source/chapter/kg:KSERIES001B2/0');
    expect(page.status).toBe(200);
    // Komga counts pages from 1.
    expect(kg.calls.at(-1)!.pathname).toBe('/api/v1/books/KSERIES001B2/pages/1');
    const past = await b.get('/v1/manga/source/chapter/kg:KSERIES001B2/8');
    expect(past.status).toBe(404);
    expect(past.body.message).toBe('That chapter has no page there.');
    expect((await b.get('/v1/manga/source/kg:KSERIES001/cover')).status).toBe(200);
    expect((await b.get('/v1/manga/source/kg:KSERIES002')).status).toBe(404);
    expect((await b.get('/v1/manga/source/chapter/kg:KSERIES002B1/0')).status).toBe(404);
  });
});

describe('how a search ranks', () => {
  const found = (source: string, title: string, side = false, names = [title]): Found => ({
    item: { kind: 'source', source, card: { id: `sw:${title.length}`, title, cover: null, status: null, adult: false, side } },
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
    expect(plainTitle('Omniscient Reader’s Viewpoint')).toBe(plainTitle("OMNISCIENT  reader's viewpoint!"));
  });

  it('asks a late place again with the next lot, and leaves out one that failed', async () => {
    const quick = place('md', 'MangaDex', async () => ({ found: [found('MangaDex', 'Quick')], next: '10' }));
    const late = place('kg', 'Komga', () => new Promise(() => {}));
    const broken = place('sw5', 'Broken', async () => {
      throw new Error('nope');
    });
    const r = await find([quick, late, broken], undefined, undefined, 50);
    expect(titlesOf(r.items)).toEqual(['MangaDex: Quick']);
    expect(r.next).toBe('kg:0,md:10');

    const asked: string[] = [];
    const watch = (p: Place): Place => place(p.key, p.name, (at) => {
      asked.push(`${p.key}:${at}`);
      return p.lot(at);
    });
    await find([watch(quick), watch(late), watch(broken)], undefined, 'md:10', 50);
    expect(asked).toEqual(['md:10']);
  });

  it('says why when every place failed', async () => {
    const broken = place('sw5', 'Broken', async () => {
      throw new Error('nope');
    });
    await expect(find([broken], undefined, undefined, 50)).rejects.toThrow('nope');
  });
});
