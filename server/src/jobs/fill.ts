import type pg from 'pg';
import { GENRES, joinGenres } from '@breader/shared';
import type { Gemini } from '../lib/gemini.ts';
import { log } from '../log.ts';

/*
 * What nobody gave a book, filled in by Gemini: its genres, its author when its file names none,
 * and the series a book belongs to when its file doesn't say. A manga in a library gets its genres
 * too. Each is asked about once, by its file's SHA-256 or a manga's address, whichever libraries
 * hold it, and the answer kept (ai_fills). Then it's copied into each library's books where they're
 * still blank, in a new revision of that library, so every browser of theirs has it on its next
 * pull. Never over what someone set: a genre or series the reader picked (or cleared) is theirs,
 * and the app's own guesses (gallery/fill.ts) only fill what's still blank after this.
 */

/** Books in one call. */
const PER_CALL = 25;
/** Books asked about in one run at most: the rest wait for the next. */
const PER_RUN = 200;
const CALL_TIMEOUT = 90_000;
const MOST_GENRES = 3;

/** The key a library's book shares with every copy of it: its file's, or a manga's first copy's address. */
const KEY = `CASE
  WHEN li.source = 'remote' AND li.url IS NOT NULL THEN 'url:' || split_part(split_part(li.url, '|', 1), '#', 1)
  WHEN b.sha256 IS NOT NULL THEN 'sha:' || b.sha256
END`;

/** A book still has something blank that Gemini could fill. */
const BLANK = `((li.genre IS NULL AND li.edit_genre IS NULL) OR li.author = '' OR (li.source <> 'remote' AND li.series IS NULL AND li.edit_series IS NULL))`;

interface Wanted {
  key: string;
  title: string;
  author: string;
  format: string;
  words: number;
  series: string | null;
  manga: boolean;
}

export interface Filled {
  key: string;
  genres: string;
  author: string;
  series: string | null;
  seriesIndex: number | null;
}

const LIST = GENRES.map((g) => `${g.id} (${g.name})`).join(', ');

const SYSTEM = `You fill in what readers left blank in their library. Each line is a book, or a manga, manhwa or manhua series ("manga": true).
For each one give:
- "genres": the 1 to ${MOST_GENRES} that fit it best, by id, from: ${LIST}. Use [] when you don't know the work.
- "author": who wrote it, as usually credited in English, only when "author" is empty and you're sure; otherwise "".
- "series": for a book (never a manga), the name of the series it belongs to, only when its "series" is empty and you're sure it's part of one; otherwise null.
- "index": its number in that series, or null.
Go by what you know of the work. When you don't recognise it, leave everything empty rather than guess from the title.
Answer JSON only: {"items": [{"i": 0, "genres": [], "author": "", "series": null, "index": null}]}`;

/** Gemini's answer for each book asked about, checked: known genres only, plain names, sensible numbers. */
export function checkedFills(answer: unknown, asked: Wanted[]): Filled[] {
  const items = (answer as { items?: unknown })?.items;
  const byI = new Map<number, Record<string, unknown>>();
  if (Array.isArray(items)) {
    for (const x of items) {
      if (x && typeof x === 'object' && typeof (x as { i?: unknown }).i === 'number') byI.set((x as { i: number }).i, x as Record<string, unknown>);
    }
  }
  return asked.map((w, i) => {
    const x = byI.get(i) ?? {};
    const raw = Array.isArray(x.genres) ? x.genres.filter((g): g is string => typeof g === 'string') : [];
    const genres = joinGenres(raw.slice(0, MOST_GENRES));
    const text = (v: unknown) => (typeof v === 'string' ? v.trim().slice(0, 200) : '');
    const author = w.author ? '' : text(x.author);
    let series: string | null = null;
    let seriesIndex: number | null = null;
    if (!w.manga && !w.series) {
      series = text(x.series) || null;
      const n = x.index;
      if (series && typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 10_000) seriesIndex = n;
    }
    return { key: w.key, genres, author, series, seriesIndex };
  });
}

