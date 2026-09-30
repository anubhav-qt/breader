import { z } from 'zod';

/*
 * The genres a book can be filed under. Whoever adds a book picks one (or leaves it unset); readers
 * of a shared copy start from theirs and can pick their own. Stored by id, so a name can change and
 * the list can grow: the wire takes any well-formed id, and an id the app doesn't know reads as
 * unset.
 */
export const GENRES = [
  { id: 'literary', name: 'Literary fiction' },
  { id: 'classics', name: 'Classics' },
  { id: 'fantasy', name: 'Fantasy' },
  { id: 'scifi', name: 'Science fiction' },
  { id: 'mystery', name: 'Mystery & crime' },
  { id: 'thriller', name: 'Thriller' },
  { id: 'romance', name: 'Romance' },
  { id: 'horror', name: 'Horror' },
  { id: 'historical', name: 'Historical fiction' },
  { id: 'adventure', name: 'Adventure' },
  { id: 'humour', name: 'Humour' },
  { id: 'young', name: 'Young adult' },
  { id: 'children', name: 'Children’s' },
  { id: 'short', name: 'Short stories' },
  { id: 'poetry', name: 'Poetry & plays' },
  { id: 'comics', name: 'Comics & manga' },
  { id: 'biography', name: 'Biography & memoir' },
  { id: 'history', name: 'History' },
  { id: 'science', name: 'Science & nature' },
  { id: 'ideas', name: 'Philosophy & religion' },
  { id: 'society', name: 'Politics & society' },
  { id: 'self', name: 'Self-help' },
  { id: 'business', name: 'Business & money' },
  { id: 'tech', name: 'Technology' },
  { id: 'arts', name: 'Arts & culture' },
  { id: 'travel', name: 'Travel' },
  { id: 'food', name: 'Food & drink' },
  { id: 'study', name: 'Reference & study' },
] as const;

export type GenreId = (typeof GENRES)[number]['id'];

/** What a book with no genre is filed under. */
export const UNSET_GENRE = 'Unset';

/** A genre's id on the wire: lowercase letters, so ids added later still pass older servers. */
export const GenreKey = z.string().regex(/^[a-z]{1,24}$/, 'Not a genre');

const byId = new Map<string, string>(GENRES.map((g) => [g.id, g.name]));

/** A genre's name, or undefined for none or one this build doesn't know. */
export const genreName = (id: string | null | undefined): string | undefined => (id ? byId.get(id) : undefined);
