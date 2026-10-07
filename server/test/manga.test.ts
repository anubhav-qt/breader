import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newLibraryKey } from '@breader/shared';
import { describe, expect, it } from 'vitest';
import { makeApp } from '../src/app.ts';
import { Disk } from '../src/manga/disk.ts';
import { DOUJINSHI_ID, makeManga, plain, USER_AGENT } from '../src/manga/mangadex.ts';
import { Gate, Pace } from '../src/manga/pace.ts';
import { app as plainApp, browser, deps } from './helpers.ts';

/*
 * A MangaDex of our own, answering the calls Breader makes as MangaDex does, so the rules it keeps
 * can be checked: who it says it is, what it leaves out, what it reports, and how little it asks.
 */

const FRIEREN = 'a1c7c817-4e59-43b7-9365-09675a149a6f';
const ADULT = 'b2c7c817-4e59-43b7-9365-09675a149a6f';
const NEVER = 'c3c7c817-4e59-43b7-9365-09675a149a6f';
const LOLI = '2d1f5d56-a1e5-4d0d-a961-2193588b08ec';
const SHOTA = 'ddefd648-5140-4e5f-ba18-4eca4071d19b';
const ch = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const tag = (id: string, name: string, group = 'theme') => ({ id, type: 'tag', attributes: { name: { en: name }, group } });
const series = (id: string, over: Record<string, unknown> = {}, tags = [tag('t-adv', 'Adventure', 'genre')]) => ({
  id,
  type: 'manga',
  attributes: {
    title: { en: 'Sousou no Frieren' },
    altTitles: [{ en: 'Frieren: Beyond Journey’s End' }, { ja: '葬送のフリーレン' }],
    description: { en: 'The **demon king** is dead.\n\n---\n\n[Official site](https://example.com)' },
    links: { engtl: 'https://www.viz.com/frieren', al: '118586', mal: '126287', amz: 'javascript:alert(1)', raw: 'https://websunday.net/frieren' },
    originalLanguage: 'ja',
    publicationDemographic: 'shounen',
    status: 'ongoing',
    year: 2020,
    contentRating: 'safe',
    tags,
    availableTranslatedLanguages: ['en', 'pt-br', null],
    ...over,
  },
  relationships: [
    { id: 'a1', type: 'author', attributes: { name: 'Yamada Kanehito' } },
    { id: 'a2', type: 'artist', attributes: { name: 'Abe Tsukasa' } },
    { id: 'c1', type: 'cover_art', attributes: { fileName: 'cover-1.jpg' } },
  ],
});
const SERIES: Record<string, ReturnType<typeof series>> = {
  [FRIEREN]: series(FRIEREN),
  [ADULT]: series(ADULT, { title: { en: 'Grown-ups' }, contentRating: 'erotica' }),
  [NEVER]: series(NEVER, { title: { en: 'Never' } }, [tag(LOLI, 'Loli')]),
};

const chapter = (n: number, over: Record<string, unknown> = {}, groups = [{ id: 'g1', type: 'scanlation_group', attributes: { name: 'Frieren Scans' } }]) => ({
  id: ch(n),
  type: 'chapter',
  attributes: { volume: '1', chapter: String(n), title: `Chapter ${n}`, translatedLanguage: 'en', externalUrl: null, publishAt: '2023-01-01T00:00:00+00:00', readableAt: '2023-01-01T00:00:00+00:00', pages: 3, ...over },
  relationships: [...groups, { id: FRIEREN, type: 'manga' }],
});
/** 503 chapters, so the list comes in two calls; a few aren't readable. */
const FEED = [
  ...Array.from({ length: 500 }, (_, i) => chapter(i + 1)),
  chapter(501, { externalUrl: 'https://mangaplus.shueisha.co.jp/viewer/1', pages: 0 }, []),
  chapter(502, { readableAt: '2999-01-01T00:00:00+00:00' }),
  chapter(503, { pages: 0 }),
  chapter(504, { isUnavailable: true }),
];

