import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import JSZip from 'jszip';
import { newLibraryKey, seriesName, type BookVolumeState } from '@breader/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeApp } from '../src/app.ts';
import { clean, escapeXml, isZip, makeEpub, watermark } from '../src/books/epub.ts';
import { authorName } from '../src/books/gutendex.ts';
import { AGENT } from '../src/books/http.ts';
import { bookFileType, bookOfUrl, makeBooks, type Books } from '../src/books/index.ts';
import { keepBooks } from '../src/books/keeper.ts';
import { novelId, novelOf } from '../src/books/novels.ts';
import { standardEbook } from '../src/books/openlibrary.ts';
import { makeRanobe } from '../src/books/ranobedb.ts';
import { chapterNumber, oldestFirst, plan, volumeOf } from '../src/books/volumes.ts';
import { novelsWanted, statusOf, wantedKind } from '../src/books/wanted.ts';
import { MemoryStore } from '../src/lib/cache.ts';
import { app as plainApp, browser, deps } from './helpers.ts';

/*
 * Books through the laptop: novel sites through a novel host of our own, and Gutendex, Open
 * Library, the Internet Archive and Standard Ebooks answering as they do, so what's asked of each,
 * what's shown, and what's made into EPUBs and kept can be checked.
 */

const HOUR = 3_600_000;
const NOVELS = 'http://novels.test';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const png = (n: number) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, n]);
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1]);
/** An EPUB as far as anything here looks: a zip. */
const epub = (n: number) => new Uint8Array([0x50, 0x4b, 0x03, 0x04, n, 0, 0, 0]);
/** A chapter's worth of words. */
const words = (n: number) => `<p>${'The rain kept falling on the old town. '.repeat(n)}</p>`;

interface FakeNovel {
  name: string;
  status: string;
  genres: string;
  cover: string | null;
  chapters: string[];
}

const PLUGINS = [
  { id: 'novelbin', name: 'NovelBin', site: 'https://novelbin.test/', lang: 'en', version: '1.0.0' },
  { id: 'royalroad', name: 'Royal Road', site: 'https://royalroad.test/', lang: 'en', version: '1.0.0' },
  { id: 'lnfr', name: 'Light Novel FR', site: 'https://lnfr.test/', lang: 'fr', version: '1.0.0' },
];
/** Each site's Popular and Latest lists, and what its search finds. */
const LISTS: Record<string, string[]> = { novelbin: ['/rain-mage', '/fan', '/broken'], royalroad: ['/fiction/7'] };
const SEARCHES: Record<string, string[]> = { novelbin: ['/rain-mage', '/fan', '/stub', '/unrelated'], royalroad: ['/fiction/7'] };

const PG: Record<number, { title: string } & Record<string, unknown>> = {
  1342: {
    id: 1342,
    title: 'Pride and Prejudice',
    authors: [{ name: 'Austen, Jane' }],
    summaries: ['A novel of manners.'],
    subjects: ['Love stories -- Fiction', 'England -- Social life and customs -- Fiction', 'Love stories -- Drama'],
    bookshelves: [],
    languages: ['en'],
    formats: { 'application/epub+zip': 'https://www.gutenberg.org/ebooks/1342.epub3.images', 'image/jpeg': 'https://www.gutenberg.org/cache/epub/1342/pg1342.cover.medium.jpg' },
  },
  5: { id: 5, title: 'Pride, Without an EPUB', authors: [], subjects: [], bookshelves: [], languages: ['en'], formats: { 'text/plain': 'https://www.gutenberg.org/ebooks/5.txt' } },
  9: { id: 9, title: 'A Broken Book', authors: [], subjects: [], bookshelves: [], languages: ['en'], formats: { 'application/epub+zip': 'https://www.gutenberg.org/ebooks/9.broken' } },
};

const OL_DOCS = [
  { key: '/works/OL1W', title: 'Pride and Prejudice', author_name: ['Jane Austen'], cover_i: 11, first_publish_year: 1813, id_standard_ebooks: ['jane-austen/pride-and-prejudice'], id_project_gutenberg: ['1342'], subject: ['Love stories', 'Fiction, general', 'England -- Fiction'] },
  // Its first two scans can't be downloaded: kept dark, and lent out.
  { key: '/works/OL2W', title: 'Pride of Lions', author_name: ['A. Writer'], ia: ['dark1', 'lent1', 'prideoflions00'], subject: ['Lions'] },
  // Gutenberg's place has it.
  { key: '/works/OL3W', title: 'Pride on Gutenberg Only', id_project_gutenberg: ['77'] },
  { key: '/works/OL4W', title: 'Pride Lent Out', ia: ['lent2'] },
  { key: '/authors/OL9A', title: 'Pride the Author' },
];
const OL_WORKS: Record<string, unknown> = { OL1W: { description: { value: 'Manners, and pride.' } }, OL2W: { description: 'Lions.' } };
const ARCHIVE: Record<string, unknown> = {
  dark1: { is_dark: true, files: [{ name: 'dark1.epub', format: 'EPUB' }] },
  lent1: { metadata: { 'access-restricted-item': 'true' }, files: [{ name: 'lent1.epub', format: 'EPUB' }] },
  prideoflions00: { metadata: {}, files: [{ name: 'prideoflions00.pdf', format: 'Text PDF' }, { name: 'prideoflions00.epub', format: 'EPUB' }] },
  lent2: { metadata: { 'access-restricted-item': true }, files: [{ name: 'lent2.epub', format: 'EPUB' }] },
};

