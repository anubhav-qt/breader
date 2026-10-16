import type { Context } from 'hono';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { BookCoverQuery, BookId, BookSearchQuery, BookVolumeN, type BookSearchEvent, type BooksState } from '@breader/shared';
import type { AppEnv, Deps } from '../context.ts';
import { ApiError, parse, signedOut } from '../lib/errors.ts';
import { rateLimit } from '../lib/http.ts';
import { readSession } from '../lib/session.ts';
import { log } from '../log.ts';

/*
 * Books through the laptop (books/): one search across the novel sites, Project Gutenberg and Open
 * Library, each book's sheet, and its volumes made into EPUBs to read. Anyone may look through it;
 * a volume's EPUB, the most of what it sends, is for browsers signed in to a library, as a book is
 * read once it's added to one. The fallback has no books: it answers that they're off. They're under
 * /catalogue, as /books/:bookId is a library's own books (routes/ai.ts), for its signed-in browsers.
 */
export function bookRoutes(deps: Deps) {
  const { env } = deps;
  const books = deps.books ?? null;
  const r = new Hono<AppEnv>();

  r.get('/catalogue', (c) => {
    c.header('Cache-Control', 'no-store');
    return c.json({ on: !!books } satisfies BooksState);
  });

  r.use('/catalogue/*', async (_c, next) => {
    if (!books) throw new ApiError(503, 'books_off', 'Books aren’t on, on this server.');
    await next();
  });

  const id = (c: Context<AppEnv>) => parse(BookId, c.req.param('id'));
  const volumeN = (c: Context<AppEnv>) => parse(BookVolumeN, c.req.param('n'));

  r.get('/catalogue/search', rateLimit({ name: 'books-search', max: 120, windowMs: 60_000 }), async (c) => {
    const q = parse(BookSearchQuery, c.req.query());
    // Never kept by the browser, as manga's searches aren't (routes/manga.ts).
    c.header('Cache-Control', 'private, no-store');
    if (!q.stream) return c.json(await books!.search(q));
    return streamSSE(c, async (s) => {
      const send = (e: BookSearchEvent) => s.writeSSE({ data: JSON.stringify(e) });
      let sent = Promise.resolve();
      try {
        const lot = await books!.search(q, (items) => { sent = sent.then(() => send({ kind: 'some', items })); });
        await sent;
        await send({ kind: 'lot', items: lot.items, next: lot.next });
      } catch (err) {
        await sent.catch(() => {});
        if (err instanceof ApiError) {
          await send({ kind: 'error', status: err.status, code: err.code, message: err.message });
          return;
        }
        log.error({ err, path: c.req.path }, 'a streamed book search failed');
        await send({ kind: 'error', status: 500, code: 'server_error', message: 'Something went wrong on the server. Try again in a moment.' });
      }
    });
  });

  r.get('/catalogue/item/:id', rateLimit({ name: 'books-item', max: 120, windowMs: 60_000 }), async (c) => {
    c.header('Cache-Control', 'private, max-age=600');
    return c.json(await books!.item(id(c)));
  });

  // A cover, kept by the browser until it's due to be fetched again (manga/covers.ts), then asked after by its tag.
  r.get('/catalogue/item/:id/cover', rateLimit({ name: 'books-cover', max: 600, windowMs: 60_000 }), async (c) => {
    const { size } = parse(BookCoverQuery, c.req.query());
    const got = await books!.cover(id(c), Number(size) as 256 | 512);
    const headers = { 'cache-control': `private, max-age=${got.maxAge}`, etag: got.tag };
    if (c.req.header('if-none-match') === got.tag) return c.body(null, 304, headers);
    return c.body(got.pic.data as Uint8Array<ArrayBuffer>, 200, { 'content-type': got.pic.type, ...headers });
  });

  // Asked every second or two while a volume's being made.
  r.get('/catalogue/item/:id/volume/:n', rateLimit({ name: 'books-volume', max: 600, windowMs: 60_000 }), async (c) => {
    c.header('Cache-Control', 'no-store');
    return c.json(await books!.volume(id(c), volumeN(c)));
  });

  // The EPUB, and how many chapters it holds, for the url it's added with (CATALOGUE_URL).
  r.get('/catalogue/item/:id/volume/:n/file', rateLimit({ name: 'books-file', max: 60, windowMs: 60_000 }), async (c) => {
    if (!readSession(c, env)) throw signedOut();
    const file = await books!.volumeFile(id(c), volumeN(c));
    return c.body(file.data as Uint8Array<ArrayBuffer>, 200, {
      'content-type': 'application/epub+zip',
      'cache-control': 'private, no-store',
      'x-chapters': String(file.chapters),
    });
  });

  return r;
}
