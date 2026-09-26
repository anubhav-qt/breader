import { colorKeyFor } from '../data/colors';
import { newId } from '../lib/key';
import type { BookRecord, Format, LoadedBook, Section } from './types';

/** The first real sentence in a run of sections, skipping covers and image-only pages. */
export function firstSentence(sections: Section[], from = 0): string {
  for (let i = from; i < sections.length; i++) {
    if (sections[i].words < 3) continue;
    const doc = new DOMParser().parseFromString(sections[i].html, 'text/html');
    doc.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach((h) => h.remove());
    const text = (doc.body.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    return (text.match(/^.{1,240}?[.!?…](?=\s|$)/)?.[0] ?? text.slice(0, 200)).trim();
  }
  return '';
}

/** A new library record for a book someone has just added. */
export function recordFromBook(book: LoadedBook, format: Format, shared: boolean): BookRecord {
  const now = Date.now();
  return {
    id: newId(),
    title: book.title,
    author: book.author,
    format,
    source: 'file',
    shared,
    addedAt: now,
    words: book.words,
    color: colorKeyFor(book.title),
    hasCover: book.kind === 'flow' && !!book.cover,
    progress: 0,
    line: book.kind === 'flow' ? firstSentence(book.sections) : `Page 1 of ${book.pages}`,
    lastOpened: now,
  };
}