/** The novel host and every books' place, answering as they do, and what each was asked. */
function fakeWeb() {
  const calls: Array<{ url: URL; ua: string | null }> = [];
  const state = {
    novels: {
      'novelbin:/rain-mage': { name: 'The Rain Mage', status: 'Ongoing', genres: 'Fantasy, Adventure', cover: 'https://novelbin.test/covers/rain.jpg', chapters: ['Prologue', 'Vol. 1 Chapter 1', 'Vol. 1 Chapter 2', 'Vol. 2 Chapter 1', 'Vol. 2 Chapter 2'] },
      'novelbin:/fan': { name: 'Rain Mage Fan Story', status: 'Completed', genres: 'Romance', cover: null, chapters: ['Chapter 1', 'Chapter 2'] },
      // Its site gives no chapter's text.
      'novelbin:/stub': { name: 'Rain Mage Stub', status: 'Ongoing', genres: 'Fantasy', cover: null, chapters: ['Chapter 1'] },
      // Its first chapter never comes.
      'novelbin:/broken': { name: 'Cracked Teacup', status: 'Ongoing', genres: 'Drama', cover: null, chapters: ['Chapter 1', 'Chapter 2'] },
      // The Rain Mage again, by its other name.
      'royalroad:/fiction/7': { name: 'Ame no Madoushi', status: 'Ongoing', genres: 'Fantasy', cover: null, chapters: ['Chapter 1'] },
    } as Record<string, FakeNovel>,
    /** Sites whose search fails. */
    down: new Set<string>(),
  };

  const itemsOf = (plugin: string, paths: string[]) =>
    paths.map((path) => {
      const n = state.novels[`${plugin}:${path}`];
      if (!n) return { name: 'Something Unrelated', path, cover: null };
      return { name: n.name, path, cover: n.cover };
    });

  const novel = (plugin: string, path: string) => {
    const n = state.novels[`${plugin}:${path}`];
    if (!n) return json({ error: 'gone' }, 404);
    const chapters = n.chapters.map((name, i) => ({ name, path: `${path}/${i + 1}`, number: null, page: null, at: null }));
    const link = `https://${plugin}.test${path}`;
    return json({ name: n.name, path, cover: n.cover, author: 'Someone', artist: '', status: n.status, genres: n.genres, summary: 'Rain, and a mage.', chapters, totalPages: 1, link });
  };

  const chapter = (plugin: string, path: string) => {
    if (path === '/broken/1') return json({ error: 'its site is down' }, 502);
    const cut = path.lastIndexOf('/');
    const n = state.novels[`${plugin}:${path.slice(0, cut)}`];
    const i = Number(path.slice(cut + 1));
    if (!n || !n.chapters[i - 1]) return json({ error: 'gone' }, 404);
    if (path.startsWith('/stub/')) return json({ html: '<p>Coming soon.</p>' });
    let html = `<h3>${n.chapters[i - 1]}</h3>${words(10)}`;
    if (i === 1) html += '<img src="/pics/map.png">';
    return json({ html });
  };

  const host = (url: URL) => {
    const plugin = url.searchParams.get('plugin') ?? '';
    const page = Number(url.searchParams.get('page') ?? '1');
    const path = url.searchParams.get('path') ?? '';
    if (url.pathname === '/plugins') return json(PLUGINS);
    if (url.pathname === '/popular') {
      if (page > 1) return json({ novels: [] });
      return json({ novels: itemsOf(plugin, LISTS[plugin] ?? []) });
    }
    if (url.pathname === '/search') {
      if (state.down.has(plugin)) return json({ error: 'its site is down' }, 502);
      if (page > 1) return json({ novels: [] });
      return json({ novels: itemsOf(plugin, SEARCHES[plugin] ?? []) });
    }
    if (url.pathname === '/novel') return novel(plugin, path);
    if (url.pathname === '/chapter') return chapter(plugin, path);
    if (url.pathname === '/image') return new Response(png(5));
    return json({ error: 'no such call' }, 404);
  };

  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ url, ua: new Headers(init.headers).get('user-agent') });
    if (url.origin === NOVELS) return host(url);
    if (url.host === 'ranobedb.org') {
      return json({ series: [{ id: 7, title: 'The Rain Mage', title_orig: '雨の魔導士', romaji: 'Ame no Madoushi', romaji_orig: null }], totalPages: 1 });
    }
    if (url.host === 'gutendex.com') {
      if (url.pathname === '/books/') {
        const q = (url.searchParams.get('search') ?? '').toLowerCase();
        const results = Object.values(PG).filter((b) => b.title.toLowerCase().includes(q));
        return json({ next: null, results });
      }
      const book = PG[Number(/^\/books\/(\d+)$/.exec(url.pathname)?.[1])];
      if (book) return json(book);
      return json({ detail: 'Not found.' }, 404);
    }
    if (url.host === 'www.gutenberg.org') {
      if (url.pathname.endsWith('.epub3.images')) return new Response(epub(1));
      if (url.pathname.endsWith('.jpg')) return new Response(jpeg);
      return new Response('<html>Sorry</html>');
    }
    if (url.host === 'openlibrary.org') {
      if (url.pathname === '/search.json') {
        const key = /^key:(\/works\/OL\d+W)$/.exec(url.searchParams.get('q') ?? '');
        if (key) return json({ docs: OL_DOCS.filter((d) => d.key === key[1]) });
        return json({ docs: OL_DOCS });
      }
      const work = /^\/works\/(OL\d+W)\.json$/.exec(url.pathname);
      if (work) return json(OL_WORKS[work[1]] ?? {});
    }
    if (url.host === 'archive.org') {
      const meta = /^\/metadata\/(.+)$/.exec(url.pathname);
      if (meta) return json(ARCHIVE[decodeURIComponent(meta[1])] ?? {});
      if (url.pathname === '/download/prideoflions00/prideoflions00.epub') return new Response(epub(3));
    }
    if (url.host === 'standardebooks.org') return new Response(epub(2));
    if (url.host === 'covers.openlibrary.org') return new Response(jpeg);
    throw new TypeError('fetch failed');
  }) as typeof globalThis.fetch;

  /** Calls to the novel host of this kind, as plugin:path. */
  const hostAsked = (call: string) =>
    calls.filter((c) => c.url.origin === NOVELS && c.url.pathname === call).map((c) => `${c.url.searchParams.get('plugin')}:${c.url.searchParams.get('path') ?? ''}`);
  return { fetch, calls, state, hostAsked };
}

let dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const d of dirs) await rm(d, { recursive: true, force: true });
  dirs = [];
});

async function setup() {
  const web = fakeWeb();
  const dir = await mkdtemp(join(tmpdir(), 'breader-books-'));
  dirs.push(dir);
  const books = makeBooks({ dir, cacheBytes: 64 * 1024 * 1024, novels: NOVELS, fetch: web.fetch, pace: [1000, 1000] });
  const app = makeApp({ ...deps, books });
  const b = browser(undefined, app);
  const r = await b.post('/v1/libraries', { libraryId: crypto.randomUUID(), key: newLibraryKey() });
  expect(r.status).toBe(201);
  return { web, books, app, b };
}

/** The volume once it's no longer being made. */
async function settled(books: Books, id: string, n: number): Promise<BookVolumeState> {
  for (let i = 0; i < 500; i++) {
    const s = await books.volume(id, n);
    if (s.state !== 'making') return s;
    await new Promise((done) => setTimeout(done, 10));
  }
  throw new Error('the volume was never made');
}

const titles = (r: { items: Array<{ card: { title: string } }> }) => r.items.map((x) => x.card.title);
const RAIN = novelId('novelbin', '/rain-mage');

describe('a novel’s volumes', () => {
  const named = (names: string[]) => names.map((name) => ({ name, number: chapterNumber(name, null) }));

  it('reads volumes and chapter numbers from chapters’ names', () => {
    expect(volumeOf('Vol. 3 Chapter 12')).toBe(3);
    expect(volumeOf('Volume 12 - The End')).toBe(12);
    expect(volumeOf('V2C5 A Fight')).toBe(2);
    expect(volumeOf('Chapter 5')).toBeNull();
    expect(chapterNumber('Chapter 12.5: Interlude', null)).toBe(12.5);
    expect(chapterNumber('101 - The Return', null)).toBe(101);
    expect(chapterNumber('Prologue', null)).toBeNull();
    expect(chapterNumber('Prologue', 7)).toBe(7);
  });

  it('goes by its site’s volumes when nearly every chapter names one, the last open while it’s coming out', () => {
    const chapters = named(['Prologue', 'Vol. 1 Chapter 1', 'Vol. 1 Chapter 2', 'Vol. 2 Chapter 1', 'Vol. 2 Chapter 2']);
    const vols = plan(chapters, 'ongoing');
    expect(vols.map((v) => [v.n, v.title, v.chapters, v.first, v.last, v.open])).toEqual([
      [1, 'Volume 1', 3, 'Prologue', 'Vol. 1 Chapter 2', false],
      [2, 'Volume 2', 2, 'Vol. 2 Chapter 1', 'Vol. 2 Chapter 2', true],
    ]);
    expect(plan(chapters, 'completed')[1].open).toBe(false);
  });

  it('reads a site’s volume too long for one book in parts of a hundred', () => {
    const chapters = named(Array.from({ length: 250 }, (_, i) => `Vol. 1 Chapter ${i + 1}`));
    expect(plan(chapters, 'ongoing').map((v) => [v.title, v.chapters, v.open])).toEqual([
      ['Volume 1, part 1', 100, false],
      ['Volume 1, part 2', 100, false],
      ['Volume 1, part 3', 50, true],
    ]);
  });

  it('makes volumes of a hundred chapters when its site names none, titled by their numbers', () => {
    const chapters = named(Array.from({ length: 150 }, (_, i) => `Chapter ${i + 11}`));
    expect(plan(chapters, null).map((v) => [v.title, v.chapters, v.open])).toEqual([
      ['Chapters 11-110', 100, false],
      ['Chapters 111-160', 50, true],
    ]);
    expect(plan(chapters, 'completed')[1].open).toBe(false);
    expect(plan([], 'ongoing')).toEqual([]);
  });

  it('turns round a site that lists its newest first', () => {
    const newest = named(['Chapter 3', 'Chapter 2', 'Chapter 1']);
    expect(oldestFirst(newest).map((c) => c.name)).toEqual(['Chapter 1', 'Chapter 2', 'Chapter 3']);
    const oldest = named(['Chapter 1', 'Side story', 'Chapter 2']);
    expect(oldestFirst(oldest)).toBe(oldest);
  });
});

