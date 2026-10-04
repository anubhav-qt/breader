import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import {
  LIBRARY_NAME,
  LIBRARY_NAME_CHARS,
  normalizeKey,
  SHELF_LIMIT,
  SharedBooksRequest,
  SharedLinkRequest,
  SharedOpenRequest,
  type SharedBooksResponse,
  type SharedOpenResponse,
} from '@breader/shared';
import type { AppEnv, Deps } from '../context.ts';
import { blobs, libraries, librarySettings, libraryItems } from '../db/schema.ts';
import { ApiError, parse, readJson } from '../lib/errors.ts';
import { rateLimit } from '../lib/http.ts';
import { sessionLibrary } from '../lib/library.ts';
import { hashKey } from '../lib/session.ts';
import { readable, sharedToken, tokenLibrary } from '../lib/shelf.ts';

/*
 * Shared libraries (lib/shelf.ts): anyone with a library's key sees the books it shares, opens
 * them, and copies them into their own library, but can't change or remove them. The key is traded
 * once for a token, which is all the rest takes. Nothing here needs a library of one's own, so a
 * reader new to Breader can open a friend's books first.
 */

const badKey = () => new ApiError(400, 'bad_key', 'That isn’t a Breader key. Keys look like BRDR-XXXX-XXXX-XXXX-XXXX-XXXX.');
const unknownKey = () => new ApiError(404, 'unknown_key', 'That key doesn’t open a library. Check it and try again.');
const closed = () => new ApiError(404, 'shared_closed', 'This library isn’t open with that key any more. Its owner may have a new key.');

export function shelfRoutes(deps: Deps) {
  const { db, env, storage } = deps;
  const r = new Hono<AppEnv>();

  /** What the owner named it, if they did. */
  const nameOf = async (libraryId: string) => {
    const [row] = await db
      .select({ name: sql<unknown>`${librarySettings.prefs} -> ${LIBRARY_NAME}` })
      .from(librarySettings)
      .where(eq(librarySettings.libraryId, libraryId));
    return typeof row?.name === 'string' && row.name.trim() ? row.name.trim().slice(0, LIBRARY_NAME_CHARS) : null;
  };

  const opened = async (token: string) => {
    const lib = await tokenLibrary(db, token, env.KEY_PEPPER);
    if (!lib) throw closed();
    return lib;
  };

  /** A key, for the token that opens its library's shared books. */
  r.post('/shared/open', rateLimit({ name: 'shared-open', max: 10, windowMs: 60_000 }), async (c) => {
    const key = normalizeKey(parse(SharedOpenRequest, await readJson(c)).key);
    if (!key) throw badKey();
    const [lib] = await db.select().from(libraries).where(eq(libraries.keyHash, hashKey(key, env.KEY_PEPPER)));
    if (!lib || lib.retiredAt || !lib.keyEnabled) throw unknownKey();
    const mine = await sessionLibrary(c, deps);
    c.header('Cache-Control', 'private, no-store');
    return c.json({ token: sharedToken(lib, env.KEY_PEPPER), name: await nameOf(lib.id), own: mine?.id === lib.id } satisfies SharedOpenResponse);
  });

  /** The books a library shares, newest first. */
  r.post('/shared/books', rateLimit({ name: 'shared-books', max: 240, windowMs: 60_000 }), async (c) => {
    const lib = await opened(parse(SharedBooksRequest, await readJson(c)).token);
    const rows = await db
      .select({
        id: libraryItems.bookId,
        origin: libraryItems.origin,
        title: sql<string>`coalesce(${libraryItems.editTitle}, ${libraryItems.title})`,
        author: libraryItems.author,
        format: libraryItems.format,
        words: libraryItems.words,
        color: sql<string>`coalesce(${libraryItems.editColor}, ${libraryItems.color})`,
        addedAt: libraryItems.addedAt,
        line: libraryItems.line,
        fileId: libraryItems.fileId,
        coverId: libraryItems.coverId,
        // The sharer's own series wins over the file's; '' means they took it out of one.
        series: sql<string | null>`case when ${libraryItems.editSeries} is not null then nullif(${libraryItems.editSeries}, '') else ${libraryItems.series} end`,
        seriesIndex: sql<number | null>`coalesce(${libraryItems.editSeriesIndex}, ${libraryItems.seriesIndex})`,
        // Likewise the genre: the sharer's own pick, '' for unset, over the one it was added with.
        genre: sql<string | null>`case when ${libraryItems.editGenre} is not null then nullif(${libraryItems.editGenre}, '') else ${libraryItems.genre} end`,
      })
      .from(libraryItems)
      .innerJoin(blobs, eq(blobs.id, libraryItems.fileId))
      .where(and(
        eq(libraryItems.libraryId, lib.id),
        eq(libraryItems.shared, true),
        isNull(libraryItems.removedAt),
        eq(libraryItems.source, 'file'),
        eq(blobs.status, 'ready'),
        readable('library_items'),
      ))
      .orderBy(desc(libraryItems.addedAt))
      .limit(SHELF_LIMIT);
    const books = rows.map((b) => ({ ...b, format: b.format as SharedBooksResponse['books'][number]['format'], addedAt: b.addedAt.getTime(), fileId: b.fileId! }));
    c.header('Cache-Control', 'private, no-store');
    return c.json({ name: await nameOf(lib.id), books } satisfies SharedBooksResponse);
  });

  /** A signed download link for one of a library's shared books, or its cover. */
  r.post('/shared/link', rateLimit({ name: 'shared-file', max: 120, windowMs: 60_000 }), async (c) => {
    const { token, fileId } = parse(SharedLinkRequest, await readJson(c));
    const lib = await opened(token);
    const [blob] = await db
      .select({ r2Key: blobs.r2Key })
      .from(blobs)
      .where(and(
        eq(blobs.id, fileId),
        eq(blobs.status, 'ready'),
        sql`EXISTS (
          SELECT 1 FROM library_items i
          WHERE i.library_id = ${lib.id} AND i.shared AND i.removed_at IS NULL
            AND (i.file_id = ${blobs.id} OR i.cover_id = ${blobs.id}) AND ${readable('i')}
        )`,
      ));
    if (!blob) throw new ApiError(404, 'not_found', 'That book isn’t shared in this library any more.');
    c.header('Cache-Control', 'private, no-store');
    return c.json(await storage.downloadLink(blob.r2Key));
  });

  return r;
}
