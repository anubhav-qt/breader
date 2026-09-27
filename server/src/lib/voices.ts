import { sql, type SQL } from 'drizzle-orm';
import { KEEP_WORDS } from '@breader/shared';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

/*
 * Who may use an uploaded voice (schema.ts `voices`). Anyone may use a public voice while its
 * owner shares it. The owner may always use their own, and a library that has heard KEEP_WORDS in
 * a voice keeps it: private, removed, or after the owner's library is gone.
 */

/** Voice v is public: shared, not removed, and its owner's library is still in use. */
export const listed = (v = sql.raw('v')): SQL => sql`(${v}.is_public AND ${v}.removed_at IS NULL AND EXISTS (
  SELECT 1 FROM libraries l WHERE l.id = ${v}.library_id AND l.retired_at IS NULL
))`;

/** This library has heard enough of voice v to keep it. */
export const keptBy = (libraryId: string, v = sql.raw('v')): SQL => sql`EXISTS (
  SELECT 1 FROM voice_uses u WHERE u.library_id = ${libraryId} AND u.voice_id = ${v}.id AND u.words >= ${KEEP_WORDS}
)`;

/** Voice v is open to this library (or, with none, to anyone). */
export const usable = (libraryId: string | null, v = sql.raw('v')): SQL =>
  libraryId ? sql`(${listed(v)} OR ${v}.library_id = ${libraryId} OR ${keptBy(libraryId, v)})` : listed(v);

/** A file that belongs to a voice open to this library: its model or pack, settings or sample. */
export const voiceFile = (libraryId: string | null, file: AnyPgColumn | SQL): SQL => sql`EXISTS (
  SELECT 1 FROM voices v WHERE (v.file_id = ${file} OR v.config_id = ${file} OR v.sample_id = ${file}) AND ${usable(libraryId)}
)`;
