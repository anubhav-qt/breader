import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeHost } from '../src/novels/app.ts';
import { makeFetcher, unwrapJson } from '../src/novels/fetch.ts';
import { DEFAULT_COVER, Plugins, langOf, loadPlugin } from '../src/novels/plugins.ts';

/*
 * The novel host: LNReader's plugins loaded and kept, their fetching past Cloudflare, and the API
 * the books ask, against a plugin of our own written as LNReader's are.
 */

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

/** A plugin as LNReader builds them: CommonJS, its site read through @libs/fetch and cheerio. */
function pluginCode(id: string, version = '1.0.0') {
  return `
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const fetch_1 = require("@libs/fetch");
const cheerio_1 = require("cheerio");
const novelStatus_1 = require("@libs/novelStatus");
class FakePlugin {
  constructor() {
    this.id = "${id}";
    this.name = "Fake";
    this.site = "https://fake.test/";
    this.version = "${version}";
  }
  async popularNovels(page, { showLatestNovels }) {
    const html = await fetch_1.fetchText(this.site + (showLatestNovels ? "latest" : "popular") + "?page=" + page);
    const $ = cheerio_1.load(html);
    return $("a.novel").map((i, el) => ({ name: $(el).text(), path: $(el).attr("href"), cover: $(el).attr("data-cover") })).get();
  }
  async searchNovels(q, page) {
    const res = await fetch_1.fetchApi(this.site + "search?q=" + encodeURIComponent(q) + "&page=" + page);
    const body = await res.json();
    return body.found;
  }
  async parseNovel(path) {
    return {
      path,
      name: "The Novel",
      author: " Someone ",
      status: novelStatus_1.NovelStatus.Ongoing,
      chapters: [
        { name: "Chapter 1", path: path + "/1", chapterNumber: 1 },
        { name: "Chapter 2", path: path + "/2", releaseTime: "2026-10-01" },
      ],
      totalPages: 3,
    };
  }
  async parsePage(path, page) {
    return { chapters: [{ name: "Chapter " + page + "0", path: path + "/" + page + "0", page }] };
  }
  async parseChapter(path) {
    return await fetch_1.fetchText(this.site + path);
  }
}
exports.default = new FakePlugin();
`;
}

/** A site and LNReader's list, answering as they would. */
function fakeWeb(pages: Record<string, () => Response>) {
  const asked: string[] = [];
  const fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    asked.push(url);
    const page = pages[url];
    if (!page) throw new TypeError('fetch failed');
    return page();
  }) as typeof globalThis.fetch;
  return { fetch, asked };
}

const LIST = 'https://plugins.test/plugins.min.json';

function listOf(entries: Array<{ id: string; version: string; lang?: string }>) {
  return entries.map((e) => ({
    id: e.id,
    name: e.id.toUpperCase(),
    site: 'https://fake.test/',
    lang: e.lang ?? 'English',
    version: e.version,
    url: `https://plugins.test/${e.id}-${e.version}.js`,
  }));
}

let dirs: string[] = [];
async function dir() {
  const d = await mkdtemp(join(tmpdir(), 'novels-'));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
  dirs = [];
});

