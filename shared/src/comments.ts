import { z } from 'zod';
import { Id } from './protocol.ts';

/*
 * Comments on a book: one thread for the whole book and one at the end of each chapter, read by
 * everyone on that book. A book's threads go by the shared book's id (a copy's origin), so the
 * sharer and every reader who started a copy meet in the same place. A chapter's thread is the
 * section its chapter starts at; the whole book's is BOOK_THREAD.
 *
 * A comment can be answered: a reply goes under it, in the same thread. Replies are one deep, so
 * answering a reply answers the comment it's under.
 *
 * Each library comments under one name, which nobody else may have. Names are told apart by
 * foldName, so "Mira", "mira" and "M.ira" are one name.
 */

export const BOOK_THREAD = -1;

export const COMMENT_CHARS = 1000;
export const NAME_CHARS = { min: 2, max: 24 } as const;
/** The most comments one thread shows, the newest. */
export const THREAD_LIMIT = 500;

/** What tells two names apart: case, width, spaces, dots, dashes and underscores don't. */
export const foldName = (name: string) => name.normalize('NFKC').toLowerCase().replace(/[\s._-]+/g, '');

export const CommentName = z
  .string()
  .transform((s) => s.normalize('NFKC').trim().replace(/\s+/g, ' '))
  .pipe(
    z
      .string()
      .min(NAME_CHARS.min, `A name needs at least ${NAME_CHARS.min} characters.`)
      .max(NAME_CHARS.max, `A name has at most ${NAME_CHARS.max} characters.`)
      .regex(/^[\p{L}\p{N}][\p{L}\p{M}\p{N} ._-]*$/u, 'Letters, numbers, spaces, dots, dashes and underscores only, starting with a letter or number.')
      .refine((s) => foldName(s).length >= NAME_CHARS.min, `A name needs at least ${NAME_CHARS.min} letters or numbers.`),
  );

export const PostComment = z.strictObject({
  section: z.number().int().min(BOOK_THREAD).max(100_000),
  body: z.string().trim().min(1, 'Write something first.').max(COMMENT_CHARS, `A comment has at most ${COMMENT_CHARS} characters.`),
  /** How far the writer had read, 0 to 1, so the whole book's thread can hold back what's ahead of a reader. */
  progress: z.number().min(0).max(1),
  /** The writer's name, the first time they comment. */
  name: CommentName.optional(),
  /** The comment this answers, in the same thread. */
  parent: Id.optional(),
});
export type PostComment = z.input<typeof PostComment>;

export interface BookComment {
  id: string;
  section: number;
  name: string;
  body: string;
  progress: number;
  /** The comment this answers, or null for one that answers nothing. */
  parent: string | null;
  /** Written at, ms. */
  at: number;
  mine: boolean;
}

/** A book's threads at a glance: how many each has, and its newest. */
export interface CommentThreads {
  /** This library's name, null until it comments. */
  name: string | null;
  threads: Array<{ section: number; count: number; last: Pick<BookComment, 'name' | 'body' | 'progress' | 'at'> }>;
}

export interface CommentList {
  comments: BookComment[];
}

export interface CommentPosted {
  comment: BookComment;
  name: string;
}

/** Whether a name can be had: free, or already this library's. */
export interface NameCheck {
  free: boolean;
  /** Why not, when it can't. */
  message?: string;
}
