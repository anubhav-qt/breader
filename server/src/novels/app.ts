import { Hono, type Context } from 'hono';
import { log } from '../log.ts';
import { pictureType } from '../manga/disk.ts';
import { failures, type Failures, type FetchInit } from './fetch.ts';
import { DEFAULT_COVER, type ChapterItem, type Loaded, type NovelItem, type SourceNovel, type Updated } from './plugins.ts';

/*
 * The novel host's API (host.ts runs it): LNReader's plugins (plugins.ts), which the API's books
 * ask (books/novels.ts) as its manga ask Suwayomi. It keeps nothing it answers: the API keeps what
 * it needs.
 *
 *   GET  /plugins                      every plugin, its language and its version
 *   GET  /popular?plugin&page&latest   a page of its site's popular novels, or its latest
 *   GET  /search?plugin&q&page         a page of what its site found
 *   GET  /novel?plugin&path            a novel and its chapters, or the first page of them
 *   GET  /chapters?plugin&path&page    a page of its chapters, for a site that lists them so
 *   GET  /chapter?plugin&path          a chapter, as its site's HTML
 *   GET  /image?plugin&url             a picture from its site: a cover, or one in a chapter
 *   POST /update                       the plugins brought up to date (the worker, once a day)
 *
 * A site that couldn't be reached answers 502, and one too slow 504, never an empty list.
 */

/** How long one plugin call may take, however many pages of its site it asks for. */
const CALL_WAIT = 90_000;
/** The biggest picture sent. */
const MOST_BYTES = 15 * 1024 * 1024;

class HostError extends Error {
  readonly status: 400 | 404 | 502 | 504;
  constructor(status: 400 | 404 | 502 | 504, message: string) {
    super(message);
    this.status = status;
  }
}

function within<T>(going: Promise<T>, ms: number): Promise<T> {
  return new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new HostError(504, 'The site took too long')), ms);
    going.then(
      (v) => {
        clearTimeout(timer);
        done(v);
      },
      (e) => {
        clearTimeout(timer);
        fail(e);
      },
    );
  });
}

/** A plugin's call, and how many of the site's calls inside it failed. */
async function counted<T>(fn: () => Promise<T>, ms: number): Promise<{ value: T; failures: Failures }> {
  const tally: Failures = { failed: 0, reason: null };
  const value = await failures.run(tally, () => within(fn(), ms));
  return { value, failures: tally };
}

function siteFailed(f: Failures): HostError {
  return new HostError(502, f.reason ?? 'The site failed');
}