describe('what a search wants', () => {
  it('reads a site’s status', () => {
    expect(statusOf('Ongoing')).toBe('ongoing');
    expect(statusOf('Completed')).toBe('completed');
    expect(statusOf('On Hiatus')).toBe('hiatus');
    expect(statusOf('Dropped')).toBe('cancelled');
    expect(statusOf('Unknown')).toBeNull();
  });

  it('asks the novel sites only for novels, and only about what they file novels under', () => {
    expect(novelsWanted({ lang: 'en', kinds: ['book'] })).toBe(false);
    expect(novelsWanted({ lang: 'en', kinds: ['light', 'book'], subject: 'selfhelp' })).toBe(false);
    expect(novelsWanted({ lang: 'en', kinds: ['web'], subject: 'fantasy' })).toBe(true);
    expect(wantedKind(null, { lang: 'en', kinds: ['light', 'web', 'book'] })).toBe(true);
    expect(wantedKind(null, { lang: 'en', kinds: ['light'] })).toBe(false);
  });
});

describe('books’ ids and files', () => {
  it('names a novel by its plugin and path, and a library’s book by its url', () => {
    const id = novelId('novelbin', '/novel/the-rain-mage?from=1');
    expect(id).toMatch(/^nv:novelbin:[\w-]+$/);
    expect(novelOf(id)).toEqual({ plugin: 'novelbin', path: '/novel/the-rain-mage?from=1' });
    expect(() => novelOf('nv:not a plugin:abc')).toThrow();
    expect(bookOfUrl(`cat:${id}#v3-100`)).toBe(id);
    expect(bookOfUrl('cat:pg:1342#v1-0')).toBe('pg:1342');
    expect(bookOfUrl('cat:pg:1342')).toBeNull();
    expect(bookOfUrl('mangadex:a1c7c817-4e59-43b7-9365-09675a149a6f')).toBeNull();
  });

  it('tells pictures, EPUBs and gzipped chapters apart on disk', () => {
    expect(bookFileType(png(1))).toBe('image/png');
    expect(bookFileType(epub(1))).toBe('application/epub+zip');
    expect(bookFileType(gzipSync('a chapter'))).toBe('application/gzip');
    expect(bookFileType(new Uint8Array([1, 2, 3]))).toBeNull();
  });

  it('writes Gutenberg’s authors as they’re written, and finds Standard Ebooks’ files', () => {
    expect(authorName('Doyle, Arthur Conan')).toBe('Arthur Conan Doyle');
    expect(authorName('Lewis, C. S. (Clive Staples)')).toBe('C. S. Lewis');
    expect(authorName('Homer')).toBe('Homer');
    expect(authorName('Aristotle, ')).toBe('Aristotle');
    expect(standardEbook('jane-austen/pride-and-prejudice')).toBe(
      'https://standardebooks.org/ebooks/jane-austen/pride-and-prejudice/downloads/jane-austen_pride-and-prejudice.epub?source=download',
    );
  });
});

