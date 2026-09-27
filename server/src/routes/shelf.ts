import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { SHELF_LIMIT, type ShelfResponse } from '@breader/shared';
import type { AppEnv, Deps } from '../context.ts';
import { blobs, libraries, libraryItems } from '../db/schema.ts';
import { ApiError } from '../lib/errors.ts';
import { rateLimit } from '../lib/http.ts';
import { onShelf } from '../lib/shelf.ts';

/*
 * The Shared Library: every book readers have shared, from every library, open to anyone, with or
 * without a key. A shared book is the sharer's own library item with `shared` set, so it leaves
 * the shelf when they remove it. Readers who start one get a copy in their own library that points
 * at the sharer's file (sync/apply.ts), and keeps working after it leaves.
 */
export function shelfRoutes(deps: Deps) {
  const { db, storage } = deps;
  const r = new Hono<AppEnv>();

  r.get('/shelf', rateLimit({ name: 'shelf', max: 240, windowMs: 60_000 }), async (c) => {
    const rows = await db
      .select({
        id: libraryItems.bookId,
        title: sql<string>`coalesce(${libraryItems.editTitle}, ${libraryItems.title})`,
        author: libraryItems.author,
        format: libraryItems.format,
        words: libraryItems.words,
        color: sql<string>`coalesce(${libraryItems.editColor}, ${libraryItems.color})`,
        addedAt: libraryItems.addedAt,
        line: libraryItems.line,
        fileId: libraryItems.fileId,
        coverId: libraryItems.coverId,
      })
      .from(libraryItems)
      .innerJoin(libraries, eq(libraries.id, libraryItems.libraryId))
      .innerJoin(blobs, eq(blobs.id, libraryItems.fileId))
      .where(and(
        eq(libraryItems.shared, true),
        isNull(libraryItems.removedAt),
        eq(libraryItems.source, 'file'),
        isNull(libraries.retiredAt),
        eq(blobs.status, 'ready'),
      ))
      .orderBy(desc(libraryItems.addedAt))
      .limit(SHELF_LIMIT);
    const books = rows.map((b) => ({ ...b, format: b.format as ShelfResponse['books'][number]['format'], addedAt: b.addedAt.getTime(), fileId: b.fileId! }));
    c.header('Cache-Control', 'private, max-age=15');
    return c.json({ books } satisfies ShelfResponse);
  });

  /** A signed download link for a shared book's file or cover. */
  r.get('/shelf/files/:id/link', rateLimit({ name: 'shelf-file', max: 120, windowMs: 60_000 }), async (c) => {
    const [blob] = await db
      .select({ r2Key: blobs.r2Key })
      .from(blobs)
      .where(and(eq(blobs.id, c.req.param('id')), eq(blobs.status, 'ready'), onShelf(blobs.id)));
    if (!blob) throw new ApiError(404, 'not_found', 'That book isn’t on the Shared Library any more.');
    c.header('Cache-Control', 'private, no-store');
    return c.json(await storage.downloadLink(blob.r2Key));
  });

  return r;
}
