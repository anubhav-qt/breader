import { sql, type SQL } from 'drizzle-orm';
import { Hono } from 'hono';
import { AiFirst, TRACK_ID, trackKey, type AiCastResponse, type AiEntry, type AiFile, type AiMusicResponse, type AiStatus, type AiVoicesResponse, type MusicLink, type RevisitResponse } from '@breader/shared';
import type { AppEnv, Deps } from '../context.ts';
import { castFor, cutAt, musicFor, revisitFor, voicesFor } from '../lib/ai.ts';
import { Memo, MemoryStore } from '../lib/cache.ts';
import { ApiError, parse, readJson } from '../lib/errors.ts';
import { requireLibrary } from '../lib/library.ts';

/*
 * What an AI made of a book (ai_notes, loaded by ai/tools/import.ts), for a reader whose library
 * has the book with its AI switch on. The notes are the whole book's, so they never leave whole:
 * Revisit and the cast are cut at the reader's mark here, and the voice marks go without names.
 * Its music goes as cues and tracks by number, each track's file through a signed link for a while.
 *
 * The notes are big and change only when they're imported again or their music joins them, which
 * gives the row a new version. So each part a reader asks for is fetched once per version and kept,
 * in Redis where there is one: a reader's request asks Supabase only whether they may have them,
 * which version, and where their mark is.
 */

const none = () => new ApiError(404, 'not_found', 'There are no notes for this book.');
const noMusic = () => new ApiError(404, 'not_found', 'There is no music for this book.');
/** A part is kept by its version, so a new version is fetched anyway; this only lets unread ones go. */
const KEPT = 7 * 86_400_000;

/** Whose notes a reader may have, and how far into the book they are. */
type Held = {
  sha256: string;
  version: number;
  made: Date;
  mark: Parameters<typeof cutAt>[0];
};
type Music = NonNullable<AiFile['music']>;

