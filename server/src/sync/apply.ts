import { and, eq, or, sql } from 'drizzle-orm';
import { KOKORO_PACK_BYTES, type Mutation } from '@breader/shared';
import type { Db } from '../db/client.ts';
import { blobs, libraryItems, librarySettings, readingStates, readingTime, voices, voiceUses } from '../db/schema.ts';
import { ApiError } from '../lib/errors.ts';
import { onShelf, usedBy } from '../lib/shelf.ts';
import { usable } from '../lib/voices.ts';

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

/** One of this library's own uploads, of this kind, for a voice. Share-locked like checkFile. */
async function checkOwnFile(tx: Tx, libraryId: string, fileId: string, kind: 'voice' | 'sample', size?: number) {
  const [b] = await tx
    .select({ size: blobs.size })
    .from(blobs)
    .where(and(eq(blobs.id, fileId), eq(blobs.status, 'ready'), eq(blobs.ownerLibraryId, libraryId), eq(blobs.kind, kind)))
    .for('share', { of: blobs });
  if (!b) throw new ApiError(400, 'file_missing', 'That file hasn’t finished uploading.');
  if (size !== undefined && b.size !== size) throw new ApiError(400, 'bad_voice', 'That isn’t a Kokoro voice pack.');
}

const voiceGone = () => new ApiError(404, 'not_found', 'That voice isn’t available.');

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
          sharedOnly: !!b.sharedOnly,
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
          genre: b.genre ?? null,
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
            sharedOnly: sql`excluded.shared_only`,
            words: sql`excluded.words`,
            color: sql`excluded.color`,
            hasCover: sql`excluded.has_cover or ${libraryItems.hasCover}`,
            line: sql`excluded.line`,
            fileId: sql`coalesce(excluded.file_id, ${libraryItems.fileId})`,
            coverId: sql`coalesce(excluded.cover_id, ${libraryItems.coverId})`,
            origin: sql`coalesce(excluded.origin, ${libraryItems.origin})`,
            series: sql`excluded.series`,
            seriesIndex: sql`excluded.series_index`,
            // Set when the book is added; a later put without one (an older app) keeps it.
            genre: sql`coalesce(excluded.genre, ${libraryItems.genre})`,
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
      if (m.edit.genre !== undefined) set.editGenre = m.edit.genre;
      if (m.edit.ai !== undefined) set.ai = m.edit.ai;
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
          wordsRead: m.read.wordsRead ?? 0,
          mark: m.read.mark ?? null,
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
      // Words read only grow, whichever device's session is newer.
      if (m.read.wordsRead) {
        await tx
          .update(readingStates)
          .set({ wordsRead: m.read.wordsRead, rev })
          .where(and(eq(readingStates.libraryId, libraryId), eq(readingStates.bookId, m.bookId), sql`${readingStates.wordsRead} < ${m.read.wordsRead}`));
      }
      // So does the mark: a later reading of the book, or further into this one.
      if (m.read.mark) {
        const { n = 0, progress } = m.read.mark;
        await tx
          .update(readingStates)
          .set({ mark: m.read.mark, rev })
          .where(
            and(
              eq(readingStates.libraryId, libraryId),
              eq(readingStates.bookId, m.bookId),
              sql`(${readingStates.mark} is null or (coalesce((${readingStates.mark}->>'n')::int, 0), (${readingStates.mark}->>'progress')::float8) < (${n}::int, ${progress}::float8))`,
            ),
          );
      }
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

    case 'voice.put': {
      const v = m.voice;
      const [cur] = await tx.select({ libraryId: voices.libraryId }).from(voices).where(eq(voices.id, v.id)).for('update');
      if (cur && cur.libraryId !== libraryId) throw new ApiError(403, 'not_yours', 'That voice belongs to someone else.');
      // Its model never changes once it's made: readers who keep it keep that one.
      if (!cur) {
        await checkOwnFile(tx, libraryId, v.fileId, 'voice', v.engine === 'kokoro' ? KOKORO_PACK_BYTES : undefined);
        if ((v.engine === 'piper') !== !!v.configId) throw new ApiError(400, 'bad_voice', 'Piper voices need their .onnx.json; Kokoro packs have none.');
        if (v.configId) await checkOwnFile(tx, libraryId, v.configId, 'voice');
      }
      if (v.sampleId) await checkOwnFile(tx, libraryId, v.sampleId, 'sample');
      await tx
        .insert(voices)
        .values({
          id: v.id,
          libraryId,
          name: v.name,
          engine: v.engine,
          lang: v.lang.toLowerCase(),
          fileId: v.fileId,
          configId: v.configId ?? null,
          sampleId: v.sampleId ?? null,
          isPublic: v.public,
          gender: v.gender ?? null,
        })
        .onConflictDoUpdate({
          target: voices.id,
          set: {
            name: sql`excluded.name`,
            lang: sql`excluded.lang`,
            sampleId: sql`coalesce(excluded.sample_id, ${voices.sampleId})`,
            isPublic: sql`excluded.is_public`,
            gender: sql`coalesce(excluded.gender, ${voices.gender})`,
            updatedAt: sql`now()`,
          },
        });
      return;
    }

    case 'voice.remove': {
      const done = await tx
        .update(voices)
        .set({ removedAt: sql`coalesce(${voices.removedAt}, now())`, updatedAt: sql`now()` })
        .where(and(eq(voices.id, m.voiceId), eq(voices.libraryId, libraryId)))
        .returning({ id: voices.id });
      if (!done.length) throw voiceGone();
      return;
    }

    case 'voice.use': {
      const open = await tx.execute(sql`SELECT 1 FROM voices v WHERE v.id = ${m.voiceId} AND ${usable(libraryId)}`);
      if (!open.rows.length) throw voiceGone();
      // Counts only grow, so a late or repeated count changes nothing.
      await tx
        .insert(voiceUses)
        .values({ libraryId, voiceId: m.voiceId, words: m.words })
        .onConflictDoUpdate({
          target: [voiceUses.libraryId, voiceUses.voiceId],
          set: { words: sql`excluded.words`, usedAt: sql`now()` },
          setWhere: sql`${voiceUses.words} < excluded.words`,
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
