import { useEffect, useSyncExternalStore } from 'react';
import {
  BOOK_THREAD,
  type BookComment,
  type CommentList,
  type CommentPosted,
  type CommentThreads,
  type NameCheck,
} from '@breader/shared/comments';
import { hasKey } from '../../data/sync';
import { api, ApiError } from '../../lib/api';
import { screenWords } from '../../books/mark';
import type { BookRecord, ReadMark } from '../../books/types';
import type { Chapter } from './chapters';
import type { Loc } from './FlowView';

/*
 * Comments on the open book (server/src/routes/comments.ts): the whole book's thread and one at
 * the end of each chapter, read by everyone on that book. A copy of a shared book talks in the
 * shared book's threads, so it goes by its origin. Counts come when the book opens and every
 * couple of minutes after; a thread's comments when it's opened.
 *
 * A chapter's thread waits until the reader has got to the end of the chapter (`opens`), so
 * nobody reads what happens before they do. The whole book's is open from the start, with what
 * was written further on than the reader is folded away (chrome/Comments.tsx).
 */

export { BOOK_THREAD };
export type { BookComment };

export interface Talk {
  /** `off`: no library here, or the book isn't one the server knows. */
  state: 'loading' | 'ready' | 'off';
  why?: string;
  name: string | null;
  threads: Map<number, CommentThreads['threads'][number]>;
  /** Threads opened: their comments, oldest first, or an error to show. */
  lists: Map<number, BookComment[] | { error: string }>;
}

const EMPTY: Talk = { state: 'loading', name: null, threads: new Map(), lists: new Map() };
const REFRESH = 120_000;

const talks = new Map<string, Talk>();
const subs = new Set<() => void>();
const set = (thread: string, next: Talk) => {
  talks.set(thread, next);
  subs.forEach((f) => f());
};
const get = (thread: string) => talks.get(thread) ?? EMPTY;
const subscribe = (f: () => void) => {
  subs.add(f);
  return () => { subs.delete(f); };
};

const path = (thread: string, more = '') => `/v1/comments/${encodeURIComponent(thread)}${more}`;
const say = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong. Try again.');

/** The thread a book talks in: the shared book's, for a copy of one. */
export const threadOf = (rec: BookRecord) => rec.origin ?? rec.id;

export async function refreshTalk(thread: string) {
  if (!hasKey()) {
    set(thread, { ...EMPTY, state: 'off', why: 'Comments need a library. Make one, or sign in, from your books.' });
    return;
  }
  try {
    const t = await api.get<CommentThreads>(path(thread));
    const was = get(thread);
    set(thread, { ...was, state: 'ready', why: undefined, name: t.name, threads: new Map(t.threads.map((x) => [x.section, x])) });
  } catch (e) {
    const was = get(thread);
    // Offline: what was here stands.
    if (was.state === 'ready') return;
    const off = e instanceof ApiError && (e.status === 404 || e.status === 401);
    set(thread, { ...was, state: 'off', why: off ? 'Comments come with books in your library or someone’s shared library.' : say(e) });
  }
}

/** The open book's comments, kept fresh while it's open. */
export function useTalk(thread: string, on: boolean): Talk {
  useEffect(() => {
    if (!on) return;
    void refreshTalk(thread);
    const t = window.setInterval(() => { if (!document.hidden) void refreshTalk(thread); }, REFRESH);
    return () => window.clearInterval(t);
  }, [thread, on]);
  return useSyncExternalStore(subscribe, () => get(thread));
}

/** Fetches a thread's comments. */
export async function openThread(thread: string, section: number) {
  try {
    const { comments } = await api.get<CommentList>(path(thread, `/${section}`));
    const was = get(thread);
    set(thread, { ...was, lists: new Map(was.lists).set(section, comments) });
  } catch (e) {
    const was = get(thread);
    if (Array.isArray(was.lists.get(section))) return;
    set(thread, { ...was, lists: new Map(was.lists).set(section, { error: say(e) }) });
  }
}

/**
 * Says something in a thread, with the reader's name the first time. `parent` is the comment it
 * answers; the server files it under the one that comment answers, if any. Throws for the
 * composer to show.
 */
export async function postComment(thread: string, section: number, body: string, progress: number, name?: string, parent?: string) {
  const { comment, name: mine } = await api.post<CommentPosted>(path(thread), {
    section,
    body,
    progress: Math.max(0, Math.min(1, progress)),
    ...(name ? { name } : {}),
    ...(parent ? { parent } : {}),
  });
  const was = get(thread);
  const list = was.lists.get(section);
  const count = (was.threads.get(section)?.count ?? 0) + 1;
  set(thread, {
    ...was,
    name: mine,
    threads: new Map(was.threads).set(section, { section, count, last: comment }),
    lists: new Map(was.lists).set(section, [...(Array.isArray(list) ? list : []), comment]),
  });
  return comment;
}

/** Takes back one of the reader's own comments. */
export async function removeComment(thread: string, c: BookComment) {
  await api.del(path(thread, `/c/${encodeURIComponent(c.id)}`));
  const was = get(thread);
  const list = was.lists.get(c.section);
  const left = Array.isArray(list) ? list.filter((x) => x.id !== c.id) : [];
  const threads = new Map(was.threads);
  const t = threads.get(c.section);
  if (t && t.count > 1) threads.set(c.section, { ...t, count: t.count - 1, last: left[left.length - 1] ?? t.last });
  else threads.delete(c.section);
  set(thread, { ...was, threads, lists: new Map(was.lists).set(c.section, left) });
}

/** Whether a name can be had, as it's typed. */
export const checkName = (name: string) => api.get<NameCheck>(`/v1/commenter/check?name=${encodeURIComponent(name)}`);

/*
 * When a chapter's thread opens. The mark (books/mark.ts) is the first word on screen of the
 * furthest the reader has really read, so a chapter is read once the end of it is on that screen:
 * the last page, or the bottom of it scrolled into view. Or the whole book has been.
 */
export function opens(chapters: Chapter[], mark: ReadMark | undefined, loc: Loc | null) {
  const total = Math.max(1, chapters.reduce((n, c) => n + c.words, 0));
  if (!mark) return () => false;
  if ((mark.n ?? 0) >= 1 || mark.progress >= 1) return () => true;
  const reached = mark.progress * total + screenWords(loc?.screen ?? 0);
  return (i: number) => !!chapters[i] && chapters[i].end * total <= reached + 0.5;
}

/** How far the reader has read, for what they write, and for what's folded away from them. */
export const readTo = (mark: ReadMark | undefined, loc: Loc | null) => ((mark?.n ?? 0) >= 1 ? 1 : mark?.progress ?? loc?.progress ?? 0);

/** "3 h", "2 d", "Mar 4": how long ago. */
export function ago(at: number, now = Date.now()) {
  const m = Math.max(0, Math.round((now - at) / 60_000));
  if (m < 1) return 'now';
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d} d`;
  return new Date(at).toLocaleDateString([], { month: 'short', day: 'numeric', ...(d > 300 ? { year: 'numeric' } : {}) });
}
