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

/* Suggestions for the series field in the edit popover. */

export interface SeriesName {
  name: string;
  /** Books in it, across the library and the Shared Library. */
  count: number;
}

/**
 * Every series any book is in, however few books: the reader's, the Shared Library's, and those an
 * EPUB named itself. Spelled as most of its books spell it.
 */
export function seriesNames(books: ShelfItem[]): SeriesName[] {
  const seen = new Set<string>();
  const spellings = new Map<string, Map<string, number>>();
  for (const b of books) {
    const name = b.series?.trim();
    const id = b.origin ?? b.id;
    if (!name || seen.has(id)) continue;
    seen.add(id);
    const key = name.toLowerCase();
    const s = spellings.get(key) ?? new Map<string, number>();
    s.set(name, (s.get(name) ?? 0) + 1);
    spellings.set(key, s);
  }
  return [...spellings.values()].map((s) => {
    const [name] = [...s].sort((a, b) => b[1] - a[1])[0];
    return { name, count: [...s.values()].reduce((a, b) => a + b, 0) };
  });
}

/** Lowercase, with accents set aside, so "Emile" finds "Émile". */
const plain = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/**
 * The series that match what's typed: names that start with it first, then those with a word that
 * does, then any that hold it; bigger series first within each.
 */
export function matchSeries(all: SeriesName[], typed: string, limit = 6): SeriesName[] {
  const q = plain(typed.trim());
  if (!q) return [];
  const rank = (n: string) => {
    const p = plain(n);
    // Already typed as it is: only worth offering when it's spelled differently.
    if (p === q) return n === typed.trim() ? -1 : 0;
    if (p.startsWith(q)) return 0;
    if (p.split(/[\s\-\u2013:,.'\u2019()]+/).some((w) => w.startsWith(q))) return 1;
    return p.includes(q) ? 2 : -1;
  };
  return all
    .map((s) => ({ s, r: rank(s.name) }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r || b.s.count - a.s.count || a.s.name.localeCompare(b.s.name))
    .slice(0, limit)
    .map((x) => x.s);
}