export function aiRoutes(deps: Deps) {
  const { db, storage } = deps;
  const r = new Hono<AppEnv>();
  r.use('/books/:bookId/*', requireLibrary(deps));
  r.use('/ai/first', requireLibrary(deps));
  // Without Redis, a few parts in memory: each can be megabytes.
  const parts = new Memo<unknown>(deps.redis ?? new MemoryStore(32), 'ai:v1:notes', KEPT);

  /**
   * The book's notes, if this library may have them: its own copy, still on its shelf, with the
   * switch on, here or for the file anywhere (ai_books), should the switch not have reached here yet.
   */
  async function held(libraryId: string, bookId: string): Promise<Held | undefined> {
    if (bookId.length > 200) return undefined;
    const { rows: [row] } = await db.execute<Held>(sql`
      SELECT n.sha256, n.version, n.made, rs.mark
        FROM library_items li
        JOIN blobs b ON b.id = li.file_id AND b.status = 'ready'
        JOIN ai_notes n ON n.sha256 = b.sha256
        LEFT JOIN reading_states rs ON rs.library_id = li.library_id AND rs.book_id = li.book_id
       WHERE li.library_id = ${libraryId} AND li.book_id = ${bookId}
         AND (li.ai OR EXISTS (SELECT 1 FROM ai_books a WHERE a.sha256 = b.sha256)) AND li.removed_at IS NULL AND NOT li.shared_only
    `);
    return row;
  }

  /** One part of the notes, as of the version the reader was told of: kept, or fetched and kept. */
  function part<T>(h: Held, name: string, pick: SQL): Promise<T> {
    return parts.get(`${h.sha256}:${h.version}:${name}`, async () => {
      const { rows: [row] } = await db.execute<{ v: T }>(sql`SELECT ${pick} AS v FROM ai_notes n WHERE n.sha256 = ${h.sha256}`);
      return row?.v ?? null;
    }) as Promise<T>;
  }

  const made = (h: Held) => new Date(h.made).toISOString();
  const revisitPart = (h: Held) => part<AiFile['revisit']>(h, 'revisit', sql`n.data->'revisit'`);
  const sectionsPart = (h: Held) => part<string[]>(h, 'sections', sql`n.data->'sections'`);
  const voicesPart = (h: Held) => part<AiFile['voices']>(h, 'voices', sql`n.data->'voices'`);
  const musicPart = (h: Held) => part<Music | null>(h, 'music', sql`n.data->'music'`);

  r.get('/books/:bookId/ai', async (c) => {
    const h = await held(c.var.library.id, c.req.param('bookId'));
    c.header('Cache-Control', 'private, no-store');
    let status: AiStatus = { made: null, revisit: false, voices: false, music: false };
    if (h) {
      const has = await part<Omit<AiStatus, 'made'>>(h, 'status', sql`jsonb_build_object(
        'revisit', (jsonb_array_length(n.data->'revisit'->'people') + jsonb_array_length(n.data->'revisit'->'places') + jsonb_array_length(n.data->'revisit'->'terms')) > 0,
        'voices', jsonb_array_length(n.data->'voices'->'spans') > 0,
        'music', n.data ? 'music')`);
      status = { made: made(h), revisit: has.revisit, voices: has.voices, music: has.music };
    }
    return c.json(status);
  });

  r.get('/books/:bookId/revisit', async (c) => {
    const h = await held(c.var.library.id, c.req.param('bookId'));
    if (!h) throw none();
    const revisit = await revisitPart(h);
    c.header('Cache-Control', 'private, no-store');
    return c.json(revisitFor({ made: made(h), revisit }, cutAt(h.mark)) satisfies RevisitResponse);
  });

  r.get('/books/:bookId/voices', async (c) => {
    const h = await held(c.var.library.id, c.req.param('bookId'));
    if (!h) throw none();
    const [sections, voices] = await Promise.all([sectionsPart(h), voicesPart(h)]);
    c.header('Cache-Control', 'private, no-store');
    return c.json(voicesFor({ made: made(h), sections, voices }) satisfies AiVoicesResponse);
  });

  r.get('/books/:bookId/cast', async (c) => {
    const h = await held(c.var.library.id, c.req.param('bookId'));
    if (!h) throw none();
    const [voices, people] = await Promise.all([voicesPart(h), part<AiEntry[]>(h, 'people', sql`n.data->'revisit'->'people'`)]);
    c.header('Cache-Control', 'private, no-store');
    return c.json(castFor({ made: made(h), voices, people }, cutAt(h.mark)) satisfies AiCastResponse);
  });

  r.get('/books/:bookId/music', async (c) => {
    const h = await held(c.var.library.id, c.req.param('bookId'));
    const music = h && (await musicPart(h));
    if (!h || !music) throw noMusic();
    const sections = await sectionsPart(h);
    c.header('Cache-Control', 'private, no-store');
    return c.json(musicFor({ made: made(h), sections, music }) satisfies AiMusicResponse);
  });

  /** One of the book's tracks, by its number: a signed link to its file. */
  r.get('/books/:bookId/music/:n', async (c) => {
    const n = Number(c.req.param('n'));
    if (!Number.isInteger(n) || n < 0 || n > 1000) throw noMusic();
    const h = await held(c.var.library.id, c.req.param('bookId'));
    const id = h && (await musicPart(h))?.tracks[n]?.id;
    if (!id || !TRACK_ID.test(id)) throw noMusic();
    c.header('Cache-Control', 'private, no-store');
    return c.json((await storage.downloadLink(trackKey(id))) satisfies MusicLink);
  });

  /**
   * The book this library wants done first, of those it let an AI read: the AI marker takes each
   * library's first book before any library's others (ai/tools/marker.ts). One a library no longer
   * has, or no longer has with the switch on, is no one's first.
   */
  r.get('/ai/first', async (c) => {
    const { rows: [row] } = await db.execute<{ book_id: string }>(sql`
      SELECT f.book_id FROM ai_first f
        JOIN library_items li ON li.library_id = f.library_id AND li.book_id = f.book_id AND li.removed_at IS NULL
       WHERE f.library_id = ${c.var.library.id}
    `);
    c.header('Cache-Control', 'private, no-store');
    return c.json({ bookId: row?.book_id ?? null } satisfies AiFirst);
  });

  r.post('/ai/first', async (c) => {
    const { bookId } = parse(AiFirst, await readJson(c));
    const lib = c.var.library.id;
    if (bookId === null) {
      await db.execute(sql`DELETE FROM ai_first WHERE library_id = ${lib}`);
      return c.json({ bookId: null } satisfies AiFirst);
    }
    const { rows: [item] } = await db.execute<{ ok: boolean }>(sql`
      SELECT true AS ok FROM library_items li
        LEFT JOIN blobs b ON b.id = li.file_id
       WHERE li.library_id = ${lib} AND li.book_id = ${bookId} AND li.removed_at IS NULL AND NOT li.shared_only
         AND (li.ai OR EXISTS (SELECT 1 FROM ai_books a WHERE a.sha256 = b.sha256))
    `);
    if (!item) throw new ApiError(404, 'not_found', 'That book isn’t in this library with its AI switch on.');
    await db.execute(sql`
      INSERT INTO ai_first (library_id, book_id) VALUES (${lib}, ${bookId})
      ON CONFLICT (library_id) DO UPDATE SET book_id = EXCLUDED.book_id, at = now()
    `);
    return c.json({ bookId } satisfies AiFirst);
  });

  return r;
}