/** Books with something blank that nobody has asked Gemini about yet. */
async function wanted(pool: pg.Pool, limit: number): Promise<Wanted[]> {
  const { rows } = await pool.query<{ key: string; title: string; author: string; format: string; words: number; series: string | null; manga: boolean }>(
    `SELECT DISTINCT ON (key) key, title, author, format, words, series, manga FROM (
       SELECT ${KEY} AS key, coalesce(li.edit_title, li.title) AS title, li.author, li.format, li.words,
              coalesce(nullif(li.edit_series, ''), li.series) AS series, li.source = 'remote' AS manga
         FROM library_items li
         JOIN libraries l ON l.id = li.library_id AND l.retired_at IS NULL
         LEFT JOIN blobs b ON b.id = li.file_id
        WHERE li.removed_at IS NULL AND ${BLANK}
     ) x
     WHERE key IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ai_fills f WHERE f.key = x.key)
     ORDER BY key
     LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({ ...r, words: Number(r.words) }));
}

/** Copies what Gemini filled in into every library's books still blank there, one library at a time. */
async function spread(pool: pg.Pool): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT DISTINCT li.library_id AS id
       FROM library_items li
       LEFT JOIN blobs b ON b.id = li.file_id
       JOIN ai_fills f ON f.key = ${KEY}
      WHERE li.removed_at IS NULL AND (
            (li.genre IS NULL AND li.edit_genre IS NULL AND f.genres <> '')
         OR (li.author = '' AND f.author <> '')
         OR (li.source <> 'remote' AND li.series IS NULL AND li.edit_series IS NULL AND f.series IS NOT NULL))`,
  );
  let books = 0;
  for (const { id } of rows) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: [lib] } = await client.query<{ rev: string }>('SELECT rev FROM libraries WHERE id = $1 FOR UPDATE', [id]);
      if (!lib) {
        await client.query('ROLLBACK');
        continue;
      }
      const rev = Number(lib.rev) + 1;
      const done = await client.query(
        `UPDATE library_items li SET
            genre = CASE WHEN li.genre IS NULL AND li.edit_genre IS NULL AND f.genres <> '' THEN f.genres ELSE li.genre END,
            author = CASE WHEN li.author = '' THEN f.author ELSE li.author END,
            series = CASE WHEN li.source <> 'remote' AND li.series IS NULL AND li.edit_series IS NULL THEN f.series ELSE li.series END,
            series_index = CASE WHEN li.source <> 'remote' AND li.series IS NULL AND li.edit_series IS NULL AND f.series IS NOT NULL THEN f.series_index ELSE li.series_index END,
            rev = $2
           FROM ai_fills f, library_items me LEFT JOIN blobs b ON b.id = me.file_id
          WHERE me.library_id = li.library_id AND me.book_id = li.book_id
            AND li.library_id = $1 AND li.removed_at IS NULL AND f.key = ${KEY.replaceAll('li.', 'me.')}
            AND ((li.genre IS NULL AND li.edit_genre IS NULL AND f.genres <> '')
              OR (li.author = '' AND f.author <> '')
              OR (li.source <> 'remote' AND li.series IS NULL AND li.edit_series IS NULL AND f.series IS NOT NULL))`,
        [id, rev],
      );
      if (done.rowCount) await client.query('UPDATE libraries SET rev = $2 WHERE id = $1', [id, rev]);
      await client.query('COMMIT');
      books += done.rowCount ?? 0;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      // Its next run tries that library again.
      log.warn({ err, libraryId: id }, 'what Gemini filled in wasn’t copied to a library');
    } finally {
      client.release();
    }
  }
  return books;
}

export interface FillRun {
  asked: number;
  filled: number;
  books: number;
}

/** Asks Gemini about what's blank and not asked about yet, keeps its answers, and copies them where they're still blank. */
export async function fillBlanks(pool: pg.Pool, gemini: Gemini, signal?: AbortSignal): Promise<FillRun> {
  const all = await wanted(pool, PER_RUN);
  let filled = 0;
  for (let i = 0; i < all.length && !signal?.aborted; i += PER_CALL) {
    const batch = all.slice(i, i + PER_CALL);
    const shown = batch.map((w, n) => ({ i: n, title: w.title, author: w.author, format: w.format, words: w.words || undefined, series: w.series ?? '', manga: w.manga }));
    let fills: Filled[];
    try {
      fills = checkedFills(await gemini.json<unknown>(SYSTEM, JSON.stringify(shown), { timeout: CALL_TIMEOUT, thinking: 'low' }), batch);
    } catch (err) {
      // Not kept, so they're asked about again next run.
      log.warn({ err, books: batch.length }, 'Gemini couldn’t fill in a lot of books');
      continue;
    }
    for (const f of fills) {
      await pool.query(
        `INSERT INTO ai_fills (key, genres, author, series, series_index, by) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (key) DO NOTHING`,
        [f.key, f.genres, f.author, f.series, f.seriesIndex, gemini.model('low')],
      );
      if (f.genres || f.author || f.series) filled += 1;
    }
  }
  const books = await spread(pool);
  return { asked: all.length, filled, books };
}
