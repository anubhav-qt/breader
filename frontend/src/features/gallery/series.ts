import type { ShelfItem } from '../../data/useLibrary';

/*
 * Series in the library. Three designs are on trial behind the preview bar's switch:
 * stack  – a series is one card, the book to read now on top and the others peeking out behind;
 *          it opens to the whole series.
 * spines – a series is one card of spines side by side, each filling with its book's colour as
 *          it's read; the book to read now is the open one. Any spine opens its book.
 * rows   – books keep their own cards; below Recent, each series gets a row of them in order.
 */
export type SeriesLook = 'stack' | 'spines' | 'rows';
export const SERIES_LOOKS: SeriesLook[] = ['stack', 'spines', 'rows'];

export interface Series {
  key: string;
  name: string;
  /** In reading order. */
  books: ShelfItem[];
  /** The one to read now: the latest, or the next one on when that's finished. */
  lead: ShelfItem;
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
    const latest = newest[0];
    const lead = latest.progress >= 1 ? ordered.slice(ordered.indexOf(latest) + 1).find((b) => b.progress < 1) ?? latest : latest;
    const s: Series = { key: `series:${name}`, name: ordered[0].series!.trim(), books: ordered, lead };
    for (const b of newest) out.set(b.id, s);
  }
  return out;
}

/** "Book 2", or the book's place in the list when it has no number. */
export const numberOf = (s: Series, b: ShelfItem) => b.seriesIndex ?? s.books.indexOf(b) + 1;

export const finishedIn = (s: Series) => s.books.filter((b) => b.progress >= 1).length;