const png = (n: number) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, n]);
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1]);

/** What our MangaDex was asked, and how it answers. */
function fakeDex() {
  const calls: Array<{ url: URL; ua: string | null; method: string; body?: string }> = [];
  const state = { busy: false, brokenNode: false, home: 'https://node1.mangadex.network', notPicture: false };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const headers = new Headers(init.headers);
    calls.push({ url, ua: headers.get('user-agent'), method: init.method ?? 'GET', body: init.body as string | undefined });
    const path = url.pathname;
    if (url.host === 'api.mangadex.org') {
      if (state.busy) return new Response('{}', { status: 429, headers: { 'x-ratelimit-retry-after': String(Math.floor(Date.now() / 1000) + 2) } });
      if (path === '/manga/tag') return json({ result: 'ok', data: [tag(LOLI, 'Loli'), tag(SHOTA, 'Shota'), tag('t-adv', 'Adventure', 'genre')] });
      if (path === '/manga') {
        const adult = url.searchParams.getAll('contentRating[]').includes('erotica');
        // A series MangaDex should have left out, to check it's left out anyway.
        const data = [SERIES[FRIEREN], SERIES[NEVER], ...(adult ? [SERIES[ADULT]] : [])];
        return json({ result: 'ok', data, total: data.length, limit: 30, offset: 0 });
      }
      let m = /^\/manga\/([0-9a-f-]{36})$/.exec(path);
      if (m) return SERIES[m[1]] ? json({ result: 'ok', data: SERIES[m[1]] }) : json({ result: 'error' }, 404);
      m = /^\/manga\/([0-9a-f-]{36})\/feed$/.exec(path);
      if (m) {
        const offset = Number(url.searchParams.get('offset'));
        const limit = Number(url.searchParams.get('limit'));
        return json({ result: 'ok', data: FEED.slice(offset, offset + limit), total: FEED.length, limit, offset });
      }
      m = /^\/chapter\/([0-9a-f-]{36})$/.exec(path);
      if (m) return json({ result: 'ok', data: { ...chapter(1), id: m[1], relationships: [{ id: m[1] === ch(999) ? NEVER : FRIEREN, type: 'manga' }] } });
      m = /^\/at-home\/server\/([0-9a-f-]{36})$/.exec(path);
      if (m) {
        const base = state.home;
        // Asked again for a fresh server, it gives the next.
        if (state.brokenNode) state.home = 'https://node2.mangadex.network';
        return json({ result: 'ok', baseUrl: base, chapter: { hash: `hash${m[1].slice(-3)}`, data: ['x1-a.png', 'x2-b.png', 'x3-c.png'], dataSaver: ['x1-a.jpg', 'x2-b.jpg', 'x3-c.jpg'] } });
      }
      return json({ result: 'error' }, 404);
    }
    if (url.host === 'api.mangadex.network' && path === '/report') return json({ result: 'ok' });
    if (url.host.endsWith('.mangadex.network') || url.host === 'uploads.mangadex.org') {
      if (url.host === 'node1.mangadex.network' && state.brokenNode) return new Response('gone', { status: 403 });
      if (state.notPicture) return new Response('<html>nope</html>', { status: 200, headers: { 'x-cache': 'MISS' } });
      if (path.startsWith('/covers/')) return new Response(jpeg, { headers: { 'content-type': 'image/jpeg' } });
      const n = Number(/x(\d)-/.exec(path)?.[1] ?? 0);
      return new Response(png(n), { headers: { 'content-type': 'image/png', 'x-cache': 'HIT' } });
    }
    return new Response('no such host', { status: 502 });
  }) as typeof globalThis.fetch;
  return { fetch, calls, state, asked: (host: string, re: RegExp) => calls.filter((c) => c.url.host === host && re.test(c.url.pathname)) };
}

