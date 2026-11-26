import type pg from 'pg';
import sharp from 'sharp';
import type { Tidier } from '../lib/tidier.ts';
import { log } from '../log.ts';

/*
 * Whether each book's cover is really its front cover, as the model sees it: a blank page, a
 * placeholder or a picture of something else is no. Books only, never manga. Each cover image is
 * asked about once, by its SHA-256, whichever libraries hold it, and the answer kept (cover_checks).
 * Then a yes is copied into each library's books as `cover_ok` (the cover's blob id), in a new
 * revision of that library, so every browser of theirs shows the cover on its next pull. A cover
 * given since the check began waits for that yes (`cover_waits`), showing the drawn card till then
 * and after a no. One from before shows until a no, which makes it wait too.
 */

/** Covers asked about in one run at most: the rest wait for the next. */
const PER_RUN = 50;
const CALL_TIMEOUT = 90_000;
/** A cover the model couldn't answer about waits this long before it's asked again. */
const RETRY_AFTER = 6 * 3_600_000;
/** The longest side a cover is sent at: enough to tell what it is, small enough for any model. */
const SENT_SIDE = 512;

/** When each cover the model couldn't answer about was last tried, by its SHA-256, on this server. */
const failedAt = new Map<string, number>();

/** Covers tried lately without an answer: left out until RETRY_AFTER has gone by. */
function waitingKeys(now: number): string[] {
  const keys: string[] = [];
  for (const [key, at] of failedAt) {
    if (now - at < RETRY_AFTER) keys.push(key);
    else failedAt.delete(key);
  }
  return keys;
}

export interface CoverWanted {
  key: string;
  r2Key: string;
  mime: string;
  title: string;
  author: string;
}

export interface Storage {
  read(key: string, signal?: AbortSignal): Promise<Buffer | null>;
}

const SYSTEM = `You check the covers readers' book files came with. You're shown one image and the book's title and author.
Say whether the image is this book's front cover: its cover art, or a plain page with its title on it.
Say no when the image is blank or nearly blank, a single colour, a placeholder or logo alone, an advert, a picture that has nothing to do with the book, or the cover of a different book.
When you don't know the book, say yes if it looks like a real book cover and nothing on it goes against the title or author.
Answer JSON only: {"ok": true} or {"ok": false}`;

/** The model's yes or no, or null when it said neither. */
export function checkedOk(answer: unknown): boolean | null {
  const ok = (answer as { ok?: unknown })?.ok;
  if (ok === true) return true;
  if (ok === false) return false;
  return null;
}

/** Books' covers nobody has asked the model about yet, one per image, in no set order. */
async function wanted(pool: pg.Pool, limit: number, skip: string[]): Promise<CoverWanted[]> {
  const { rows } = await pool.query<CoverWanted>(
    `SELECT * FROM (
       SELECT DISTINCT ON (b.sha256) b.sha256 AS key, b.r2_key AS "r2Key", b.mime,
              coalesce(li.edit_title, li.title) AS title, li.author
         FROM library_items li
         JOIN libraries l ON l.id = li.library_id AND l.retired_at IS NULL
         JOIN blobs b ON b.id = li.cover_id AND b.status = 'ready'
        WHERE li.removed_at IS NULL AND li.source <> 'remote' AND li.format <> 'CBZ'
          AND NOT EXISTS (SELECT 1 FROM cover_checks c WHERE c.key = b.sha256)
          AND NOT (b.sha256 = ANY($2::text[]))
        ORDER BY b.sha256
     ) x
     ORDER BY random()
     LIMIT $1`,
    [limit, skip],
  );
  return rows;
}

const BOOK_COVER = `li.removed_at IS NULL AND li.source <> 'remote' AND li.format <> 'CBZ' AND li.cover_id IS NOT NULL`;

