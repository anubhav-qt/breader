import { sql, type SQL } from 'drizzle-orm';
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
 * A book in this library already points at the file: a copy started from the Shared Library, which
 * keeps working after the sharer takes the book off it.
 */
export const usedBy = (libraryId: string, file: AnyPgColumn | SQL): SQL => sql`EXISTS (
  SELECT 1 FROM library_items h WHERE h.library_id = ${libraryId} AND (h.file_id = ${file} OR h.cover_id = ${file})
)`;