async function setup() {
  const dex = fakeDex();
  const dir = await mkdtemp(join(tmpdir(), 'breader-manga-'));
  const manga = makeManga({ dir, cacheBytes: 64 * 1024 * 1024, fetch: dex.fetch, pace: { api: [1000, 1000], home: [1000, 1000] } });
  const app = makeApp({ ...deps, manga });
  const b = browser(undefined, app);
  const r = await b.post('/v1/libraries', { libraryId: crypto.randomUUID(), key: newLibraryKey() });
  expect(r.status).toBe(201);
  return { dex, dir, app, b };
}

describe('MangaDex through the laptop', () => {
  it('says whether it’s on, and is off on a server without it', async () => {
    const { b } = await setup();
    expect((await b.get('/v1/manga')).body).toEqual({ on: true });
    const off = browser(undefined, plainApp);
    expect((await off.get('/v1/manga')).body).toEqual({ on: false });
    const r = await off.get('/v1/manga/search');
    expect(r.status).toBe(503);
    expect(r.body.code).toBe('manga_off');
  });

  it('lets anyone look, and only browsers signed in to a library read pages', async () => {
    const { app } = await setup();
    const stranger = browser(undefined, app);
    expect((await stranger.get('/v1/manga/search?q=frieren')).status).toBe(200);
    expect((await stranger.get(`/v1/manga/series/${FRIEREN}/chapters`)).status).toBe(200);
    expect((await stranger.get(`/v1/manga/cover/${FRIEREN}/cover-1.jpg`)).status).toBe(200);
    const r = await stranger.get(`/v1/manga/chapter/${ch(1)}/0`);
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('signed_out');
  });

  it('searches as itself, leaving out 18+ series unless asked and loli and shota always', async () => {
    const { b, dex } = await setup();
    const r = await b.get('/v1/manga/search?q=frieren&lang=en');
    expect(r.status).toBe(200);
    expect(r.body.items.map((x: { id: string }) => x.id)).toEqual([FRIEREN]);
    expect(r.body.items[0]).toEqual({
      id: FRIEREN,
      title: 'Sousou no Frieren',
      cover: 'cover-1.jpg',
      rating: 'safe',
      status: 'ongoing',
      year: 2020,
      langs: ['en', 'pt-br'],
      original: 'ja',
      authors: ['Yamada Kanehito'],
    });
    const [search] = dex.asked('api.mangadex.org', /^\/manga$/);
    expect(search.ua).toBe(USER_AGENT);
    expect(search.url.searchParams.getAll('contentRating[]')).toEqual(['safe', 'suggestive']);
    expect(search.url.searchParams.getAll('excludedTags[]').sort()).toEqual([LOLI, SHOTA, DOUJINSHI_ID].sort());
    expect(search.url.searchParams.get('excludedTagsMode')).toBe('OR');
    expect(search.url.searchParams.getAll('availableTranslatedLanguage[]')).toEqual(['en']);
    expect(search.url.searchParams.get('title')).toBe('frieren');
    expect(search.url.searchParams.get('order[relevance]')).toBe('desc');

    const adult = await b.get('/v1/manga/search?adult=1&sort=latest');
    expect(adult.body.items.map((x: { id: string }) => x.id)).toEqual([FRIEREN, ADULT]);
    const asked = dex.asked('api.mangadex.org', /^\/manga$/).at(-1)!;
    expect(asked.url.searchParams.getAll('contentRating[]')).toEqual(['safe', 'suggestive', 'erotica', 'pornographic']);
    expect(asked.url.searchParams.get('order[latestUploadedChapter]')).toBe('desc');
    expect(asked.url.searchParams.getAll('excludedTags[]')).toContain(LOLI);
  });

  it('leaves doujinshi out unless asked, and keeps the two searches apart', async () => {
    const { b, dex } = await setup();
    await b.get('/v1/manga/search?q=frieren');
    const r = await b.get('/v1/manga/search?q=frieren&doujinshi=1');
    expect(r.status).toBe(200);
    const [off, on] = dex.asked('api.mangadex.org', /^\/manga$/);
    expect(off.url.searchParams.getAll('excludedTags[]')).toContain(DOUJINSHI_ID);
    // After a search that left them out, the kept never-list still hasn't the Doujinshi tag.
    expect(on.url.searchParams.getAll('excludedTags[]').sort()).toEqual([LOLI, SHOTA].sort());
    expect(on.url.searchParams.get('excludedTagsMode')).toBe('OR');
    expect(dex.asked('api.mangadex.org', /^\/manga\/tag$/)).toHaveLength(1);
  });

  it('keeps a search a while instead of asking again', async () => {
    const { b, dex } = await setup();
    await b.get('/v1/manga/search?sort=popular');
    await b.get('/v1/manga/search?sort=popular');
    expect(dex.asked('api.mangadex.org', /^\/manga$/)).toHaveLength(1);
    expect(dex.asked('api.mangadex.org', /^\/manga$/)[0].url.searchParams.get('order[followedCount]')).toBe('desc');
  });

  it('tells a series as plain text, with its official links and only web ones', async () => {
    const { b } = await setup();
    const r = await b.get(`/v1/manga/series/${FRIEREN}`);
    expect(r.status).toBe(200);
    expect(r.body.description).toBe('The demon king is dead.\n\nOfficial site');
    expect(r.body.altTitles).toEqual(['Frieren: Beyond Journey’s End', '葬送のフリーレン']);
    expect(r.body.artists).toEqual(['Abe Tsukasa']);
    expect(r.body.page).toBe(`https://mangadex.org/title/${FRIEREN}`);
    expect(r.body.links).toEqual([
      { kind: 'official', label: 'Official English', url: 'https://www.viz.com/frieren' },
      { kind: 'official', label: 'Official original', url: 'https://websunday.net/frieren' },
      { kind: 'info', label: 'AniList', url: 'https://anilist.co/manga/118586' },
      { kind: 'info', label: 'MyAnimeList', url: 'https://myanimelist.net/manga/126287' },
    ]);
    expect(r.body.tags).toEqual([{ name: 'Adventure', group: 'genre' }]);
  });

  it('opens an 18+ series only when asked, and never a loli or shota one', async () => {
    const { b } = await setup();
    const shut = await b.get(`/v1/manga/series/${ADULT}`);
    expect(shut.status).toBe(403);
    expect(shut.body.code).toBe('manga_adult');
    expect((await b.get(`/v1/manga/series/${ADULT}?adult=1`)).status).toBe(200);
    for (const path of [`/v1/manga/series/${NEVER}?adult=1`, `/v1/manga/series/${NEVER}/chapters`, `/v1/manga/cover/${NEVER}/cover-1.jpg`, `/v1/manga/chapter/${ch(999)}/0`]) {
      const r = await b.get(path);
      expect(r.status, path).toBe(404);
      expect(r.body.code).toBe('manga_not_found');
    }
    expect((await b.get('/v1/manga/series/not-an-id')).status).toBe(400);
  });

  it('lists every chapter it can read, credited, in as many calls as it takes', async () => {
    const { b, dex } = await setup();
    const r = await b.get(`/v1/manga/series/${FRIEREN}/chapters?lang=en`);
    expect(r.status).toBe(200);
    expect(r.body.lang).toBe('en');
    expect(r.body.chapters).toHaveLength(501);
    expect(r.body.chapters[0]).toEqual({ id: ch(1), chapter: '1', volume: '1', title: 'Chapter 1', pages: 3, external: null, groups: [{ id: 'g1', name: 'Frieren Scans' }], at: Date.parse('2023-01-01T00:00:00Z') });
    // Read on its publisher's site instead.
    expect(r.body.chapters[500]).toMatchObject({ chapter: '501', pages: 0, external: 'https://mangaplus.shueisha.co.jp/viewer/1', groups: [] });
    const feeds = dex.asked('api.mangadex.org', /\/feed$/);
    expect(feeds.map((c) => c.url.searchParams.get('offset'))).toEqual(['0', '500']);
    expect(feeds[0].url.searchParams.getAll('translatedLanguage[]')).toEqual(['en']);
    expect(feeds[0].url.searchParams.getAll('includes[]')).toEqual(['scanlation_group']);
    await b.get(`/v1/manga/series/${FRIEREN}/chapters?lang=en`);
    expect(dex.asked('api.mangadex.org', /\/feed$/)).toHaveLength(2);
  });

  it('brings pages from MangaDex@Home, reports them, and keeps them on disk', async () => {
    const { b, dex, dir } = await setup();
    await b.get(`/v1/manga/series/${FRIEREN}/chapters?lang=en`);
    const r = await b.get(`/v1/manga/chapter/${ch(7)}/1`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('image/png');
    expect(r.headers.get('cache-control')).toContain('private');
    const [img] = dex.asked('node1.mangadex.network', /./);
    expect(img.url.pathname).toBe('/data/hash007/x2-b.png');
    expect(img.ua).toBe(USER_AGENT);
    // Seen in the chapter list, so the chapter's series wasn't asked again.
    expect(dex.asked('api.mangadex.org', /^\/chapter\//)).toHaveLength(0);
    await new Promise((done) => setTimeout(done, 10));
    const [report] = dex.asked('api.mangadex.network', /^\/report$/);
    expect(report.method).toBe('POST');
    expect(JSON.parse(report.body!)).toMatchObject({ url: 'https://node1.mangadex.network/data/hash007/x2-b.png', success: true, bytes: 13, cached: true });

    // Again: from the disk, asking MangaDex nothing.
    const again = await b.get(`/v1/manga/chapter/${ch(7)}/1`);
    expect(again.status).toBe(200);
    expect(dex.asked('node1.mangadex.network', /./)).toHaveLength(1);
    expect((await readdir(dir)).length).toBe(1);

    const saver = await b.get(`/v1/manga/chapter/${ch(7)}/0?saver=1`);
    expect(saver.status).toBe(200);
    expect(dex.asked('node1.mangadex.network', /./).at(-1)!.url.pathname).toBe('/data-saver/hash007/x1-a.jpg');
    // One address for the chapter's pages, kept a while.
    expect(dex.asked('api.mangadex.org', /^\/at-home\//)).toHaveLength(1);
    expect((await b.get(`/v1/manga/chapter/${ch(7)}/3`)).status).toBe(404);
  });

  it('asks for another server when one stops answering', async () => {
    const { b, dex } = await setup();
    dex.state.brokenNode = true;
    const r = await b.get(`/v1/manga/chapter/${ch(8)}/0`);
    expect(r.status).toBe(200);
    expect(dex.asked('api.mangadex.org', /^\/at-home\//)).toHaveLength(2);
    expect(dex.asked('node2.mangadex.network', /./)).toHaveLength(1);
    await new Promise((done) => setTimeout(done, 10));
    expect(dex.asked('api.mangadex.network', /^\/report$/).map((c) => JSON.parse(c.body!).success)).toEqual([false, true]);
    // Not in a list yet: its series was looked up first.
    expect(dex.asked('api.mangadex.org', /^\/chapter\//)).toHaveLength(1);
  });

  it('doesn’t report pages from MangaDex’s own uploads server, and refuses what isn’t a picture', async () => {
    const { b, dex } = await setup();
    dex.state.home = 'https://uploads.mangadex.org';
    expect((await b.get(`/v1/manga/chapter/${ch(9)}/0`)).status).toBe(200);
    await new Promise((done) => setTimeout(done, 10));
    expect(dex.asked('api.mangadex.network', /^\/report$/)).toHaveLength(0);
    dex.state.notPicture = true;
    const r = await b.get(`/v1/manga/chapter/${ch(9)}/1`);
    expect(r.status).toBe(503);
    expect(r.body.code).toBe('manga_unreachable');
  });

  it('brings covers at the size asked, and only cover files', async () => {
    const { b, dex } = await setup();
    const r = await b.get(`/v1/manga/cover/${FRIEREN}/cover-1.jpg?size=256`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('image/jpeg');
    expect(dex.asked('uploads.mangadex.org', /./)[0].url.pathname).toBe(`/covers/${FRIEREN}/cover-1.jpg.256.jpg`);
    expect((await b.get(`/v1/manga/cover/${FRIEREN}/..%2F..%2Fetc`)).status).toBe(404);
  });

  it('waits out MangaDex when it says to slow down', async () => {
    const { b, dex } = await setup();
    dex.state.busy = true;
    const r = await b.get('/v1/manga/search?q=busy');
    expect(r.status).toBe(503);
    expect(r.body.code).toBe('manga_busy');
  });
});

describe('the pace of calls', () => {
  it('starts at most so many in a window, in order', async () => {
    const pace = new Pace(3, 100, 1000);
    const t0 = Date.now();
    const starts: number[] = [];
    await Promise.all(Array.from({ length: 7 }, async () => { await pace.take(); starts.push(Date.now() - t0); }));
    expect(starts.slice(0, 3).every((s) => s < 50)).toBe(true);
    expect(starts[3]).toBeGreaterThanOrEqual(95);
    expect(starts[6]).toBeGreaterThanOrEqual(195);
  });

  it('refuses a turn too far off', async () => {
    const pace = new Pace(1, 1000, 100);
    await pace.take();
    await expect(pace.take()).rejects.toThrow('busy');
  });

  it('runs so many at once', async () => {
    const gate = new Gate(2, 1000);
    let now = 0;
    let most = 0;
    await Promise.all(Array.from({ length: 6 }, () => gate.run(async () => {
      most = Math.max(most, ++now);
      await new Promise((done) => setTimeout(done, 10));
      now--;
    })));
    expect(most).toBe(2);
  });
});

describe('pages on disk', () => {
  it('lets go of those used longest ago once full', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'breader-disk-'));
    const disk = new Disk(dir, 100 * 1024);
    const page = (n: number) => { const b = new Uint8Array(24 * 1024); b.set(png(n)); return b; };
    for (const n of [1, 2, 3, 4]) await disk.put(`p${n}`, page(n));
    await new Promise((done) => setTimeout(done, 5));
    expect(await disk.get('p1')).not.toBeNull();
    await disk.put('p5', page(5));
    expect(await disk.get('p2')).toBeNull();
    expect(await disk.get('p3')).toBeNull();
    expect((await disk.get('p1'))?.type).toBe('image/png');
    expect(disk.size).toEqual({ files: 3, bytes: 3 * 24 * 1024 });
    // Too big a part of the whole to be worth keeping.
    await disk.put('big', new Uint8Array(30 * 1024));
    expect(disk.size.files).toBe(3);
    // Kept across a restart.
    const again = new Disk(dir, 100 * 1024);
    expect((await again.get('p5'))?.data[12]).toBe(5);
    expect(again.size.files).toBe(3);
  });

  it('forgets a file that isn’t a picture any more', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'breader-disk-'));
    const disk = new Disk(dir, 1024 * 1024);
    await disk.put('p', png(1));
    const [name] = await readdir(dir);
    await writeFile(join(dir, name), 'not a picture at all');
    const again = new Disk(dir, 1024 * 1024);
    expect(await again.get('p')).toBeNull();
    expect(await readdir(dir)).toEqual([]);
  });
});

describe('descriptions', () => {
  it('reads as plain text', () => {
    expect(plain('**Bold** and *soft*, [a link](https://x.y) and [b]BB[/b].\r\n\r\n\r\n# Heading\n___\nEnd &amp; more')).toBe(
      'Bold and soft, a link and BB.\n\nHeading\n\nEnd & more',
    );
  });
});