/** The books whose cover the model said yes to but whose library doesn't know it yet. */
const UNMARKED = `${BOOK_COVER} AND li.cover_ok IS DISTINCT FROM li.cover_id
  AND EXISTS (SELECT 1 FROM blobs b JOIN cover_checks c ON c.key = b.sha256 WHERE b.id = li.cover_id AND c.ok)`;

/** Covers from before the check, still showing, that the model said no to: from now on they wait. */
const REFUSED = `${BOOK_COVER} AND li.cover_waits IS NULL
  AND EXISTS (SELECT 1 FROM blobs b JOIN cover_checks c ON c.key = b.sha256 WHERE b.id = li.cover_id AND NOT c.ok)`;

/** What each kind of answer changes in a book. */
const MARKS = [
  { where: UNMARKED, set: 'cover_ok = li.cover_id' },
  { where: REFUSED, set: 'cover_waits = true' },
];

/** Marks every book the model answered about, one library at a time, each in a new revision. */
async function spread(pool: pg.Pool): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT DISTINCT li.library_id AS id FROM library_items li WHERE (${UNMARKED}) OR (${REFUSED})`,
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
      let marked = 0;
      for (const mark of MARKS) {
        const done = await client.query(
          `UPDATE library_items li SET ${mark.set}, rev = $2 WHERE li.library_id = $1 AND ${mark.where}`,
          [id, rev],
        );
        marked += done.rowCount ?? 0;
      }
      if (marked > 0) await client.query('UPDATE libraries SET rev = $2 WHERE id = $1', [id, rev]);
      await client.query('COMMIT');
      books += marked;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      // Its next run tries that library again.
      log.warn({ err, libraryId: id }, 'checked covers weren’t marked in a library');
    } finally {
      client.release();
    }
  }
  return books;
}

/** The model's answer for one cover, or null when it can't be had: it's asked about again next run. */
async function ask(tidier: Tidier, storage: Storage, w: CoverWanted, signal?: AbortSignal): Promise<{ ok: boolean; by: string } | null> {
  try {
    const bytes = await storage.read(w.r2Key, signal);
    if (!bytes) return null;
    const small = await sharp(bytes).resize({ width: SENT_SIDE, height: SENT_SIDE, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
    const image = `data:image/jpeg;base64,${small.toString('base64')}`;
    const prompt = JSON.stringify({ title: w.title, author: w.author });
    const told = await tidier.json<unknown>(SYSTEM, prompt, { timeout: CALL_TIMEOUT, thinking: 'low', image, later: true });
    const ok = checkedOk(told.value);
    if (ok === null) return null;
    return { ok, by: told.model };
  } catch (err) {
    log.warn({ err, key: w.key }, 'No model could check a cover');
    return null;
  }
}

export interface CoverRun {
  asked: number;
  ok: number;
  no: number;
  books: number;
  /** A full run the model answered in: more covers may be waiting, so the next run comes soon. */
  more: boolean;
}

/** Asks the model about covers not asked about yet, keeps its answers, and marks the books it answered about. */
export async function checkCovers(pool: pg.Pool, tidier: Tidier, storage: Storage, signal?: AbortSignal): Promise<CoverRun> {
  const all = await wanted(pool, PER_RUN, waitingKeys(Date.now()));
  let ok = 0;
  let no = 0;
  for (const w of all) {
    if (signal?.aborted) break;
    const answer = await ask(tidier, storage, w, signal);
    if (!answer) {
      failedAt.set(w.key, Date.now());
      continue;
    }
    await pool.query(`INSERT INTO cover_checks (key, ok, by) VALUES ($1, $2, $3) ON CONFLICT (key) DO NOTHING`, [w.key, answer.ok, answer.by]);
    if (answer.ok) ok += 1;
    else no += 1;
  }
  const books = await spread(pool);
  // While no model answers, the next run waits its usual time.
  const more = all.length === PER_RUN && ok + no > 0;
  return { asked: all.length, ok, no, books, more };
}
