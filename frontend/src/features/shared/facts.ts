import type { FeedLibrary, ShelfBook } from '@breader/shared/protocol';

/** How the feed is ordered: most saved first, or newest first. */
export type FeedSort = 'popular' | 'new';

const HOUR = 3_600_000;

/** "2 books · 18 manga", leaving out what it has none of. */
export function countLine(books: number, manga: number): string {
  const parts: string[] = [];
  if (books === 1) parts.push('1 book');
  if (books > 1) parts.push(`${books} books`);
  if (manga > 0) parts.push(`${manga} manga`);
  return parts.join(' · ');
}

/** Hours under a day, then days: "just now", "3h ago", "1 day ago", "8 days ago". */
export function agoLine(at: number, now: number): string {
  const hours = Math.floor(Math.max(0, now - at) / HOUR);
  if (hours < 1) return 'just now';
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return '1 day ago';
  return `${days} days ago`;
}

/** A public library's name in the feed: its own, or its short id's for one with none. */
export function feedName(l: FeedLibrary): string {
  if (l.name) return l.name;
  return `${l.tag}’s shared library`;
}

/** The line under a library's name: what it holds, how often it's saved (not for the reader's own), when it last changed. */
export function factsLine(l: FeedLibrary, yours: boolean, now: number): string {
  const parts: string[] = [];
  const counts = countLine(l.books, l.manga);
  if (counts) parts.push(counts);
  if (!yours) parts.push(`saved ${l.saves}`);
  parts.push(agoLine(l.updatedAt, now));
  return parts.join(' · ');
}

/** The feed's libraries whose name, or a book's title, has the search in it, in the order picked. */
export function feedOrder(
  libraries: FeedLibrary[],
  booksOf: (token: string) => ShelfBook[],
  search: string,
  sort: FeedSort,
): FeedLibrary[] {
  const q = search.trim().toLowerCase();
  const shown = libraries.filter((l) => {
    if (!q) return true;
    if (feedName(l).toLowerCase().includes(q)) return true;
    return booksOf(l.token).some((b) => b.title.toLowerCase().includes(q));
  });
  if (sort === 'new') {
    shown.sort((a, b) => b.updatedAt - a.updatedAt);
  } else {
    shown.sort((a, b) => {
      if (a.saves !== b.saves) return b.saves - a.saves;
      return b.updatedAt - a.updatedAt;
    });
  }
  return shown;
}
