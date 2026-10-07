import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { log } from '../log.ts';
import type { Tx } from './apply.ts';

/*
 * The AI switch belongs to the book's file, not to one library's copy of it: once any library says
 * yes, it's on in every library holding the same file (by SHA-256), those that had it and those
 * that get it later, and it stays on (ai_books).
 */

/**
 * After a change to a book in the push: if its switch is on, the file is marked as said yes to; if
 * the file already is, the switch goes back on here, in this same revision. Returns the file's
 * SHA-256 when the switch is on, so the push can turn it on in the other libraries holding it.
 */
export async function settleAi(tx: Tx, libraryId: string, bookId: string, rev: number): Promise<string | null> {
  const { rows: [b] } = await tx.execute<{ sha256: string; ai: boolean; marked: boolean }>(sql`
    SELECT b.sha256, li.ai, EXISTS (SELECT 1 FROM ai_books a WHERE a.sha256 = b.sha256) AS marked
      FROM library_items li JOIN blobs b ON b.id = li.file_id
     WHERE li.library_id = ${libraryId} AND li.book_id = ${bookId}
  `);
  if (!b) return null;
  if (b.ai && !b.marked) await tx.execute(sql`INSERT INTO ai_books (sha256) VALUES (${b.sha256}) ON CONFLICT DO NOTHING`);
  if (!b.ai && b.marked) {
    await tx.execute(sql`UPDATE library_items SET ai = true, rev = ${rev} WHERE library_id = ${libraryId} AND book_id = ${bookId}`);
  }
  return b.ai || b.marked ? b.sha256 : null;
}

/**
 * Turns the switch on in every other library holding one of these files with it still off, each in
 * a new revision of its own, so every browser of theirs hears of it on its next pull. Run after
 * the push commits, one library at a time: a push holds its own library's lock, and taking
 * another's in the same transaction could wait on a push there doing the same.
 */
export async function spreadAi(db: Db, shas: Iterable<string>): Promise<void> {
  const list = [...new Set(shas)];
  if (!list.length) return;
  const { rows } = await db.execute<{ id: string }>(sql`
    SELECT DISTINCT li.library_id AS id
      FROM library_items li JOIN blobs b ON b.id = li.file_id
     WHERE b.sha256 IN ${list} AND NOT li.ai
  `);
  for (const { id } of rows) {
    try {
      await db.transaction(async (tx) => {
        const { rows: [lib] } = await tx.execute<{ rev: number }>(sql`SELECT rev FROM libraries WHERE id = ${id} FOR UPDATE`);
        if (!lib) return;
        const rev = Number(lib.rev) + 1;
        const done = await tx.execute(sql`
          UPDATE library_items li SET ai = true, rev = ${rev}
            FROM blobs b
           WHERE li.library_id = ${id} AND b.id = li.file_id AND b.sha256 IN ${list} AND NOT li.ai
        `);
        if (done.rowCount) await tx.execute(sql`UPDATE libraries SET rev = ${rev} WHERE id = ${id}`);
      });
    } catch (err) {
      // That library's next change to the book settles it anyway (settleAi).
      log.warn({ err, libraryId: id }, 'AI switch not spread');
    }
  }
}