function coverOf(cover: string | undefined): string | null {
  if (!cover || cover === DEFAULT_COVER) return null;
  if (!/^https?:\/\//.test(cover)) return null;
  return cover;
}

function itemOf(n: NovelItem) {
  return { name: String(n.name ?? '').trim(), path: String(n.path ?? ''), cover: coverOf(n.cover) };
}

function chapterOf(c: ChapterItem) {
  let number: number | null = null;
  if (typeof c.chapterNumber === 'number' && Number.isFinite(c.chapterNumber)) number = c.chapterNumber;
  let page: string | null = null;
  if (c.page !== undefined && c.page !== null) page = String(c.page);
  let at: string | null = null;
  if (c.releaseTime) at = String(c.releaseTime);
  return { name: String(c.name ?? '').trim(), path: String(c.path ?? ''), number, page, at };
}

/** Its page on its site. */
function linkOf(l: Loaded, path: string): string | null {
  try {
    if (l.plugin.resolveUrl) return l.plugin.resolveUrl(path, true);
    return new URL(path, l.plugin.site).href;
  } catch {
    return null;
  }
}

function novelOf(l: Loaded, n: SourceNovel) {
  let totalPages = 0;
  if (typeof n.totalPages === 'number' && n.totalPages > 0) totalPages = n.totalPages;
  return {
    ...itemOf(n),
    author: String(n.author ?? '').trim(),
    artist: String(n.artist ?? '').trim(),
    status: String(n.status ?? '').trim(),
    genres: String(n.genres ?? '').trim(),
    summary: String(n.summary ?? '').trim(),
    chapters: (n.chapters ?? []).map(chapterOf),
    totalPages,
    link: linkOf(l, n.path),
  };
}

/** Its filters as they first are, which its popular list needs. */
function filtersOf(l: Loaded) {
  const f = l.plugin.filters;
  if (!f) return undefined;
  const out: Record<string, { value: unknown; type: string }> = {};
  for (const [k, v] of Object.entries(f)) out[k] = { value: v.value, type: v.type };
  return out;
}

/** An empty list when a call failed is that failure, not a site with nothing. */
function listed(items: NovelItem[] | undefined, f: Failures) {
  const all = items ?? [];
  if (all.length === 0 && f.failed > 0) throw siteFailed(f);
  return { novels: all.map(itemOf).filter((n) => n.name && n.path) };
}

function pageOf(c: Context): number {
  const n = Number(c.req.query('page') ?? '1');
  if (!Number.isInteger(n) || n < 1 || n > 100_000) throw new HostError(400, 'Not a page');
  return n;
}

function textOf(c: Context, name: string): string {
  const v = c.req.query(name) ?? '';
  if (!v || v.length > 4000) throw new HostError(400, `Not a ${name}`);
  return v;
}

export interface HostDeps {
  plugins: {
    get(id: string): Loaded | undefined;
    all(): Loaded[];
    update(): Promise<Updated | null>;
  };
  /** The fetching the plugins share, for pictures (fetch.ts). */
  send(url: string, init?: FetchInit): Promise<Response>;
  /** How long a plugin call may take. Tests go faster. */
  wait?: number;
}

export function makeHost(deps: HostDeps): Hono {
  const { plugins } = deps;
  const wait = deps.wait ?? CALL_WAIT;
  const app = new Hono();

  function pluginOf(c: Context): Loaded {
    const id = c.req.query('plugin') ?? '';
    const l = plugins.get(id);
    if (!l) throw new HostError(404, `No plugin ${id}`);
    return l;
  }

  app.onError((err, c) => {
    if (err instanceof HostError) return c.json({ error: err.message }, err.status);
    log.debug({ err, path: c.req.path }, 'a plugin failed');
    return c.json({ error: String((err as Error)?.message ?? err).slice(0, 300) }, 502);
  });

  app.get('/health', (c) => c.json({ plugins: plugins.all().length }));

  app.get('/plugins', (c) => c.json(plugins.all().map((l) => l.meta)));

  app.get('/popular', async (c) => {
    const l = pluginOf(c);
    const page = pageOf(c);
    const latest = c.req.query('latest') === '1';
    const r = await counted(() => l.plugin.popularNovels(page, { showLatestNovels: latest, filters: filtersOf(l) }), wait);
    return c.json(listed(r.value, r.failures));
  });

  app.get('/search', async (c) => {
    const l = pluginOf(c);
    const page = pageOf(c);
    const q = textOf(c, 'q').trim().slice(0, 200);
    const r = await counted(() => l.plugin.searchNovels(q, page), wait);
    return c.json(listed(r.value, r.failures));
  });

  app.get('/novel', async (c) => {
    const l = pluginOf(c);
    const path = textOf(c, 'path');
    const r = await counted(() => l.plugin.parseNovel(path), wait);
    if (!r.value?.name && r.failures.failed > 0) throw siteFailed(r.failures);
    if (!r.value?.name) throw new HostError(502, 'The site has no such novel');
    return c.json(novelOf(l, { ...r.value, path: r.value.path || path }));
  });

  app.get('/chapters', async (c) => {
    const l = pluginOf(c);
    const path = textOf(c, 'path');
    const page = pageOf(c);
    const parsePage = l.plugin.parsePage;
    if (!parsePage) throw new HostError(404, 'That site lists its chapters with the novel');
    const r = await counted(() => parsePage.call(l.plugin, path, String(page)), wait);
    const chapters = r.value?.chapters ?? [];
    if (chapters.length === 0 && r.failures.failed > 0) throw siteFailed(r.failures);
    return c.json({ chapters: chapters.map(chapterOf) });
  });

  app.get('/chapter', async (c) => {
    const l = pluginOf(c);
    const path = textOf(c, 'path');
    const r = await counted(() => l.plugin.parseChapter(path), wait);
    const html = String(r.value ?? '');
    if (!html.trim() && r.failures.failed > 0) throw siteFailed(r.failures);
    return c.json({ html });
  });

  app.get('/image', async (c) => {
    const l = pluginOf(c);
    const url = textOf(c, 'url');
    if (!/^https?:\/\//.test(url)) throw new HostError(400, 'Not a picture’s address');
    const given = l.plugin.imageRequestInit;
    const headers: Record<string, string> = { Referer: l.plugin.site, ...(given?.headers ?? {}) };
    const res = await within(deps.send(url, { method: given?.method, body: given?.body, headers }), wait);
    if (!res.ok) throw new HostError(502, `The site answered ${res.status}`);
    const data = new Uint8Array(await res.arrayBuffer());
    if (data.byteLength > MOST_BYTES) throw new HostError(502, 'Too big a picture');
    const type = pictureType(data);
    if (!type) throw new HostError(502, 'Not a picture');
    return c.body(data as Uint8Array<ArrayBuffer>, 200, { 'content-type': type });
  });

  app.post('/update', async (c) => c.json(await plugins.update()));

  return app;
}
