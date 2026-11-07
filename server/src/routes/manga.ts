import type { Context } from 'hono';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { AniListAboutQuery, AniListFindQuery, AniListFoundQuery, AniListId, AniListKeptQuery, AniListQuery, AniListSearchQuery, MANGA_KINDS, MangaChaptersQuery, MangaCoverQuery, MangaId, MangaPageQuery, MangaSearchQuery, MangaSeriesQuery, SourceId, type AniListKept, type AniListPage, type MangaKind, type MangaSearchEvent, type MangaState } from '@breader/shared';
import type { AppEnv, Deps } from '../context.ts';
import { ApiError, parse } from '../lib/errors.ts';
import { log } from '../log.ts';
import type { Cover } from '../manga/covers.ts';
import type { Picture } from '../manga/disk.ts';

/** How long Cloudflare and the browser keep a page, in seconds: its address always means the same picture. */
export const PAGE_KEPT = 30 * 24 * 3600;

/*
 * Manga through the laptop (manga/): one search across MangaDex and Breader's Suwayomi sources, and
 * each series from wherever it is. Anyone may look through it and read it: pages and covers are
 * the same for everyone, so Cloudflare keeps them near the reader (ADR 0001, point 1). Pages go
 * through here because MangaDex only lets its own site fetch them from a browser, and Suwayomi
 * isn't open to readers. The fallback reads the sources through the Suwayomi on AWS (infra/aws/).
 */
