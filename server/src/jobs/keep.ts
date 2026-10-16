import type pg from 'pg';

/** How long after a run ends the next starts: a new chapter is kept within the hour. */
export const KEEP_EVERY = 3_600_000;

/** Every url a book in any library is read from: a catalogue's manga (mangadex:, sw:) among them. */
export async function libraryUrls(pool: pg.Pool): Promise<string[]> {
  const { rows } = await pool.query<{ url: string }>(
    `SELECT DISTINCT i.url FROM library_items i JOIN libraries l ON l.id = i.library_id
     WHERE i.removed_at IS NULL AND i.url IS NOT NULL AND l.retired_at IS NULL`,
  );
  return rows.map((r) => r.url);
}
