import { describe, expect, it } from 'vitest';
import type { FeedLibrary, ShelfBook } from '@breader/shared/protocol';
import { agoLine, countLine, factsLine, feedName, feedOrder } from './facts';

const HOUR = 3_600_000;
const now = Date.UTC(2026, 10, 26, 12);

const lib = (token: string, patch: Partial<FeedLibrary> = {}): FeedLibrary => ({
  token,
  name: token,
  tag: `${token}0000`,
  books: 0,
  manga: 0,
  saves: 0,
  updatedAt: now,
  own: false,
  ...patch,
});

describe('countLine', () => {
  it('says one book, many books and manga, and leaves out what is none', () => {
    expect(countLine(1, 0)).toBe('1 book');
    expect(countLine(2, 18)).toBe('2 books · 18 manga');
    expect(countLine(0, 1)).toBe('1 manga');
    expect(countLine(0, 0)).toBe('');
  });
});

describe('agoLine', () => {
  it('counts hours under a day, then days', () => {
    expect(agoLine(now - 10 * 60_000, now)).toBe('just now');
    expect(agoLine(now - 3 * HOUR, now)).toBe('3h ago');
    expect(agoLine(now - 23 * HOUR, now)).toBe('23h ago');
    expect(agoLine(now - 24 * HOUR, now)).toBe('1 day ago');
    expect(agoLine(now - 8 * 24 * HOUR, now)).toBe('8 days ago');
  });

  it('says just now for a clock a little ahead', () => {
    expect(agoLine(now + HOUR, now)).toBe('just now');
  });
});

describe('factsLine', () => {
  it('shows saves for someone else’s library only', () => {
    const l = lib('a', { books: 2, manga: 18, saves: 41, updatedAt: now - 3 * HOUR });
    expect(factsLine(l, false, now)).toBe('2 books · 18 manga · saved 41 · 3h ago');
    expect(factsLine(l, true, now)).toBe('2 books · 18 manga · 3h ago');
  });
});

describe('feedOrder', () => {
  const book = (title: string) => ({ title }) as ShelfBook;
  const books: Record<string, ShelfBook[]> = { a: [book('Dune')], b: [book('Berserk')], c: [] };
  const booksOf = (token: string) => books[token] ?? [];
  const libs = [
    lib('a', { name: 'Sci-fi club', saves: 2, updatedAt: now - HOUR }),
    lib('b', { name: 'Manga night', saves: 9, updatedAt: now - 5 * HOUR }),
    lib('c', { name: null, saves: 2, updatedAt: now }),
  ];

  it('puts the most saved first, the newest first among equals', () => {
    expect(feedOrder(libs, booksOf, '', 'popular').map((l) => l.token)).toEqual(['b', 'c', 'a']);
  });

  it('puts the newest first', () => {
    expect(feedOrder(libs, booksOf, '', 'new').map((l) => l.token)).toEqual(['c', 'a', 'b']);
  });

  it('finds by name or by a title, any case, and leaves the list as it was', () => {
    expect(feedOrder(libs, booksOf, '  NIGHT ', 'popular').map((l) => l.token)).toEqual(['b']);
    expect(feedOrder(libs, booksOf, 'dune', 'popular').map((l) => l.token)).toEqual(['a']);
    expect(feedOrder(libs, booksOf, 'nothing', 'popular')).toEqual([]);
    expect(libs.map((l) => l.token)).toEqual(['a', 'b', 'c']);
  });

  it('finds one with no name by its short id or as a shared library', () => {
    expect(feedOrder(libs, booksOf, 'c0000', 'popular').map((l) => l.token)).toEqual(['c']);
    expect(feedOrder(libs, booksOf, 'shared library', 'popular').map((l) => l.token)).toEqual(['c']);
  });
});

describe('feedName', () => {
  it('is the name its owner gave it', () => {
    expect(feedName(lib('a', { name: 'Sci-fi club' }))).toBe('Sci-fi club');
  });

  it('is its short id’s shared library when it has no name', () => {
    expect(feedName(lib('a', { name: null, tag: '3fa94c' }))).toBe('3fa94c’s shared library');
  });
});
