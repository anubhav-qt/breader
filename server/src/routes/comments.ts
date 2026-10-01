import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import {
  BOOK_THREAD,
  CommentName,
  Id,
  PostComment,
  THREAD_LIMIT,
  foldName,
  type BookComment,
  type CommentList,
  type CommentPosted,
  type CommentThreads,
  type NameCheck,
} from '@breader/shared';
import type { AppEnv, Deps } from '../context.ts';
import { commenters, comments } from '../db/schema.ts';
import { ApiError, parse, pgCode, readJson } from '../lib/errors.ts';
import { rateLimit } from '../lib/http.ts';
import { requireLibrary } from '../lib/library.ts';

/*
 * Comments on a book (shared comments.ts): its whole-book thread and one per chapter, for everyone
 * on that book. A thread is the shared book's id, so a library may read and write it while it has
 * that book (its own, or a copy started from it) or the book is on the Shared Library. Holding a
 * chapter back until the reader gets there is the app's to do: the server doesn't know chapters.
 * Comments are kept as written; the app censors them when it shows them.
 */

const taken = () => new ApiError(409, 'name_taken', 'Someone already has that name. Pick another.');
const notHere = () => new ApiError(404, 'not_found', 'There are no comments for this book here.');

export function commentRoutes(deps: Deps) {
  const { db } = deps;
  const r = new Hono<AppEnv>();
  r.use('/comments/*', requireLibrary(deps));
  r.use('/commenter/*', requireLibrary(deps));

  /** The thread's book id, if this library may see its comments. */
  async function thread(libraryId: string, raw: string) {
    const book = Id.safeParse(raw);
    if (!book.success) throw notHere();
    const { rows: [row] } = await db.execute<{ ok: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1 FROM library_items
         WHERE library_id = ${libraryId} AND removed_at IS NULL AND (book_id = ${book.data} OR origin = ${book.data})
      ) OR EXISTS (
        SELECT 1 FROM library_items s JOIN libraries l ON l.id = s.library_id
         WHERE s.book_id = ${book.data} AND s.shared AND s.removed_at IS NULL AND l.retired_at IS NULL
      ) AS ok`);
    if (!row?.ok) throw notHere();
    return book.data;
  }

  const nameOf = async (libraryId: string) =>
    (await db.select({ name: commenters.name }).from(commenters).where(eq(commenters.libraryId, libraryId)))[0]?.name ?? null;

  const shown = (row: { id: string; section: number; name: string; body: string; progress: number; at: Date; library_id: string }, me: string): BookComment => ({
    id: row.id,
    section: row.section,
    name: row.name,
    body: row.body,
    progress: row.progress,
    at: new Date(row.at).getTime(),
    mine: row.library_id === me,
  });

  /** Whether a name can be had, as the reader types it. */
  r.get('/commenter/check', rateLimit({ name: 'comment-name', max: 120, windowMs: 60_000 }), async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const name = CommentName.safeParse(c.req.query('name') ?? '');
    if (!name.success) return c.json({ free: false, message: name.error.issues[0]?.message } satisfies NameCheck);
    const [holder] = await db.select({ libraryId: commenters.libraryId }).from(commenters).where(eq(commenters.fold, foldName(name.data)));
    const free = !holder || holder.libraryId === c.var.library.id;
    return c.json((free ? { free } : { free, message: 'Someone already has that name.' }) satisfies NameCheck);
  });

  /** The book's threads: how many comments each has and its newest, and this reader's name. */
  r.get('/comments/:book', rateLimit({ name: 'comments', max: 240, windowMs: 60_000 }), async (c) => {
    const me = c.var.library.id;
    const book = await thread(me, c.req.param('book'));
    const { rows } = await db.execute<{ section: number; count: number; last: CommentThreads['threads'][number]['last'] & { at: string } }>(sql`
      SELECT section, count(*)::int AS count,
             (array_agg(json_build_object('name', coalesce(m.name, 'A reader'), 'body', left(c.body, 240), 'progress', c.progress, 'at', c.created_at)
                        ORDER BY c.created_at DESC))[1] AS last
        FROM comments c LEFT JOIN commenters m ON m.library_id = c.library_id
       WHERE c.book = ${book}
       GROUP BY section`);
    c.header('Cache-Control', 'private, no-store');
    return c.json({
      name: await nameOf(me),
      threads: rows.map((t) => ({ section: t.section, count: t.count, last: { ...t.last, at: new Date(t.last.at).getTime() } })),
    } satisfies CommentThreads);
  });

  /** One thread, oldest first. */
  r.get('/comments/:book/:section', rateLimit({ name: 'comments', max: 240, windowMs: 60_000 }), async (c) => {
    const me = c.var.library.id;
    const book = await thread(me, c.req.param('book'));
    const section = Number(c.req.param('section'));
    if (!Number.isInteger(section) || section < BOOK_THREAD) throw notHere();
    const { rows } = await db.execute<Parameters<typeof shown>[0]>(sql`
      SELECT * FROM (
        SELECT c.id, c.section, coalesce(m.name, 'A reader') AS name, c.body, c.progress, c.created_at AS at, c.library_id
          FROM comments c LEFT JOIN commenters m ON m.library_id = c.library_id
         WHERE c.book = ${book} AND c.section = ${section}
         ORDER BY c.created_at DESC
         LIMIT ${THREAD_LIMIT}
      ) newest ORDER BY at`);
    c.header('Cache-Control', 'private, no-store');
    return c.json({ comments: rows.map((row) => shown(row, me)) } satisfies CommentList);
  });

  /** Says something. The first time, with the name the reader will go by from then on. */
  r.post('/comments/:book', rateLimit({ name: 'comment-post', max: 20, windowMs: 60_000 }), async (c) => {
    const me = c.var.library.id;
    const book = await thread(me, c.req.param('book'));
    const body = parse(PostComment, await readJson(c));
    let name = await nameOf(me);
    if (!name) {
      if (!body.name) throw new ApiError(400, 'name_needed', 'Pick a name to comment under first.');
      try {
        await db.insert(commenters).values({ libraryId: me, name: body.name, fold: foldName(body.name) });
        name = body.name;
      } catch (e) {
        // Taken, or this library named itself a moment ago in another tab.
        if (pgCode(e) !== '23505') throw e;
        name = await nameOf(me);
        if (!name) throw taken();
      }
    }
    const [row] = await db
      .insert(comments)
      .values({ id: randomUUID(), book, section: body.section, libraryId: me, body: body.body, progress: body.progress })
      .returning();
    return c.json(
      { comment: shown({ ...row, name, at: row.createdAt, library_id: me }, me), name } satisfies CommentPosted,
      201,
    );
  });

  /** Takes back one of this reader's own comments. */
  r.delete('/comments/:book/c/:id', rateLimit({ name: 'comment-post', max: 20, windowMs: 60_000 }), async (c) => {
    const me = c.var.library.id;
    const book = await thread(me, c.req.param('book'));
    const gone = await db
      .delete(comments)
      .where(and(eq(comments.id, c.req.param('id')), eq(comments.book, book), eq(comments.libraryId, me)))
      .returning({ id: comments.id });
    if (!gone.length) throw new ApiError(404, 'not_found', 'That comment is already gone.');
    return c.body(null, 204);
  });

  return r;
}
