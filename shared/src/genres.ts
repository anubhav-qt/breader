import { z } from 'zod';

/*
 * The genres a book can be filed under, as many as fit it. Whoever adds a book picks them (or
 * none); readers of a shared copy start from theirs and can pick their own. Stored by id, joined by
 * commas ("fantasy,romance"), so a name can change and the list can grow: the wire takes any
 * well-formed id, and an id the app doesn't know is left out.
 *
 * One genre each, no pairs: stories first, then who they're for and their form, then fact.
 */
export const GENRES = [
  { id: 'fantasy', name: 'Fantasy' },
  { id: 'scifi', name: 'Science fiction' },
  { id: 'mystery', name: 'Mystery' },
  { id: 'crime', name: 'Crime' },
  { id: 'thriller', name: 'Thriller' },
  { id: 'horror', name: 'Horror' },
  { id: 'romance', name: 'Romance' },
  { id: 'historical', name: 'Historical fiction' },
  { id: 'literary', name: 'Literary fiction' },
  { id: 'adventure', name: 'Adventure' },
  { id: 'humour', name: 'Humour' },
  { id: 'classics', name: 'Classics' },
  { id: 'young', name: 'Young adult' },
  { id: 'children', name: 'Children’s' },
  { id: 'lightnovel', name: 'Light novel' },
  { id: 'poetry', name: 'Poetry' },
  { id: 'biography', name: 'Biography' },
  { id: 'history', name: 'History' },
  { id: 'science', name: 'Science' },
  { id: 'philosophy', name: 'Philosophy' },
] as const;

export type GenreId = (typeof GENRES)[number]['id'];

/** What a book with no genre is filed under. */
export const UNSET_GENRE = 'Unset';

/**
 * A book's genres on the wire: ids of lowercase letters joined by commas, so ids added later still
 * pass older servers.
 */
export const GenreList = z.string().regex(/^[a-z]{1,24}(,[a-z]{1,24}){0,19}$/, 'Not a genre');

const byId = new Map<string, string>(GENRES.map((g) => [g.id, g.name]));
const order = new Map<string, number>(GENRES.map((g, i) => [g.id, i]));

/**
 * The first list paired genres up; those picked then go on under the one that keeps their meaning
 * ("Mystery & crime" was `mystery` and stays Mystery). The rest of them have no genre here now.
 */
const RENAMED: Record<string, GenreId> = { ideas: 'philosophy', comics: 'lightnovel' };

/** A genre's name, or undefined for one this build doesn't know. */
export const genreName = (id: string | null | undefined): string | undefined => (id ? byId.get(id) : undefined);

/** The genres in a stored list that this build knows, each once, in the list's order above. */
export function genreIds(list: string | null | undefined): GenreId[] {
  if (!list) return [];
  const ids = new Set<GenreId>();
  for (const raw of list.split(',')) {
    const id = RENAMED[raw] ?? raw;
    if (byId.has(id)) ids.add(id as GenreId);
  }
  return [...ids].sort((a, b) => order.get(a)! - order.get(b)!);
}

/** Genres as they're stored: '' for none. */
export const joinGenres = (ids: Iterable<string>): string => genreIds([...ids].join(',')).join(',');

/** A book's genres by name, "Fantasy, Romance", or undefined for none. */
export const genreNames = (list: string | null | undefined): string | undefined =>
  genreIds(list).map((id) => byId.get(id)).join(', ') || undefined;
