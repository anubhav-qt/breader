import { createHmac, timingSafeEqual } from 'node:crypto';
import { eq, sql, type SQL } from 'drizzle-orm';
import { KEEP_WORDS } from '@breader/shared';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { Db } from '../db/client.ts';
import { libraries } from '../db/schema.ts';

/*
 * Shared libraries. Each library's shared books open to anyone with its key, read only. The key
 * is traded for a token naming the library and its key's epoch, signed with the server's pepper,
 * so a new key closes every token the old one gave.
 *
 * Readers who start a shared book get a copy in their own library, shared there too, that points
 * at the sharer's file. A copy is a source of that file for others once its reader has read
 * KEEP_WORDS of it; until then it only passes on what a source still shares, so a book its owner
 * stops sharing goes from everyone who barely started it, copies of copies too.
 */

/** Item `s` shares its file in its own right: the owner's book, or a copy read far enough to keep. */
const source = (s: string) => sql.raw(`(${s}.origin IS NULL OR coalesce((
  SELECT r.words_read FROM reading_states r WHERE r.library_id = ${s}.library_id AND r.book_id = ${s}.book_id
), 0) >= ${KEEP_WORDS})`);

/** A source still shares this file (as its book or its cover) in a library still in use. */
export const sharedSomewhere = (file: AnyPgColumn | SQL): SQL => sql`EXISTS (
  SELECT 1 FROM library_items s JOIN libraries l ON l.id = s.library_id
  WHERE (s.file_id = ${file} OR s.cover_id = ${file}) AND s.shared AND s.removed_at IS NULL AND l.retired_at IS NULL
    AND ${source('s')}
)`;

/** Item `i` (an alias) can be read from its shared library: a source, or a copy a source still backs. */
export const readable = (i: string): SQL => sql`(${source(i)} OR ${sharedSomewhere(sql.raw(`${i}.file_id`))})`;

/**
 * A book in this library already points at the file, as a copy of a shared book does. Enough to
 * keep pointing at it; reading it takes `keeps`, or a source still sharing it.
 */
export const usedBy = (libraryId: string, file: AnyPgColumn | SQL): SQL => sql`EXISTS (
  SELECT 1 FROM library_items h WHERE h.library_id = ${libraryId} AND (h.file_id = ${file} OR h.cover_id = ${file})
)`;

/**
 * This library may read the file whoever shares it: its own book points at it, or its copy of a
 * shared book does and it has read KEEP_WORDS of it.
 */
export const keeps = (libraryId: string, file: AnyPgColumn | SQL): SQL => sql`EXISTS (
  SELECT 1 FROM library_items h
  LEFT JOIN reading_states r ON r.library_id = h.library_id AND r.book_id = h.book_id
  WHERE h.library_id = ${libraryId} AND (h.file_id = ${file} OR h.cover_id = ${file})
    AND (h.origin IS NULL OR coalesce(r.words_read, 0) >= ${KEEP_WORDS})
)`;

/** This library's copies of shared books that it read too little of to keep, which no source shares any more. */
export const lapsedIn = (libraryId: string): SQL => sql`
  SELECT h.book_id AS id FROM library_items h
  LEFT JOIN reading_states r ON r.library_id = h.library_id AND r.book_id = h.book_id
  WHERE h.library_id = ${libraryId} AND h.origin IS NOT NULL AND h.removed_at IS NULL
    AND coalesce(r.words_read, 0) < ${KEEP_WORDS}
    AND NOT ${sharedSomewhere(sql.raw('h.file_id'))}`;

const sign = (libraryId: string, epoch: number, pepper: string) =>
  createHmac('sha256', pepper).update(`shared:${libraryId}:${epoch}`).digest('base64url').slice(0, 32);

/** The token that opens this library's shared books, until its key changes. */
export const sharedToken = (lib: { id: string; keyEpoch: number }, pepper: string) => `${lib.id}.${sign(lib.id, lib.keyEpoch, pepper)}`;

/** The library a token opens the shared books of, if it still does. */
export async function tokenLibrary(db: Db, token: string, pepper: string) {
  const dot = token.lastIndexOf('.');
  if (dot < 1) return null;
  const id = token.slice(0, dot);
  const [lib] = await db.select().from(libraries).where(eq(libraries.id, id));
  if (!lib || lib.retiredAt || !lib.keyEnabled) return null;
  const want = Buffer.from(sign(lib.id, lib.keyEpoch, pepper));
  const got = Buffer.from(token.slice(dot + 1));
  return got.length === want.length && timingSafeEqual(got, want) ? lib : null;
}
