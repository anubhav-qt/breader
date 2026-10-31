import { PLACE_PER, placeKey } from '@breader/shared/manga';
import type { LoadedBook, Position } from '../../books/types';
import { chapterAt, type Chapter } from './chapters';

/*
 * Reading on into the next chapter while the mark is well ahead: the reader is asked whether to
 * keep reading from here or go back to where they had read up to. Chapters are told apart by
 * their order: in the whole list for a series from a catalogue, else among the chapters open.
 */

/** How the reader's visit to a book stands: the chapter they were last in, and whether they've been asked since they jumped. */
export interface Visit {
  chapter: number | null;
  asked: boolean;
}

/** What a book leaves behind when its reader unmounts, for a series reopened at the next chapter. */
const left = new Map<string, Visit>();

/** Keeps the visit for the reader that mounts next on this book, or forgets it when the book was closed. */
export function leave(id: string, visit: Visit | null) {
  if (visit) left.set(id, visit);
  else left.delete(id);
}

/** The visit the book left, or a new one. */
export const resume = (id: string): Visit => ({ ...(left.get(id) ?? { chapter: null, asked: false }) });

/** The short names of a book's chapters, in order: all of a series from a catalogue, else those open. */
export function chapterTitles(book: LoadedBook, chapters: Chapter[]): Array<Pick<Chapter, 'title'>> {
  if (book.kind !== 'manga' || !book.remote) return chapters;
  return book.remote.chapters.map((c) => ({ title: c.label }));
}

/** The order of the chapter the reader is in, or null when it can't be told. */
export function readingOrder(book: LoadedBook, chapters: Chapter[], page: number): number | null {
  if (book.kind !== 'manga' || !book.remote) return chapterAt(chapters, { section: page });
  const id = book.where?.(page).chapter;
  const i = book.remote.chapters.findIndex((c) => c.id === id);
  return i < 0 ? null : i;
}

/** The order of the chapter the mark is in, or null when its place names none. */
export function markOrder(book: LoadedBook, chapters: Chapter[], pos: Position): number | null {
  if (book.kind !== 'manga' || !book.remote) return chapterAt(chapters, pos);
  if (pos.block < PLACE_PER) return null;
  const key = Math.floor(pos.block / PLACE_PER) - 1;
  const all = book.remote.chapters;
  const same = all.findIndex((c) => c.number !== null && placeKey(c.number) === key);
  if (same >= 0) return same;
  // That chapter's gone from the series: the next one after it stands in.
  const after = all.findIndex((c) => c.number !== null && placeKey(c.number) > key);
  return after < 0 ? null : after;
}

/** Whether the chapter has to be opened again to be read: a series opened a few chapters at a time has others away. */
export const isAway = (book: LoadedBook, order: number) => book.kind === 'manga' && !!book.remote?.chapters[order]?.away;

/** Reading on from `from` into the next chapter, with the mark more than one chapter beyond `from`. */
export function behindMark(from: number | null, to: number | null, mark: number | null): boolean {
  if (from === null || to === null || mark === null) return false;
  return to === from + 1 && from < mark - 1;
}