describe('a volume as an EPUB', () => {
  it('cleans a chapter down to its paragraphs, emphasis and pictures', () => {
    const html = `<div class="chapter"><h3>Chapter 1: The Start</h3><script>ads()</script>
      <p>It was <b>cold</b> &amp; dark.<br>She <i>ran</i>.</p>
      <p>Read the latest chapters at novelbin.com</p>
      <img data-src="/pics/1.png" src="data:image/gif;base64,R0lG"><iframe src="https://ads.test"></iframe></div>`;
    const { body, pictures } = clean(html, 'https://novelbin.test/novel/c1', 'Chapter 1: The Start');
    expect(body).toBe('<p>It was <strong>cold</strong> &amp; dark.</p>\n<p>She <em>ran</em>.</p>\n<div class="pic"><img src="pic:0" alt=""/></div>');
    expect(pictures).toEqual(['https://novelbin.test/pics/1.png']);
  });

  it('tells a site’s watermark from the story', () => {
    expect(watermark('Read the latest chapters at n0velbin(.)c0m')).toBe(true);
    expect(watermark('He typed example.com into the bar.')).toBe(false);
    expect(escapeXml('a < b & "c"\u0001')).toBe('a &lt; b &amp; &quot;c&quot;');
  });

  it('makes the same chapters into the same bytes, each picture once', async () => {
    const asked: string[] = [];
    const picture = async (url: string) => {
      asked.push(url);
      if (url.endsWith('gone.png')) return null;
      return { data: png(1), type: 'image/png' };
    };
    const book = {
      id: `cat:${RAIN}#v1-2`,
      title: 'The Rain Mage: Volume 1',
      series: 'The Rain Mage',
      index: 1,
      authors: ['Someone'],
      lang: 'en',
      description: 'A <mage>.',
      publisher: 'NovelBin',
      link: 'https://novelbin.test/rain-mage',
      cover: { data: jpeg, type: 'image/jpeg' },
      chapters: [
        { title: 'Chapter 1', html: '<p>One.</p><img src="https://pics.test/a.png"><img src="https://pics.test/gone.png">', base: null },
        { title: 'Chapter 2', html: '<p>Two.</p><img src="https://pics.test/a.png">', base: null },
      ],
    };
    const one = await makeEpub(book, picture);
    expect(asked).toEqual(['https://pics.test/a.png', 'https://pics.test/gone.png']);
    const two = await makeEpub(book, picture);
    expect(Buffer.from(one).equals(Buffer.from(two))).toBe(true);
    expect(isZip(one)).toBe(true);

    const zip = await JSZip.loadAsync(one);
    expect(Object.keys(zip.files)[0]).toBe('mimetype');
    const opf = await zip.file('OEBPS/content.opf')!.async('string');
    expect(opf).toContain('<dc:title>The Rain Mage: Volume 1</dc:title>');
    expect(opf).toContain('<dc:description>A &lt;mage&gt;.</dc:description>');
    expect(opf).toContain('<meta name="calibre:series_index" content="1"/>');
    expect(opf).toContain('properties="cover-image"');
    const pics = Object.keys(zip.files).filter((f) => /^OEBPS\/images\/[0-9a-f]{16}\.png$/.test(f));
    expect(pics).toHaveLength(1);
    const shown = `<img src="${pics[0].slice('OEBPS/'.length)}" alt=""/>`;
    const c1 = await zip.file('OEBPS/c1.xhtml')!.async('string');
    expect(c1).toContain('<h2>Chapter 1</h2>');
    expect(c1).toContain('<p>One.</p>');
    expect(c1).toContain(shown);
    expect(c1).not.toContain('pic:');
    expect(await zip.file('OEBPS/c2.xhtml')!.async('string')).toContain(shown);
  });
});

describe('RanobeDB', () => {
  const series = [
    { id: 7, title: 'The Rain Mage', title_orig: '雨の魔導士', romaji: 'Ame no Madoushi', romaji_orig: null },
    { id: 8, title: 'Re', title_orig: null, romaji: 'Re', romaji_orig: null },
  ];

  it('reads its whole list once a week, keeps it, and knows a series by any of its names', async () => {
    const asked: string[] = [];
    const fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      asked.push(url.search);
      const page = Number(url.searchParams.get('page'));
      return json({ series: [series[page - 1]], totalPages: 2 });
    }) as typeof globalThis.fetch;
    const store = new MemoryStore(100);
    const r = makeRanobe({ store, fetch, gap: 0 });
    expect(r.ready()).toBe(false);
    await r.refresh();
    expect(asked).toEqual(['?limit=100&page=1', '?limit=100&page=2']);
    expect(r.ready()).toBe(true);
    expect(r.seriesOf([seriesName('Ame no Madoushi').key])).toBe(7);
    expect(r.seriesOf([seriesName('雨の魔導士').key])).toBe(7);
    // Too short a name to tell one novel from another.
    expect(r.seriesOf(['re'])).toBeNull();
    expect(r.namesOf(7)).toEqual(['The Rain Mage', 'Ame no Madoushi', '雨の魔導士']);
    await r.refresh();
    expect(asked).toHaveLength(2);

    // Started again: from what was kept.
    const again = makeRanobe({ store, fetch, gap: 0 });
    await again.refresh();
    expect(asked).toHaveLength(2);
    expect(again.seriesOf(['rainmage'])).toBe(7);
  });

  it('carries on without its list when it can’t be read', async () => {
    const down = (async () => new Response('down', { status: 503 })) as typeof globalThis.fetch;
    const r = makeRanobe({ store: new MemoryStore(10), fetch: down, gap: 0 });
    await r.refresh();
    expect(r.ready()).toBe(false);
  });
});

