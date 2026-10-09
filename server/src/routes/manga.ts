import type { Context } from 'hono';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { MangaChaptersQuery, MangaCoverQuery, MangaId, MangaPageQuery, MangaSearchQuery, MangaSeriesQuery, SourceId, type MangaSearchEvent, type MangaState } from '@breader/shared';
import type { AppEnv, Deps } from '../context.ts';
import { ApiError, parse, signedOut } from '../lib/errors.ts';
import { rateLimit } from '../lib/http.ts';
import { readSession } from '../lib/session.ts';
import { log } from '../log.ts';
import type { Cover } from '../manga/covers.ts';
import type { Picture } from '../manga/disk.ts';

/*
 * Manga through the laptop (manga/): one search across MangaDex and Breader's Suwayomi sources, and
 * each series from wherever it is. Anyone may look through it; pages, the most of what it sends,
 * are for browsers signed in to a library, as a series is read once it's added to one. Pages go
 * through here because MangaDex only lets its own site fetch them from a browser, and Suwayomi
 * isn't open to readers. The fallback has no manga: it answers that it's off.
 */
export function mangaRoutes(deps: Deps) {
  const { env, manga } = deps;
  const r = new Hono<AppEnv>();

  r.get('/manga', (c) => {
    c.header('Cache-Control', 'no-store');
    return c.json({ on: !!manga } satisfies MangaState);
  });

  r.use('/manga/*', async (_c, next) => {
    if (!manga) throw new ApiError(503, 'manga_off', 'Manga isn’t on, on this server.');
    await next();
  });
  // The signed cookie is enough to tell a reader from a stranger, and asks nothing of the database,
  // which every page would otherwise.
  r.use('/manga/chapter/*', async (c, next) => {
    if (!readSession(c, env)) throw signedOut();
    await next();
  });
  r.use('/manga/source/chapter/*', async (c, next) => {
    if (!readSession(c, env)) throw signedOut();
    await next();
  });

  const id = (c: Context<AppEnv>, name = 'id') => parse(MangaId, c.req.param(name));
  const sourceId = (c: Context<AppEnv>) => parse(SourceId, c.req.param('id'));
  const picture = (c: Context<AppEnv>, pic: Picture, maxAge: number) =>
    c.body(pic.data as Uint8Array<ArrayBuffer>, 200, { 'content-type': pic.type, 'cache-control': `private, max-age=${maxAge}` });
  /** A cover, kept by the browser until it's due to be fetched again (manga/covers.ts), then asked after by its tag. */
  const cover = (c: Context<AppEnv>, got: Cover) => {
    const headers = { 'cache-control': `private, max-age=${got.maxAge}`, etag: got.tag };
    if (c.req.header('if-none-match') === got.tag) return c.body(null, 304, headers);
    return c.body(got.pic.data as Uint8Array<ArrayBuffer>, 200, { 'content-type': got.pic.type, ...headers });
  };

  r.get('/manga/search', rateLimit({ name: 'manga-search', max: 120, windowMs: 60_000 }), async (c) => {
    const q = parse(MangaSearchQuery, c.req.query());
    // Never kept by the browser: a lot where every place was late answers differently a moment
    // later, and a kept copy would be shown instead, over and over. The server keeps its own.
    c.header('Cache-Control', 'private, no-store');
    if (!q.stream) return c.json(await manga!.search(q));
    // Streamed: each place's series as they come, so a slow site doesn't hold up a quick one's. The
    // events go one after another, each written before the next.
    return streamSSE(c, async (s) => {
      const send = (e: MangaSearchEvent) => s.writeSSE({ data: JSON.stringify(e) });
      let sent = Promise.resolve();
      try {
        const lot = await manga!.search(q, (items) => { sent = sent.then(() => send({ kind: 'some', items })); });
        await sent;
        await send({ kind: 'lot', items: lot.items, next: lot.next });
      } catch (err) {
        await sent.catch(() => {});
        if (err instanceof ApiError) {
          await send({ kind: 'error', status: err.status, code: err.code, message: err.message });
          return;
        }
        log.error({ err, path: c.req.path }, 'a streamed search failed');
        await send({ kind: 'error', status: 500, code: 'server_error', message: 'Something went wrong on the server. Try again in a moment.' });
      }
    });
  });

  r.get('/manga/series/:id', rateLimit({ name: 'manga-series', max: 120, windowMs: 60_000 }), async (c) => {
    const { adult } = parse(MangaSeriesQuery, c.req.query());
    c.header('Cache-Control', 'private, max-age=600');
    return c.json(await manga!.series(id(c), !!adult));
  });

  r.get('/manga/series/:id/chapters', rateLimit({ name: 'manga-chapters', max: 60, windowMs: 60_000 }), async (c) => {
    const { lang } = parse(MangaChaptersQuery, c.req.query());
    c.header('Cache-Control', 'private, max-age=300');
    return c.json(await manga!.chapters(id(c), lang));
  });

  // Its copies, each group's pages measured: a few pages fetched the first time, kept a day.
  r.get('/manga/series/:id/copies', rateLimit({ name: 'manga-copies', max: 60, windowMs: 60_000 }), async (c) => {
    const { lang } = parse(MangaChaptersQuery, c.req.query());
    c.header('Cache-Control', 'private, max-age=3600');
    return c.json(await manga!.copies(id(c), lang));
  });

  // A page each second or two, and a chapter or a few at once when they're kept to read offline.
  r.get('/manga/chapter/:id/:n{[0-9]{1,4}}', rateLimit({ name: 'manga-page', max: 600, windowMs: 60_000 }), async (c) => {
    const { saver } = parse(MangaPageQuery, c.req.query());
    return picture(c, await manga!.page(id(c), Number(c.req.param('n')), !!saver), 86_400);
  });

  r.get('/manga/cover/:id/:file{[\\w-]{1,80}\\.(?:jpe?g|png|webp|gif)}', rateLimit({ name: 'manga-cover', max: 600, windowMs: 60_000 }), async (c) => {
    const { size } = parse(MangaCoverQuery, c.req.query());
    return cover(c, await manga!.cover(id(c), c.req.param('file'), size));
  });

  // A series on Suwayomi, by ids like sw:12.
  r.get('/manga/source/chapter/:id', rateLimit({ name: 'manga-source-pages', max: 120, windowMs: 60_000 }), async (c) => {
    c.header('Cache-Control', 'private, max-age=300');
    return c.json({ pages: await manga!.sourcePages(sourceId(c)) });
  });

  r.get('/manga/source/chapter/:id/:n{[0-9]{1,4}}', rateLimit({ name: 'manga-page', max: 600, windowMs: 60_000 }), async (c) => {
    return picture(c, await manga!.sourcePage(sourceId(c), Number(c.req.param('n'))), 86_400);
  });

  r.get('/manga/source/:id', rateLimit({ name: 'manga-series', max: 120, windowMs: 60_000 }), async (c) => {
    const { adult } = parse(MangaSeriesQuery, c.req.query());
    c.header('Cache-Control', 'private, max-age=600');
    return c.json(await manga!.sourceSeries(sourceId(c), !!adult));
  });

  r.get('/manga/source/:id/chapters', rateLimit({ name: 'manga-chapters', max: 60, windowMs: 60_000 }), async (c) => {
    c.header('Cache-Control', 'private, max-age=300');
    return c.json(await manga!.sourceChapters(sourceId(c)));
  });

  r.get('/manga/source/:id/copies', rateLimit({ name: 'manga-copies', max: 60, windowMs: 60_000 }), async (c) => {
    c.header('Cache-Control', 'private, max-age=3600');
    return c.json(await manga!.copies(sourceId(c), ''));
  });

  r.get('/manga/source/:id/cover', rateLimit({ name: 'manga-cover', max: 600, windowMs: 60_000 }), async (c) => {
    const { size } = parse(MangaCoverQuery, c.req.query());
    return cover(c, await manga!.sourceCover(sourceId(c), size));
  });

  return r;
}
