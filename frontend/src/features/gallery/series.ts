import type { ShelfItem } from '../../data/useLibrary';

/*
 * Series in the library. Books keep their own cards in Recent; below it, each series gets a row of
 * its books in order.
 */
export interface Series {
  key: string;
  name: string;
  /** In reading order. */
  books: ShelfItem[];
}

const inOrder = (a: ShelfItem, b: ShelfItem) =>
  (a.seriesIndex ?? Infinity) - (b.seriesIndex ?? Infinity) || a.addedAt - b.addedAt || a.title.localeCompare(b.title);

/** The series with at least two books in `books` (newest first), by book id. */
export function findSeries(books: ShelfItem[]): Map<string, Series> {
  const groups = new Map<string, ShelfItem[]>();
  for (const b of books) {
    const name = b.series?.trim().toLowerCase();
    if (name) groups.set(name, [...(groups.get(name) ?? []), b]);
  }
  const out = new Map<string, Series>();
  for (const [name, newest] of groups) {
    if (newest.length < 2) continue;
    const ordered = [...newest].sort(inOrder);
    const s: Series = { key: `series:${name}`, name: ordered[0].series!.trim(), books: ordered };
    for (const b of newest) out.set(b.id, s);
  }
  return out;
}

/** "Book 2", or the book's place in the list when it has no number. */
export const numberOf = (s: Series, b: ShelfItem) => b.seriesIndex ?? s.books.indexOf(b) + 1;

export const finishedIn = (s: Series) => s.books.filter((b) => b.progress >= 1).length;