describe('books through the laptop', () => {
  it('says whether it’s on, and is off on a server without it', async () => {
    const { b } = await setup();
    expect((await b.get('/v1/catalogue')).body).toEqual({ on: true });
    const off = browser(undefined, plainApp);
    expect((await off.get('/v1/catalogue')).body).toEqual({ on: false });
    const r = await off.get('/v1/catalogue/search');
    expect(r.status).toBe(503);
    expect(r.body.code).toBe('books_off');
  });

  it('finds a book in Gutenberg and Open Library as one, with only copies that can be had', async () => {
    const { b, web } = await setup();
    const r = await b.get('/v1/catalogue/search?q=pride&kinds=book');
    expect(r.status).toBe(200);
    expect(r.body.items.map((x: { source: string; card: { title: string } }) => [x.source, x.card.title])).toEqual([
      ['Standard Ebooks', 'Pride and Prejudice'],
      ['Project Gutenberg', 'Pride and Prejudice'],
      ['Internet Archive', 'Pride of Lions'],
    ]);
    expect(r.body.items[1].card).toEqual({
      id: 'pg:1342',
      title: 'Pride and Prejudice',
      cover: '/v1/catalogue/item/pg:1342/cover',
      authors: ['Jane Austen'],
      status: null,
      kind: 'book',
      side: false,
      mtl: false,
      chapters: null,
      year: null,
    });
    expect(r.body.items[0].card).toMatchObject({ id: 'ol:OL1W', year: 1813, cover: '/v1/catalogue/item/ol:OL1W/cover' });
    const ol = web.calls.find((c) => c.url.pathname === '/search.json')!;
    expect(ol.url.searchParams.get('q')).toBe('pride ebook_access:public language:eng');
    const gutendex = web.calls.find((c) => c.url.host === 'gutendex.com')!;
    expect(Object.fromEntries(gutendex.url.searchParams)).toMatchObject({ languages: 'en', mime_type: 'application/epub+zip', search: 'pride' });

    // Each sheet from what the search brought, and the Archive's verdicts kept.
    const pg = await b.get('/v1/catalogue/item/pg:1342');
    expect(pg.headers.get('cache-control')).toBe('private, max-age=600');
    expect(pg.body).toMatchObject({
      source: 'Project Gutenberg',
      description: 'A novel of manners.',
      genres: ['Love stories', 'England'],
      link: 'https://www.gutenberg.org/ebooks/1342',
      volumes: [{ n: 1, title: 'Pride and Prejudice', chapters: 0, first: null, last: null, open: false }],
    });
    const lions = await b.get('/v1/catalogue/item/ol:OL2W');
    expect(lions.body).toMatchObject({ source: 'Internet Archive', description: 'Lions.', link: 'https://openlibrary.org/works/OL2W' });
    expect((await b.get('/v1/catalogue/item/ol:OL1W')).body.description).toBe('Manners, and pride.');
    expect(web.calls.filter((c) => c.url.pathname === '/metadata/prideoflions00')).toHaveLength(1);
    expect(web.calls.filter((c) => c.url.pathname === '/search.json')).toHaveLength(1);

    // Everyone outside is told who's asking.
    const outside = web.calls.filter((c) => c.url.origin !== NOVELS);
    expect(outside.length).toBeGreaterThan(0);
    for (const c of outside) expect(c.ua).toBe(AGENT);
  });

  it('streams what each place finds, then the whole lot', async () => {
    const { b } = await setup();
    const r = await b.get('/v1/catalogue/search?q=pride&kinds=book&stream=1');
    expect(r.headers.get('content-type')).toContain('text/event-stream');
    const events = String(r.body)
      .split('\n')
      .filter((l) => l.startsWith('data: '))
      .map((l) => JSON.parse(l.slice('data: '.length)));
    const last = events[events.length - 1];
    expect(last.kind).toBe('lot');
    expect(last.items).toHaveLength(3);
    for (const e of events.slice(0, -1)) expect(e.kind).toBe('some');
  });

  it('asks Open Library only in a language it has', async () => {
    const { books, web } = await setup();
    const r = await books.search({ q: 'pride', kinds: ['book'], lang: 'tlh' });
    expect(titles(r)).toEqual(['Pride and Prejudice']);
    expect(web.calls.filter((c) => c.url.host === 'openlibrary.org')).toHaveLength(0);
  });

  it('sends covers until they change, and says when a book’s gone', async () => {
    const { b } = await setup();
    const c = await b.get('/v1/catalogue/item/pg:1342/cover?size=256');
    expect(c.status).toBe(200);
    expect(c.headers.get('content-type')).toBe('image/jpeg');
    const tag = c.headers.get('etag')!;
    expect((await b.get('/v1/catalogue/item/pg:1342/cover?size=256', { 'if-none-match': tag })).status).toBe(304);
    const gone = await b.get('/v1/catalogue/item/pg:404');
    expect(gone.status).toBe(404);
    expect(gone.body.code).toBe('book_not_found');
    expect((await b.get('/v1/catalogue/item/zz:1')).status).toBe(400);
  });

  it('makes a whole book ready to read, for browsers signed in to a library', async () => {
    const { app, b } = await setup();
    expect((await b.get('/v1/catalogue/item/pg:1342/volume/1/file')).status).toBe(409);
    expect((await b.get('/v1/catalogue/item/pg:1342/volume/1')).body).toEqual({ state: 'making', done: 0, total: 1 });
    let state = (await b.get('/v1/catalogue/item/pg:1342/volume/1')).body;
    for (let i = 0; i < 500 && state.state === 'making'; i++) {
      await new Promise((done) => setTimeout(done, 10));
      state = (await b.get('/v1/catalogue/item/pg:1342/volume/1')).body;
    }
    expect(state).toEqual({ state: 'ready', bytes: 8 });
    const file = await b.get('/v1/catalogue/item/pg:1342/volume/1/file');
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toBe('application/epub+zip');
    expect(file.headers.get('x-chapters')).toBe('0');
    const stranger = browser(undefined, app);
    expect((await stranger.get('/v1/catalogue/search?q=pride&kinds=book')).status).toBe(200);
    expect((await stranger.get('/v1/catalogue/item/pg:1342')).status).toBe(200);
    expect((await stranger.get('/v1/catalogue/item/pg:1342/volume/1')).body.state).toBe('ready');
    expect((await stranger.get('/v1/catalogue/item/pg:1342/volume/1/file')).status).toBe(401);
    expect((await b.get('/v1/catalogue/item/pg:1342/volume/2')).status).toBe(404);
  });

  it('says once that a book’s file isn’t a book, then tries again', async () => {
    const { books } = await setup();
    expect(await settled(books, 'pg:9', 1)).toEqual({ state: 'failed', message: 'That site isn’t answering just now. Try again later.' });
    expect((await books.volume('pg:9', 1)).state).toBe('making');
  });
});