describe('LNReader’s plugins', () => {
  it('names each language by its code', () => {
    expect(langOf('English')).toBe('en');
    expect(langOf('‎العربية‎')).toBe('ar');
    expect(langOf('Klingon')).toBe('other');
  });

  it('loads a plugin, and refuses one that asks for what isn’t here', () => {
    const fetcher = makeFetcher();
    expect(loadPlugin(pluginCode('fake'), 'fake', fetcher).id).toBe('fake');
    expect(() => loadPlugin('require("fs");', 'bad', fetcher)).toThrow('The plugin asks for fs');
    expect(() => loadPlugin('module.exports = {};', 'empty', fetcher)).toThrow('Not a plugin');
  });

  it('fetches the listed plugins once, keeps them, and starts from what it kept', async () => {
    const d = await dir();
    const web = fakeWeb({
      [LIST]: () => json(listOf([{ id: 'one', version: '1.0.0' }, { id: 'two', version: '1.0.0', lang: 'Français' }, { id: 'bad id!', version: '1.0.0' }])),
      'https://plugins.test/one-1.0.0.js': () => new Response(pluginCode('one')),
      'https://plugins.test/two-1.0.0.js': () => new Response(pluginCode('two')),
    });
    const plugins = new Plugins({ dir: d, fetcher: makeFetcher(), listUrl: LIST, fetch: web.fetch });
    await plugins.start();
    expect(plugins.all().map((l) => l.meta.id).sort()).toEqual(['one', 'two']);
    expect(plugins.get('two')?.meta.lang).toBe('fr');
    expect(await readFile(join(d, 'code', 'one.js'), 'utf8')).toContain('FakePlugin');

    const offline = fakeWeb({});
    const again = new Plugins({ dir: d, fetcher: makeFetcher(), listUrl: LIST, fetch: offline.fetch });
    await again.start();
    expect(again.all()).toHaveLength(2);
    expect(offline.asked).toEqual([]);
  });

  it('brings a new version in, lets a dropped one go, and keeps the old one when the new fails', async () => {
    const d = await dir();
    let list = listOf([{ id: 'one', version: '1.0.0' }, { id: 'two', version: '1.0.0' }]);
    const web = fakeWeb({
      [LIST]: () => json(list),
      'https://plugins.test/one-1.0.0.js': () => new Response(pluginCode('one')),
      'https://plugins.test/two-1.0.0.js': () => new Response(pluginCode('two')),
      'https://plugins.test/one-1.1.0.js': () => new Response(pluginCode('one', '1.1.0')),
      'https://plugins.test/three-1.0.0.js': () => new Response('require("fs");'),
    });
    const plugins = new Plugins({ dir: d, fetcher: makeFetcher(), listUrl: LIST, fetch: web.fetch });
    await plugins.start();
    expect(await plugins.update()).toBeNull();

    list = listOf([{ id: 'one', version: '1.1.0' }, { id: 'three', version: '1.0.0' }]);
    expect(await plugins.update()).toEqual({ updated: ['ONE 1.1.0'], failed: ['THREE'] });
    expect(plugins.get('one')?.plugin.version).toBe('1.1.0');
    expect(plugins.get('two')).toBeUndefined();
    expect(plugins.get('three')).toBeUndefined();
  });
});

describe('the plugins’ fetching', () => {
  const challenge = () =>
    new Response('<html><title>Just a moment...</title></html>', { status: 403, headers: { server: 'cloudflare', 'content-type': 'text/html' } });
  const solved = (response: string) =>
    json({
      status: 'ok',
      solution: { status: 200, response, userAgent: 'Real Browser', cookies: [{ name: 'cf_clearance', value: 'yes' }] },
    });

  it('passes Cloudflare with the browser’s cookies, and keeps them for the calls after', async () => {
    const seen: Array<{ url: string; cookie: string | null; agent: string | null }> = [];
    const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input);
      if (url === 'http://solver.test/v1') return solved('<html>solved</html>');
      const headers = new Headers(init.headers);
      seen.push({ url, cookie: headers.get('cookie'), agent: headers.get('user-agent') });
      if (headers.get('cookie') !== 'cf_clearance=yes') return challenge();
      return new Response('the page');
    }) as typeof globalThis.fetch;
    const fetcher = makeFetcher({ solver: 'http://solver.test/v1', fetch });
    expect(await fetcher.fetchText('https://www.site.test/a')).toBe('the page');
    expect(await fetcher.fetchText('https://site.test/b')).toBe('the page');
    expect(seen.map((s) => s.url)).toEqual(['https://www.site.test/a', 'https://www.site.test/a', 'https://site.test/b']);
    expect(seen[2].agent).toBe('Real Browser');
  });

  it('reads a site through the browser when its cookies alone don’t pass, JSON unwrapped', async () => {
    let direct = 0;
    let solves = 0;
    const fetch = (async (input: string | URL | Request) => {
      if (String(input) === 'http://solver.test/v1') {
        solves += 1;
        return solved('<html><head></head><body><pre>{"found":[{"name":"A &amp; B","path":"a"}]}</pre></body></html>');
      }
      direct += 1;
      return challenge();
    }) as typeof globalThis.fetch;
    const fetcher = makeFetcher({ solver: 'http://solver.test/v1', fetch });
    const first = await fetcher.fetchApi('https://site.test/search');
    expect(await first.json()).toEqual({ found: [{ name: 'A & B', path: 'a' }] });
    await fetcher.fetchApi('https://site.test/search');
    expect(direct).toBe(2);
    expect(solves).toBe(2);
  });

  it('unwraps only what is JSON', () => {
    expect(unwrapJson('<html><head></head><body><pre>[1,2]</pre></body></html>')).toBe('[1,2]');
    expect(unwrapJson('<html><head></head><body><pre>not json</pre></body></html>')).toBeNull();
    expect(unwrapJson('<html><body>page</body></html>')).toBeNull();
  });
});

