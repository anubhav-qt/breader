import { sql, type SQL } from 'drizzle-orm';
import { KEEP_WORDS } from '@breader/shared';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

/**
 * A book on the Shared Library points at this file (as its book or its cover): shared, not
 * removed, in a library that is still in use. Anyone may read such a file, and start a copy of the
 * book that points at it.
 */
export const onShelf = (file: AnyPgColumn | SQL): SQL => sql`EXISTS (
  SELECT 1 FROM library_items s JOIN libraries l ON l.id = s.library_id
  WHERE (s.file_id = ${file} OR s.cover_id = ${file}) AND s.shared AND s.removed_at IS NULL AND l.retired_at IS NULL
)`;

/**
 * A book in this library already points at the file, as a copy started from the Shared Library
 * does. Enough to keep pointing at it; reading it takes `keeps`.
 */
export const usedBy = (libraryId: string, file: AnyPgColumn | SQL): SQL => sql`EXISTS (
  SELECT 1 FROM library_items h WHERE h.library_id = ${libraryId} AND (h.file_id = ${file} OR h.cover_id = ${file})
)`;

/**
 * This library may still read the file after the Shared Library stops listing it: its own book
 * points at it, or its copy of a shared book does and it has read KEEP_WORDS of it.
 */
export const keeps = (libraryId: string, file: AnyPgColumn | SQL): SQL => sql`EXISTS (
  SELECT 1 FROM library_items h
  LEFT JOIN reading_states r ON r.library_id = h.library_id AND r.book_id = h.book_id
  WHERE h.library_id = ${libraryId} AND (h.file_id = ${file} OR h.cover_id = ${file})
    AND (h.origin IS NULL OR coalesce(r.words_read, 0) >= ${KEEP_WORDS})
)`;

/**
 * This library's copies of shared books that it read too little of to keep, and whose original is
 * no longer on the Shared Library.
 */
export const lapsedIn = (libraryId: string): SQL => sql`
  SELECT h.book_id AS id FROM library_items h
  LEFT JOIN reading_states r ON r.library_id = h.library_id AND r.book_id = h.book_id
  WHERE h.library_id = ${libraryId} AND h.origin IS NOT NULL AND h.removed_at IS NULL
    AND coalesce(r.words_read, 0) < ${KEEP_WORDS}
    AND NOT EXISTS (
      SELECT 1 FROM library_items s JOIN libraries l ON l.id = s.library_id
      WHERE s.book_id = h.origin AND s.shared AND s.removed_at IS NULL AND l.retired_at IS NULL
    )`;