describe('novels through the laptop', () => {
  it('finds novels on every site of the language, light or web, checking only those named so', async () => {
    const { books, web } = await setup();
    await books.warm();
    const r = await books.search({ q: 'rain mage', kinds: ['light', 'web'] });
    expect(r.items.map((x) => [x.source, x.card.title, x.card.kind])).toEqual([
      ['NovelBin', 'The Rain Mage', 'light'],
      ['NovelBin', 'Rain Mage Fan Story', 'web'],
    ]);
    expect(r.items[0].card).toEqual({
      id: RAIN,
      title: 'The Rain Mage',
      cover: `/v1/catalogue/item/${RAIN}/cover`,
      authors: ['Someone'],
      status: 'ongoing',
      kind: 'light',
      side: false,
      mtl: false,
      chapters: 5,
      year: null,
    });
    // RanobeDB's names come with it, to find it by on other sites.
    expect(r.items[0].keys).toEqual(['rainmage', 'amenomadoshi', '雨の魔導士']);
    expect(web.hostAsked('/search')).toEqual(['novelbin:', 'royalroad:']);
    const novels = web.hostAsked('/novel');
    expect(novels).toContain('novelbin:/stub');
    expect(novels).not.toContain('novelbin:/unrelated');
    expect(web.calls.some((c) => c.url.searchParams.get('plugin') === 'lnfr')).toBe(false);
  });

  it('finds a novel’s copies by any of its names, as its sheet asks', async () => {
    const { books } = await setup();
    await books.warm();
    const r = await books.search({ q: 'The Rain Mage', names: ['rainmage', 'amenomadoshi'], kinds: ['light', 'web'] });
    expect(r.items.map((x) => [x.source, x.card.title])).toEqual([
      ['NovelBin', 'The Rain Mage'],
      ['Royal Road', 'Ame no Madoushi'],
    ]);
  });

  it('browses the sites’ lists shelved ahead, asking no site', async () => {
    const { books, web } = await setup();
    await books.warm();
    const before = web.calls.length;
    const r = await books.search({ kinds: ['light', 'web'] });
    expect(titles(r)).toEqual(['The Rain Mage', 'Ame no Madoushi', 'Rain Mage Fan Story', 'Cracked Teacup']);
    expect(r.next).toBeNull();
    expect(web.calls.length).toBe(before);
  });

  it('leaves out a site whose search fails, for a while', async () => {
    const { books, web } = await setup();
    await books.warm();
    web.state.down.add('royalroad');
    expect(titles(await books.search({ q: 'rain mage', kinds: ['light', 'web'] }))).toEqual(['The Rain Mage', 'Rain Mage Fan Story']);
    await books.search({ q: 'mage', kinds: ['light', 'web'] });
    expect(web.hostAsked('/search').filter((s) => s.startsWith('royalroad'))).toHaveLength(1);
  });

  it('shows a novel by its volumes, and makes each an EPUB of its chapters', async () => {
    const { b, books } = await setup();
    const item = await b.get(`/v1/catalogue/item/${RAIN}`);
    expect(item.body).toMatchObject({
      source: 'NovelBin',
      description: 'Rain, and a mage.',
      genres: ['Fantasy', 'Adventure'],
      link: 'https://novelbin.test/rain-mage',
      ranobe: null,
      volumes: [
        { n: 1, title: 'Volume 1', chapters: 3, first: 'Prologue', last: 'Vol. 1 Chapter 2', open: false },
        { n: 2, title: 'Volume 2', chapters: 2, first: 'Vol. 2 Chapter 1', last: 'Vol. 2 Chapter 2', open: true },
      ],
    });
    expect((await b.get(`/v1/catalogue/item/${RAIN}/volume/1`)).body).toEqual({ state: 'making', done: 0, total: 3 });
    expect(await settled(books, RAIN, 1)).toMatchObject({ state: 'ready' });
    const file = await b.get(`/v1/catalogue/item/${RAIN}/volume/1/file`);
    expect(file.status).toBe(200);
    expect(file.headers.get('x-chapters')).toBe('3');

    const made = await books.volumeFile(RAIN, 1);
    expect(made.chapters).toBe(3);
    const zip = await JSZip.loadAsync(made.data);
    const opf = await zip.file('OEBPS/content.opf')!.async('string');
    expect(opf).toContain(`<dc:identifier id="uid">cat:${RAIN}#v1-3</dc:identifier>`);
    expect(opf).toContain('<dc:title>The Rain Mage: Volume 1</dc:title>');
    expect(opf).toContain('<dc:publisher>NovelBin</dc:publisher>');
    expect(opf).toContain('properties="cover-image"');
    const c1 = await zip.file('OEBPS/c1.xhtml')!.async('string');
    expect(c1).toContain('<h2>Prologue</h2>');
    expect(c1).toContain('The rain kept falling');
    // The map, from the chapter's own page on its site.
    expect(c1).toMatch(/<img src="images\/[0-9a-f]{16}\.png"/);
  });

  it('says once why a volume couldn’t be made, then tries again', async () => {
    const { books } = await setup();
    const broken = novelId('novelbin', '/broken');
    expect(await books.volume(broken, 1)).toEqual({ state: 'making', done: 0, total: 2 });
    expect(await settled(books, broken, 1)).toEqual({ state: 'failed', message: 'That site isn’t answering just now. Try again later.' });
    expect((await books.volume(broken, 1)).state).toBe('making');
    await expect(books.keepBook(broken)).rejects.toThrow('That site isn’t answering just now.');
  });
});