describe('the novel host', () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

  function hostFor(pages: Record<string, () => Response>) {
    const web = fakeWeb(pages);
    const fetcher = makeFetcher({ fetch: web.fetch });
    const loaded = { meta: { id: 'fake', name: 'Fake', site: 'https://fake.test/', lang: 'en', version: '1.0.0', url: '' }, plugin: loadPlugin(pluginCode('fake'), 'fake', fetcher) };
    let updates = 0;
    const app = makeHost({
      plugins: {
        get: (id) => (id === 'fake' ? loaded : undefined),
        all: () => [loaded],
        update: async () => {
          updates += 1;
          return null;
        },
      },
      send: fetcher.send,
      wait: 2_000,
    });
    return { app, web, updates: () => updates };
  }

  it('lists a site’s novels, the cover it has none for left out', async () => {
    const { app } = hostFor({
      'https://fake.test/popular?page=2': () =>
        new Response(`<a class="novel" href="/n/one" data-cover="https://fake.test/c.jpg"> One </a><a class="novel" href="/n/two" data-cover="${DEFAULT_COVER}">Two</a><a class="novel" href="">Nameless path</a>`),
    });
    const res = await app.request('/popular?plugin=fake&page=2');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      novels: [
        { name: 'One', path: '/n/one', cover: 'https://fake.test/c.jpg' },
        { name: 'Two', path: '/n/two', cover: null },
      ],
    });
  });

  it('answers 502 for a site that couldn’t be reached, never an empty list', async () => {
    const { app } = hostFor({ 'https://fake.test/latest?page=1': () => new Response('gone', { status: 500 }) });
    const res = await app.request('/popular?plugin=fake&latest=1');
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'HTTP 500' });

    const empty = hostFor({ 'https://fake.test/popular?page=1': () => new Response('<p>nothing yet</p>') });
    expect(await (await empty.app.request('/popular?plugin=fake')).json()).toEqual({ novels: [] });
  });

  it('searches, and refuses what it can’t ask', async () => {
    const { app } = hostFor({ 'https://fake.test/search?q=the%20sword&page=1': () => json({ found: [{ name: 'The Sword', path: 's' }] }) });
    expect(await (await app.request('/search?plugin=fake&q=the%20sword')).json()).toEqual({ novels: [{ name: 'The Sword', path: 's', cover: null }] });
    expect((await app.request('/search?plugin=fake')).status).toBe(400);
    expect((await app.request('/search?plugin=nope&q=x')).status).toBe(404);
    expect((await app.request('/search?plugin=fake&q=x&page=0')).status).toBe(400);
  });

  it('gives a novel with its chapters, and the pages of chapters after', async () => {
    const { app } = hostFor({});
    const novel = (await (await app.request('/novel?plugin=fake&path=n%2Fone')).json()) as { chapters: unknown[] };
    expect(novel).toMatchObject({ name: 'The Novel', path: 'n/one', author: 'Someone', status: 'Ongoing', totalPages: 3, link: 'https://fake.test/n/one' });
    expect(novel.chapters).toEqual([
      { name: 'Chapter 1', path: 'n/one/1', number: 1, page: null, at: null },
      { name: 'Chapter 2', path: 'n/one/2', number: null, page: null, at: '2026-10-01' },
    ]);
    const page = await (await app.request('/chapters?plugin=fake&path=n%2Fone&page=2')).json();
    expect(page).toEqual({ chapters: [{ name: 'Chapter 20', path: 'n/one/20', number: null, page: '2', at: null }] });
  });

  it('gives a chapter’s HTML, and 502 when the site failed it', async () => {
    const { app } = hostFor({ 'https://fake.test/n/one/1': () => new Response('<p>It began.</p>') });
    expect(await (await app.request('/chapter?plugin=fake&path=n%2Fone%2F1')).json()).toEqual({ html: '<p>It began.</p>' });
    expect((await app.request('/chapter?plugin=fake&path=n%2Fone%2F9')).status).toBe(502);
  });

  it('passes on pictures, and only pictures', async () => {
    const { app } = hostFor({
      'https://fake.test/c.png': () => new Response(PNG),
      'https://fake.test/page.html': () => new Response('<html></html>'),
    });
    const res = await app.request('/image?plugin=fake&url=https%3A%2F%2Ffake.test%2Fc.png');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect((await app.request('/image?plugin=fake&url=https%3A%2F%2Ffake.test%2Fpage.html')).status).toBe(502);
    expect((await app.request('/image?plugin=fake&url=file%3A%2F%2F%2Fetc%2Fpasswd')).status).toBe(400);
  });

  it('lists its plugins and updates them when asked', async () => {
    const host = hostFor({});
    expect(await (await host.app.request('/plugins')).json()).toEqual([expect.objectContaining({ id: 'fake', lang: 'en' })]);
    expect((await host.app.request('/update', { method: 'POST' })).status).toBe(200);
    expect(host.updates()).toBe(1);
  });
});
