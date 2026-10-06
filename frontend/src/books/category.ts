import type { Format } from './types';

/** The library's two shelves: books, and manga (comics too), each with its own My and shared tabs. */
export type Category = 'books' | 'manga';

export const CATEGORIES: Category[] = ['books', 'manga'];

export const categoryOf = (r: { format: Format }): Category => (r.format === 'CBZ' ? 'manga' : 'books');

/** "3 books", "1 manga": manga is its own plural. */
export const countOf = (n: number, category: Category) => `${n} ${category === 'manga' ? 'manga' : n === 1 ? 'book' : 'books'}`;
