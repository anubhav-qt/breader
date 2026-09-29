import { sql, type SQL } from 'drizzle-orm';
import { Hono } from 'hono';
import type { AiFile, AiStatus, AiVoicesResponse, RevisitResponse } from '@breader/shared';
import type { AppEnv, Deps } from '../context.ts';
import { cutAt, revisitFor, voicesFor } from '../lib/ai.ts';
import { ApiError } from '../lib/errors.ts';
import { rateLimit } from '../lib/http.ts';
import { requireLibrary } from '../lib/library.ts';

/*
 * What an AI made of a book (ai_notes, loaded by ai/tools/import.ts), for a reader whose library
 * has the book with its AI switch on. The notes are the whole book's, so they never leave whole:
 * Revisit is cut at the reader's mark here, and the voice marks go without names.
 */

const none = () => new ApiError(404, 'not_found', 'There are no notes for this book.');

export function aiRoutes(deps: Deps) {
  const { db } = deps;
  const r = new Hono<AppEnv>();
  r.use('/books/:bookId/*', requireLibrary(deps));

  /** The book's notes, if this library may have them: its own copy, still on its shelf, with the switch on. */
  async function notes<T extends Record<string, unknown>>(libraryId: string, bookId: string, pick: SQL) {
    if (bookId.length > 200) return undefined;
    const { rows: [row] } = await db.execute<T>(sql`
      SELECT ${pick}
        FROM library_items li
        JOIN blobs b ON b.id = li.file_id AND b.status = 'ready'
        JOIN ai_notes n ON n.sha256 = b.sha256
        LEFT JOIN reading_states rs ON rs.library_id = li.library_id AND rs.book_id = li.book_id
       WHERE li.library_id = ${libraryId} AND li.book_id = ${bookId}
         AND li.ai AND li.removed_at IS NULL AND NOT li.shared_only
    `);
    return row;
  }

  r.get('/books/:bookId/ai', rateLimit({ name: 'ai', max: 240, windowMs: 60_000 }), async (c) => {
    const row = await notes<{ made: Date; revisit: boolean; voices: boolean }>(c.var.library.id, c.req.param('bookId'), sql`
      n.made,
      (jsonb_array_length(n.data->'revisit'->'people') + jsonb_array_length(n.data->'revisit'->'places') + jsonb_array_length(n.data->'revisit'->'terms')) > 0 AS revisit,
      jsonb_array_length(n.data->'voices'->'spans') > 0 AS voices`);
    c.header('Cache-Control', 'private, no-store');
    const status: AiStatus = row ? { made: new Date(row.made).toISOString(), revisit: row.revisit, voices: row.voices } : { made: null, revisit: false, voices: false };
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

  return r;
}
