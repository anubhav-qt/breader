import { sql, type SQL } from 'drizzle-orm';
import { Hono } from 'hono';
import { TRACK_ID, trackKey, type AiFile, type AiMusicResponse, type AiStatus, type AiVoicesResponse, type MusicLink, type RevisitResponse } from '@breader/shared';
import type { AppEnv, Deps } from '../context.ts';
import { cutAt, musicFor, revisitFor, voicesFor } from '../lib/ai.ts';
import { ApiError } from '../lib/errors.ts';
import { rateLimit } from '../lib/http.ts';
import { requireLibrary } from '../lib/library.ts';

/*
 * What an AI made of a book (ai_notes, loaded by ai/tools/import.ts), for a reader whose library
 * has the book with its AI switch on. The notes are the whole book's, so they never leave whole:
 * Revisit is cut at the reader's mark here, and the voice marks go without names. Its music goes
 * as cues and tracks by number, each track's file through a signed link for a while.
 */

const none = () => new ApiError(404, 'not_found', 'There are no notes for this book.');
const noMusic = () => new ApiError(404, 'not_found', 'There is no music for this book.');

export function aiRoutes(deps: Deps) {
  const { db, storage } = deps;
  const r = new Hono<AppEnv>();
  r.use('/books/:bookId/*', requireLibrary(deps));

  /**
   * The book's notes, if this library may have them: its own copy, still on its shelf, with the
   * switch on, here or for the file anywhere (ai_books), should the switch not have reached here yet.
   */
  async function notes<T extends Record<string, unknown>>(libraryId: string, bookId: string, pick: SQL) {
    if (bookId.length > 200) return undefined;
    const { rows: [row] } = await db.execute<T>(sql`
      SELECT ${pick}
        FROM library_items li
        JOIN blobs b ON b.id = li.file_id AND b.status = 'ready'
        JOIN ai_notes n ON n.sha256 = b.sha256
        LEFT JOIN reading_states rs ON rs.library_id = li.library_id AND rs.book_id = li.book_id
       WHERE li.library_id = ${libraryId} AND li.book_id = ${bookId}
         AND (li.ai OR EXISTS (SELECT 1 FROM ai_books a WHERE a.sha256 = b.sha256)) AND li.removed_at IS NULL AND NOT li.shared_only
    `);
    return row;
  }

  r.get('/books/:bookId/ai', rateLimit({ name: 'ai', max: 240, windowMs: 60_000 }), async (c) => {
    const row = await notes<{ made: Date; revisit: boolean; voices: boolean; music: boolean }>(c.var.library.id, c.req.param('bookId'), sql`
      n.made,
      (jsonb_array_length(n.data->'revisit'->'people') + jsonb_array_length(n.data->'revisit'->'places') + jsonb_array_length(n.data->'revisit'->'terms')) > 0 AS revisit,
      jsonb_array_length(n.data->'voices'->'spans') > 0 AS voices,
      n.data ? 'music' AS music`);
    c.header('Cache-Control', 'private, no-store');
    let status: AiStatus = { made: null, revisit: false, voices: false, music: false };
    if (row) status = { made: new Date(row.made).toISOString(), revisit: row.revisit, voices: row.voices, music: row.music };
    return c.json(status);
  });

  r.get('/books/:bookId/revisit', rateLimit({ name: 'ai-revisit', max: 120, windowMs: 60_000 }), async (c) => {
    const row = await notes<{ made: Date; revisit: AiFile['revisit']; mark: Parameters<typeof cutAt>[0] }>(
      c.var.library.id,
      c.req.param('bookId'),
      sql`n.made, n.data->'revisit' AS revisit, rs.mark`,
    );
    if (!row) throw none();
    c.header('Cache-Control', 'private, no-store');
    return c.json(revisitFor({ made: new Date(row.made).toISOString(), revisit: row.revisit }, cutAt(row.mark)) satisfies RevisitResponse);
  });

  r.get('/books/:bookId/voices', rateLimit({ name: 'ai-voices', max: 60, windowMs: 60_000 }), async (c) => {
    const row = await notes<{ made: Date; sections: string[]; voices: AiFile['voices'] }>(
      c.var.library.id,
      c.req.param('bookId'),
      sql`n.made, n.data->'sections' AS sections, n.data->'voices' AS voices`,
    );
    if (!row) throw none();
    c.header('Cache-Control', 'private, no-store');
    return c.json(voicesFor({ made: new Date(row.made).toISOString(), sections: row.sections, voices: row.voices }) satisfies AiVoicesResponse);
  });

  r.get('/books/:bookId/music', rateLimit({ name: 'ai-music', max: 60, windowMs: 60_000 }), async (c) => {
    const row = await notes<{ made: Date; sections: string[]; music: AiFile['music'] | null }>(
      c.var.library.id,
      c.req.param('bookId'),
      sql`n.made, n.data->'sections' AS sections, n.data->'music' AS music`,
    );
    if (!row || !row.music) throw noMusic();
    c.header('Cache-Control', 'private, no-store');
    return c.json(musicFor({ made: new Date(row.made).toISOString(), sections: row.sections, music: row.music }) satisfies AiMusicResponse);
  });

  /** One of the book's tracks, by its number: a signed link to its file. */
  r.get('/books/:bookId/music/:n', rateLimit({ name: 'ai-music-track', max: 240, windowMs: 60_000 }), async (c) => {
    const n = Number(c.req.param('n'));
    if (!Number.isInteger(n) || n < 0 || n > 1000) throw noMusic();
    const row = await notes<{ id: string | null }>(c.var.library.id, c.req.param('bookId'), sql`n.data->'music'->'tracks'->(${n}::int)->>'id' AS id`);
    if (!row || !row.id || !TRACK_ID.test(row.id)) throw noMusic();
    c.header('Cache-Control', 'private, no-store');
    return c.json((await storage.downloadLink(trackKey(row.id))) satisfies MusicLink);
  });

  return r;
}
