import { and, eq, or, sql } from 'drizzle-orm';
import type { Mutation } from '@breader/shared';
import type { Db } from '../db/client.ts';
import { blobs, libraryItems, librarySettings, readingStates, readingTime } from '../db/schema.ts';
import { ApiError } from '../lib/errors.ts';
import { onShelf, usedBy } from '../lib/shelf.ts';

export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

const notFound = () => new ApiError(404, 'not_found', 'That book isn’t in this library.');

/**
 * A file id a book may point at: ready, and this library's own, public, on the Shared Library (a
 * copy of a shared book), or one a book here points at already. The share lock holds until the
 * push commits, so clean-up (jobs/cleanup.ts) can't delete the file in between.
 */
async function checkFile(tx: Tx, libraryId: string, fileId: string | null | undefined) {
  if (!fileId) return;
  const [b] = await tx
    .select({ id: blobs.id })
    .from(blobs)
    .where(and(
      eq(blobs.id, fileId),
      eq(blobs.status, 'ready'),
      or(eq(blobs.ownerLibraryId, libraryId), eq(blobs.isPublic, true), onShelf(blobs.id), usedBy(libraryId, blobs.id)),
    ))
    .for('share', { of: blobs });
  if (!b) throw new ApiError(400, 'file_missing', 'That file hasn’t finished uploading.');
}

const item = (libraryId: string, bookId: string) => and(eq(libraryItems.libraryId, libraryId), eq(libraryItems.bookId, bookId));

/**
 * Applies one queued change inside the push transaction. Every row it touches is stamped with
 * `rev`, the library's new revision, so the next pull from any browser picks it up.
 */
export async function applyMutation(tx: Tx, libraryId: string, rev: number, m: Mutation): Promise<void> {
  switch (m.type) {
    case 'book.put': {
      const b = m.book;
      if ((b.source === 'sample') !== !!b.url) throw new ApiError(400, 'bad_book', 'Only bundled samples have a url.');
      await checkFile(tx, libraryId, b.fileId);
      await checkFile(tx, libraryId, b.coverId);
      await tx
        .insert(libraryItems)
        .values({
          libraryId,
          bookId: b.id,
          title: b.title,
          author: b.author,
          format: b.format,
          source: b.source,
          url: b.url ?? null,
          shared: b.shared,
          addedAt: new Date(b.addedAt),
          words: b.words,
          color: b.color,
          hasCover: !!b.hasCover || !!b.coverId,
          progress: b.progress,
          line: b.line,
          lastOpened: new Date(b.lastOpened),
          fileId: b.fileId ?? null,
          coverId: b.coverId ?? null,
          origin: b.origin ?? null,
          series: b.series?.trim() || null,
          seriesIndex: b.seriesIndex ?? null,
          rev,
        })
        .onConflictDoUpdate({
          target: [libraryItems.libraryId, libraryItems.bookId],
          // The book's own details. Card edits and removal have their own mutations.
          set: {
            title: sql`excluded.title`,
            author: sql`excluded.author`,
            format: sql`excluded.format`,
            source: sql`excluded.source`,
            url: sql`excluded.url`,
            shared: sql`excluded.shared`,
            words: sql`excluded.words`,
            color: sql`excluded.color`,
            hasCover: sql`excluded.has_cover or ${libraryItems.hasCover}`,
            line: sql`excluded.line`,
            fileId: sql`coalesce(excluded.file_id, ${libraryItems.fileId})`,
            coverId: sql`coalesce(excluded.cover_id, ${libraryItems.coverId})`,
            origin: sql`coalesce(excluded.origin, ${libraryItems.origin})`,
            series: sql`excluded.series`,
            seriesIndex: sql`excluded.series_index`,
            rev,
          },
        });
      return;
    }

    case 'book.files': {
      await checkFile(tx, libraryId, m.fileId);
      await checkFile(tx, libraryId, m.coverId);
      const done = await tx
        .update(libraryItems)
        .set({
          fileId: m.fileId ? m.fileId : sql`${libraryItems.fileId}`,
          coverId: m.coverId ? m.coverId : sql`${libraryItems.coverId}`,
          hasCover: m.coverId ? true : sql`${libraryItems.hasCover}`,
          rev,
        })
        .where(item(libraryId, m.bookId))
        .returning({ id: libraryItems.bookId });
      if (!done.length) throw notFound();
      return;
    }

    case 'book.remove':
    case 'book.restore': {
      const done = await tx
        .update(libraryItems)
        .set({ removedAt: m.type === 'book.remove' ? sql`coalesce(${libraryItems.removedAt}, now())` : null, rev })
        .where(item(libraryId, m.bookId))
        .returning({ id: libraryItems.bookId });
      if (!done.length) throw notFound();
      return;
    }

    case 'edit.put': {
      // Each field on its own: renaming on one device and recolouring on another both stick.
      const set: Partial<typeof libraryItems.$inferInsert> = { rev };
      if (m.edit.title !== undefined) set.editTitle = m.edit.title?.trim() || null;
      if (m.edit.color !== undefined) set.editColor = m.edit.color;
      if (m.edit.favorite !== undefined) set.favorite = m.edit.favorite;
      if (m.edit.series !== undefined) set.editSeries = m.edit.series === null ? null : m.edit.series.trim();
      if (m.edit.seriesIndex !== undefined) set.editSeriesIndex = m.edit.seriesIndex;
      const done = await tx.update(libraryItems).set(set).where(item(libraryId, m.bookId)).returning({ id: libraryItems.bookId });
      if (!done.length) throw notFound();
      return;
    }

    case 'read.put': {
      // The most recent reading session wins, by the device's clock but never later than ours.
      const readAt = new Date(Math.min(m.read.lastOpened, Date.now()));
      await tx
        .insert(readingStates)
        .values({
          libraryId,
          bookId: m.bookId,
          position: m.read.pos ?? null,
          progress: m.read.progress,
          line: m.read.line,
          words: m.read.words ?? null,
          readAt,
          rev,
        })
        .onConflictDoUpdate({
          target: [readingStates.libraryId, readingStates.bookId],
          set: {
            position: sql`excluded.position`,
            progress: sql`excluded.progress`,
            line: sql`excluded.line`,
            words: sql`coalesce(excluded.words, ${readingStates.words})`,
            readAt: sql`excluded.read_at`,
            rev,
          },
          setWhere: sql`${readingStates.readAt} <= excluded.read_at`,
        });
      return;
    }

    case 'time.put': {
      // A device's count only grows, so an older count arriving late changes nothing.
      await tx
        .insert(readingTime)
        .values({ libraryId, bookId: m.bookId, day: m.day, device: m.device, seconds: m.seconds, rev })
        .onConflictDoUpdate({
          target: [readingTime.libraryId, readingTime.bookId, readingTime.day, readingTime.device],
          set: { seconds: sql`greatest(${readingTime.seconds}, excluded.seconds)`, rev },
          setWhere: sql`${readingTime.seconds} < excluded.seconds`,
        });
      return;
    }

    case 'settings.put': {
      await tx
        .insert(librarySettings)
        .values({ libraryId, prefs: m.prefs, rev })
        .onConflictDoUpdate({ target: librarySettings.libraryId, set: { prefs: sql`${librarySettings.prefs} || excluded.prefs`, rev } });
      return;
    }
  }
}