describe('books kept for good', () => {
  it('makes every volume of a book in a library ahead, once, and the new chapters as they come', async () => {
    const { books, web } = await setup();
    expect(await books.keepBook(RAIN)).toEqual({ volumes: 2, made: 2 });
    expect(await books.volume(RAIN, 2)).toMatchObject({ state: 'ready' });
    // Its volumes, its chapters, the map in its first and its cover at both widths.
    expect(books.kept().kept.files).toBe(10);
    const asked = web.hostAsked('/chapter').length;
    expect(await books.keepBook(RAIN)).toEqual({ volumes: 2, made: 0 });
    expect(web.hostAsked('/chapter')).toHaveLength(asked);

    // A new chapter comes out, and the hour's run finds it.
    web.state.novels['novelbin:/rain-mage'].chapters.push('Vol. 2 Chapter 3');
    const now = Date.now;
    vi.spyOn(Date, 'now').mockImplementation(() => now() + 2 * HOUR);
    expect(await books.keepBook(RAIN)).toEqual({ volumes: 2, made: 1 });
    expect(web.hostAsked('/chapter').slice(asked)).toEqual(['novelbin:/rain-mage/6']);
    expect((await books.volumeFile(RAIN, 2)).chapters).toBe(3);
    expect(books.kept().kept.files).toBe(11);

    // Out of every library: back with the rest, to be trimmed in turn.
    expect(await books.keepOnly([])).toBe(11);
    expect(books.kept().kept.files).toBe(0);
  });

  it('keeps a whole book', async () => {
    const { books } = await setup();
    expect(await books.keepBook('ol:OL2W')).toEqual({ volumes: 1, made: 1 });
    const file = await books.volumeFile('ol:OL2W', 1);
    expect([...file.data]).toEqual([...epub(3)]);
  });
});

describe('the books keeper', () => {
  function fakeBooks() {
    const asked: string[] = [];
    const books = {
      keepOnly: async (ids: string[]) => {
        asked.push(`only ${ids.join(' ')}`);
        return 4;
      },
      keepBook: async (id: string) => {
        if (id === 'pg:9') throw new Error('not a book');
        asked.push(`keep ${id}`);
        if (id.startsWith('nv:')) return { volumes: 3, made: 1 };
        return { volumes: 1, made: 0 };
      },
      kept: () => ({ files: 20, bytes: 0, kept: { files: 12, bytes: 5 * 1024 * 1024 } }),
    } as unknown as Books;
    return { books, asked };
  }

  it('keeps every book from the catalogue in any library, once each, and only those', async () => {
    const { books, asked } = fakeBooks();
    const urls = [`cat:${RAIN}#v1-3`, `cat:${RAIN}#v2-2`, 'cat:pg:1342#v1-0', 'cat:pg:9#v1-0', 'samples/alice.epub', 'mangadex:a1c7c817-4e59-43b7-9365-09675a149a6f'];
    const seen: number[] = [];
    const r = await keepBooks(books, urls, undefined, (s) => seen.push(s.books));
    expect(asked).toEqual([`only ${RAIN} pg:1342 pg:9`, `keep ${RAIN}`, 'keep pg:1342']);
    expect(r).toEqual({ books: 3, volumes: 4, made: 1, failed: 1, letGo: 4, keptFiles: 12, keptMb: 5 });
    expect(seen).toEqual([1, 2, 3]);
  });

  it('stops between books when told to', async () => {
    const { books, asked } = fakeBooks();
    const stop = new AbortController();
    stop.abort();
    const r = await keepBooks(books, ['cat:pg:1342#v1-0'], stop.signal);
    expect(asked).toEqual(['only pg:1342']);
    expect(r.books).toBe(0);
  });
});