export function mangaRoutes(deps: Deps) {
  const { manga } = deps;
  const r = new Hono<AppEnv>();

  r.get('/manga', (c) => {
    c.header('Cache-Control', 'no-store');
    return c.json({ on: !!manga } satisfies MangaState);
  });

  r.use('/manga/*', async (_c, next) => {
    if (!manga) throw new ApiError(503, 'manga_off', 'Manga isn’t on, on this server.');
    await next();
  });

  const id = (c: Context<AppEnv>, name = 'id') => parse(MangaId, c.req.param(name));
  const sourceId = (c: Context<AppEnv>) => parse(SourceId, c.req.param('id'));
  /** A page, the same for everyone: kept by Cloudflare and the browser (shared/src/public.ts). */
  const picture = (c: Context<AppEnv>, pic: Picture) =>
    c.body(pic.data as Uint8Array<ArrayBuffer>, 200, { 'content-type': pic.type, 'cache-control': `public, max-age=${PAGE_KEPT}` });
  /** A cover, kept until it's due to be fetched again (manga/covers.ts), then asked after by its tag. */
  const cover = (c: Context<AppEnv>, got: Cover) => {
    const headers = { 'cache-control': `public, max-age=${got.maxAge}`, etag: got.tag };
    if (c.req.header('if-none-match') === got.tag) return c.body(null, 304, headers);
    return c.body(got.pic.data as Uint8Array<ArrayBuffer>, 200, { 'content-type': got.pic.type, ...headers });
  };

  r.get('/manga/search', async (c) => {
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

  r.get('/manga/series/:id', async (c) => {
    const { adult } = parse(MangaSeriesQuery, c.req.query());
    c.header('Cache-Control', 'private, max-age=600');
    return c.json(await manga!.series(id(c), !!adult));
  });

  r.get('/manga/series/:id/chapters', async (c) => {
    const { lang } = parse(MangaChaptersQuery, c.req.query());
    c.header('Cache-Control', 'private, max-age=300');
    return c.json(await manga!.chapters(id(c), lang));
  });

  // Its copies, each group's pages measured: a few pages fetched the first time, kept a day.
  r.get('/manga/series/:id/copies', async (c) => {
    const { lang } = parse(MangaChaptersQuery, c.req.query());
    c.header('Cache-Control', 'private, max-age=3600');
    return c.json(await manga!.copies(id(c), lang));
  });

  // A page each second or two, and a chapter or a few at once when they're kept to read offline.
  r.get('/manga/chapter/:id/:n{[0-9]{1,4}}', async (c) => {
    const { saver } = parse(MangaPageQuery, c.req.query());
    return picture(c, await manga!.page(id(c), Number(c.req.param('n')), !!saver));
  });

  r.get('/manga/cover/:id/:file{[\\w-]{1,80}\\.(?:jpe?g|png|webp|gif)}', async (c) => {
    const { size } = parse(MangaCoverQuery, c.req.query());
    return cover(c, await manga!.cover(id(c), c.req.param('file'), size));
  });

  // AniList's lists for Browse, and what it says of a series: kept a while on the laptop (manga/anilist.ts).
  /** The kinds asked for, in MANGA_KINDS' order so the same ask is kept once; every kind when none are. */
  const kindsOf = (asked: readonly MangaKind[] | undefined): MangaKind[] => {
    if (!asked) return [...MANGA_KINDS];
    return MANGA_KINDS.filter((k) => asked.includes(k));
  };

  r.get('/manga/anilist', async (c) => {
    const q = parse(AniListQuery, c.req.query());
    c.header('Cache-Control', 'private, max-age=600');
    return c.json(await manga!.anilist.list({ sort: q.sort, page: q.page, adult: !!q.adult || !!q.adultOnly, adultOnly: !!q.adultOnly, kinds: kindsOf(q.kinds) }));
  });

  r.get('/manga/anilist/find', async (c) => {
    const q = parse(AniListFindQuery, c.req.query());
    c.header('Cache-Control', 'private, max-age=3600');
    return c.json({ about: await manga!.anilist.find(q.title, !!q.adult) });
  });

  // AniList's best matches for a search, kept a day (a month while it's asked again): Browse shows them first.
  r.get('/manga/anilist/search', async (c) => {
    const q = parse(AniListSearchQuery, c.req.query());
    c.header('Cache-Control', 'private, max-age=600');
    return c.json(await manga!.anilist.search({ q: q.q, adult: !!q.adult || !!q.adultOnly, adultOnly: !!q.adultOnly, kinds: kindsOf(q.kinds) }));
  });

  // The series whose names are closest to what's typed, from the lists the server knows: as a reader types, and for a slip of spelling.
  r.get('/manga/anilist/names', async (c) => {
    const q = parse(AniListSearchQuery, c.req.query());
    c.header('Cache-Control', 'private, max-age=600');
    const items = manga!.anilist.names({ q: q.q, adult: !!q.adult || !!q.adultOnly, adultOnly: !!q.adultOnly, kinds: kindsOf(q.kinds) });
    return c.json({ items, next: null } satisfies AniListPage);
  });

  // Where a page of series is read, those the server knows already: one ask for a list's page, not one a card.
  r.get('/manga/anilist/found', async (c) => {
    const { ids, lang, adult } = parse(AniListKeptQuery, c.req.query());
    c.header('Cache-Control', 'private, max-age=60');
    return c.json({ found: await manga!.aniFoundKept(ids, lang, !!adult) } satisfies AniListKept);
  });

  r.get('/manga/anilist/cover/:id', async (c) => {
    const { size } = parse(MangaCoverQuery, c.req.query());
    return cover(c, await manga!.anilist.cover(parse(AniListId, c.req.param('id')), Number(size) as 256 | 512));
  });

  // Where it can be read: its names looked for on the sites, once a day at most for everyone (manga/anifound.ts).
  r.get('/manga/anilist/:id/found', async (c) => {
    const { lang, adult } = parse(AniListFoundQuery, c.req.query());
    c.header('Cache-Control', 'private, max-age=600');
    return c.json({ found: await manga!.aniFound(parse(AniListId, c.req.param('id')), lang, !!adult) });
  });

  r.get('/manga/anilist/:id', async (c) => {
    const { adult } = parse(AniListAboutQuery, c.req.query());
    c.header('Cache-Control', 'private, max-age=3600');
    return c.json(await manga!.anilist.about(parse(AniListId, c.req.param('id')), !!adult));
  });

  // A series on one of Suwayomi's sources, by its source and address (SourceId).
  r.get('/manga/source/chapter/:id', async (c) => {
    c.header('Cache-Control', 'public, max-age=300');
    return c.json({ pages: await manga!.sourcePages(sourceId(c)) });
  });

  r.get('/manga/source/chapter/:id/:n{[0-9]{1,4}}', async (c) => {
    return picture(c, await manga!.sourcePage(sourceId(c), Number(c.req.param('n'))));
  });

  r.get('/manga/source/:id', async (c) => {
    const { adult } = parse(MangaSeriesQuery, c.req.query());
    c.header('Cache-Control', 'private, max-age=600');
    return c.json(await manga!.sourceSeries(sourceId(c), !!adult));
  });

  r.get('/manga/source/:id/chapters', async (c) => {
    c.header('Cache-Control', 'private, max-age=300');
    return c.json(await manga!.sourceChapters(sourceId(c)));
  });

  r.get('/manga/source/:id/copies', async (c) => {
    c.header('Cache-Control', 'private, max-age=3600');
    return c.json(await manga!.copies(sourceId(c), ''));
  });

  r.get('/manga/source/:id/cover', async (c) => {
    const { size } = parse(MangaCoverQuery, c.req.query());
    return cover(c, await manga!.sourceCover(sourceId(c), size));
  });

  return r;
}
