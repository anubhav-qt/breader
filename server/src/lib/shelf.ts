import { createHmac, timingSafeEqual } from 'node:crypto';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import { KEEP_WORDS } from '@breader/shared';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { Db } from '../db/client.ts';
import { libraries, libraryGrants } from '../db/schema.ts';

/*
 * Shared libraries. Each library's shared books open to anyone with its key, read only. The key
 * is traded for a token naming the library and its key's epoch, signed with the server's pepper,
 * so a new key closes every token the old one gave.
 *
 * Readers who start a shared book get a copy in their own library, shared there too, that points
 * at the sharer's file. A copy is a source of that file for others once its reader has read
 * KEEP_WORDS of it; until then it only passes on what a source still shares, so a book its owner
 * stops sharing goes from everyone who barely started it, copies of copies too.
 *
 * A series read from a catalogue (a remote book) has no file: shared, it's its url, and a copy of
 * it reads from the catalogue too, so it's the reader's to keep from the start.
 */

/**
 * Item `s` shares its file in its own right: the owner's book, a copy read far enough to keep, a
 * book a saved public library took in (copied_books), which it keeps whatever its original does, or
 * one its uploader put there themselves (`from_uploader`, routes/shelf.ts /shared/add).
 */
const source = (s: string) => sql.raw(`(${s}.origin IS NULL OR ${s}.from_uploader OR coalesce((
  SELECT r.words_read FROM reading_states r WHERE r.library_id = ${s}.library_id AND r.book_id = ${s}.book_id
), 0) >= ${KEEP_WORDS} OR EXISTS (
  SELECT 1 FROM copied_books c WHERE c.copy_id = ${s}.library_id AND c.book_id = ${s}.book_id
))`);

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

/**
 * This library's copies of shared books that it read too little of to keep, which no source shares
 * any more. A series read from a catalogue never goes: its pages were never the sharer's.
 */
export const lapsedIn = (libraryId: string): SQL => sql`
  SELECT h.book_id AS id FROM library_items h
  LEFT JOIN reading_states r ON r.library_id = h.library_id AND r.book_id = h.book_id
  WHERE h.library_id = ${libraryId} AND h.origin IS NOT NULL AND h.removed_at IS NULL AND h.source = 'file'
    AND coalesce(r.words_read, 0) < ${KEEP_WORDS}
    AND NOT ${sharedSomewhere(sql.raw('h.file_id'))}`;

const sign = (scope: string, libraryId: string, epoch: number | string, pepper: string) =>
  createHmac('sha256', pepper).update(`${scope}:${libraryId}:${epoch}`).digest('base64url').slice(0, 32);

/** The token that opens this library's shared books, until its key changes. */
export const sharedToken = (lib: { id: string; keyEpoch: number }, pepper: string) => `${lib.id}.${sign('shared', lib.id, lib.keyEpoch, pepper)}`;

/** A public library's short id, the start of its own: what tells unnamed ones apart in the feed. */
export const publicTag = (libraryId: string) => libraryId.replaceAll('-', '').slice(0, 6);

/** The token the public feed gives out: it reads the library's shared books while it's public, and no more. */
export const publicToken = (lib: { id: string }, pepper: string) => `${lib.id}.${sign('public', lib.id, 0, pepper)}`;

/**
 * A token, for one reader whose ask to change a public library its owner said yes to: it adds to
 * and takes from it, signed in to their own library only, until the owner takes it back or takes
 * the library out of Public.
 */
export const grantToken = (lib: { id: string }, grantId: string, pepper: string) => `${lib.id}.${sign('grant', lib.id, grantId, pepper)}`;

/**
 * key: a token its key was traded for, to read, add to and take from it. grant: one reader's, given
 * by its owner, to do the same but never give out its key. public: one from the feed, to read only.
 */
export type Access = 'key' | 'grant' | 'public';

const same = (got: string, want: string) => {
  const a = Buffer.from(got);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
};

/** A library a token opens, how, and for a grant, whose own library its yes is for. */
export interface Opened {
  lib: typeof libraries.$inferSelect;
  access: Access;
  /** A grant's asker: only a browser signed in to this library changes it by the grant. */
  asker?: string | null;
}

/**
 * The library a token opens the shared books of, if it still does, and how it was opened. A grant
 * opens it only while it's public and the copy it was asked from is still in use.
 */
export async function tokenLibrary(db: Db, token: string, pepper: string): Promise<Opened | null> {
  const dot = token.lastIndexOf('.');
  if (dot < 1) return null;
  const id = token.slice(0, dot);
  const got = token.slice(dot + 1);
  const [lib] = await db.select().from(libraries).where(eq(libraries.id, id));
  if (!lib || lib.retiredAt) return null;
  if (lib.keyEnabled && same(got, sign('shared', lib.id, lib.keyEpoch, pepper))) return { lib, access: 'key' };
  if (!lib.publicAt) return null;
  if (same(got, sign('public', lib.id, 0, pepper))) return { lib, access: 'public' };
  const given = await db
    .select({ id: libraryGrants.id, asker: libraryGrants.askerId })
    .from(libraryGrants)
    .where(and(
      eq(libraryGrants.libraryId, lib.id),
      eq(libraryGrants.state, 'given'),
      sql`EXISTS (SELECT 1 FROM libraries c WHERE c.id = ${libraryGrants.copyId} AND c.retired_at IS NULL)`,
    ));
  for (const grant of given) {
    if (same(got, sign('grant', lib.id, grant.id, pepper))) return { lib, access: 'grant', asker: grant.asker };
  }
  return null;
}

/**
 * How many other libraries keep each of these in their shared list (the synced setting
 * sharedLibraries, data/shelf.ts in the app): by a token, which starts with its id, or as a copy
 * saved from the feed, which names it in `of`.
 */
export async function savesOf(db: Db, ids: string[]): Promise<Map<string, number>> {
  const now = Date.now();
  if (savesKept && now - savesKept.at < SAVES_FOR && ids.every((id) => savesKept!.ids.has(id))) return savesKept.counts;
  const counts = await countSaves(db, ids);
  savesKept = { at: now, ids: new Set(ids), counts };
  return counts;
}

/** Saves as last counted, for a minute at most: counting reads every library's settings. */
let savesKept: { at: number; ids: Set<string>; counts: Map<string, number> } | null = null;
const SAVES_FOR = 60_000;

/** A reader's shared list changed on this server: count saves again on the feed's next ask. */
export function forgetSaves() {
  savesKept = null;
}

async function countSaves(db: Db, ids: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!ids.length) return out;
  const { rows } = await db.execute<{ id: string; saves: number }>(sql`
    SELECT t.id, count(DISTINCT s.library_id)::int AS saves
    FROM library_settings s
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(s.prefs -> 'sharedLibraries') = 'array' THEN s.prefs -> 'sharedLibraries' ELSE '[]'::jsonb END
    ) AS e(saved)
    CROSS JOIN LATERAL (SELECT coalesce(e.saved ->> 'of', split_part(e.saved ->> 'token', '.', 1)) AS id) t
    WHERE t.id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)}) AND s.library_id <> t.id
    GROUP BY t.id
  `);
  for (const row of rows) out.set(row.id, row.saves);
  return out;
}
