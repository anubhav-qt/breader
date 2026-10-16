import { BOOK_KINDS, type BookCard, type BookKind, type BookSort, type BookSubject } from '@breader/shared';

/*
 * What a reader searches books for (routes/books.ts), and what each place makes of a subject: a
 * novel site files its novels under genres, Project Gutenberg under topics, Open Library under
 * subjects. A subject a novel site has no genre for (Self-help) asks only the books' places.
 */

export interface BookWanted {
  q?: string;
  /** Two letters (en), as LNReader and Gutendex have languages. */
  lang: string;
  sort?: BookSort;
  /** At least one. */
  kinds: BookKind[];
  subject?: BookSubject;
  /** Only books going by one of these names (seriesName keys): a book's sheet looking for its other copies. */
  names?: string[];
}

interface SubjectIn {
  /** Gutendex's topic, matched in its subjects and bookshelves. */
  gutenberg: string;
  /** Open Library's subject. */
  openlibrary: string;
  /** A novel's genres, any of which files it here (lower case, matched within). None: novels aren't. */
  genres: string[];
}

const SUBJECTS: Record<BookSubject, SubjectIn> = {
  fantasy: { gutenberg: 'fantasy', openlibrary: 'fantasy', genres: ['fantasy', 'xianxia', 'xuanhuan', 'wuxia', 'magic'] },
  romance: { gutenberg: 'love stories', openlibrary: 'romance', genres: ['romance'] },
  scifi: { gutenberg: 'science fiction', openlibrary: 'science fiction', genres: ['sci-fi', 'science fiction', 'scifi', 'mecha'] },
  mystery: { gutenberg: 'detective and mystery', openlibrary: 'mystery', genres: ['mystery', 'detective'] },
  horror: { gutenberg: 'horror', openlibrary: 'horror', genres: ['horror'] },
  adventure: { gutenberg: 'adventure', openlibrary: 'adventure', genres: ['adventure'] },
  drama: { gutenberg: 'drama', openlibrary: 'drama', genres: ['drama', 'tragedy'] },
  humour: { gutenberg: 'humor', openlibrary: 'humor', genres: ['comedy', 'humor', 'humour'] },
  selfhelp: { gutenberg: 'conduct of life', openlibrary: 'self-help', genres: [] },
  philosophy: { gutenberg: 'philosophy', openlibrary: 'philosophy', genres: ['philosophical'] },
  psychology: { gutenberg: 'psychology', openlibrary: 'psychology', genres: ['psychological'] },
  history: { gutenberg: 'history', openlibrary: 'history', genres: ['historical'] },
  biography: { gutenberg: 'biography', openlibrary: 'biography', genres: [] },
  science: { gutenberg: 'science', openlibrary: 'science', genres: [] },
  economics: { gutenberg: 'economics', openlibrary: 'economics', genres: [] },
  religion: { gutenberg: 'religion', openlibrary: 'religion', genres: [] },
  travel: { gutenberg: 'travel', openlibrary: 'travel', genres: [] },
  poetry: { gutenberg: 'poetry', openlibrary: 'poetry', genres: [] },
  children: { gutenberg: 'children', openlibrary: 'juvenile fiction', genres: [] },
};

export function subjectIn(subject: BookSubject): SubjectIn {
  return SUBJECTS[subject];
}

/** A book of this kind is one a search wants. One of no known kind is wanted only with every kind. */
export function wantedKind(kind: BookKind | null, w: BookWanted): boolean {
  if (kind === null) return w.kinds.length === BOOK_KINDS.length;
  return w.kinds.includes(kind);
}

/** Novels are asked for: a light or web novel's kind, and a subject novels are filed under, if any. */
export function novelsWanted(w: BookWanted): boolean {
  if (!w.kinds.includes('light') && !w.kinds.includes('web')) return false;
  if (w.subject && SUBJECTS[w.subject].genres.length === 0) return false;
  return true;
}

/** A novel with these genres is about the subject asked, or none was. */
export function novelAbout(genres: string[], w: BookWanted): boolean {
  if (!w.subject) return true;
  const words = SUBJECTS[w.subject].genres;
  for (const g of genres) {
    const lower = g.toLowerCase();
    for (const word of words) {
      if (lower.includes(word)) return true;
    }
  }
  return false;
}

/** A novel a search wants, by its card and genres. */
export function wantsNovel(card: BookCard, genres: string[], w: BookWanted): boolean {
  if (!wantedKind(card.kind, w)) return false;
  return novelAbout(genres, w);
}

/** The status a site gives, as a card says it. */
export function statusOf(said: string): BookCard['status'] {
  const s = said.toLowerCase();
  if (/hiatus|paused/.test(s)) return 'hiatus';
  if (/cancel|dropped|abandon|discontinu/.test(s)) return 'cancelled';
  if (/complet|finished|\bended\b/.test(s)) return 'completed';
  if (/ongoing|on going|publishing|releasing/.test(s)) return 'ongoing';
  return null;
}
