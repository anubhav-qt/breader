import { newId } from '../lib/key';
import type { BookRecord, Format, LoadedBook, Section } from './types';

/** Pages before the story starts, by their whole name in the contents. */
const FRONT = /^(table of contents|contents|copyrights?( and credits| page)?|credits|title( page)?|characters?( gallery| list)?|(colou?r )?gallery|cover|dedication|acknowledge?ments?|about the (author|publisher|translator)s?|newsletter.*|also by.*|praise for.*|imprint|colophon|inserts?|front matter)$/i;
/** Paragraphs that are small print, not the book's own words. */
const SMALL_PRINT = /©|\bcopyright\b|all rights reserved|\bisbn\b|translated by|published by|https?:\/\/|www\./i;

const flat = (el: Element) => (el.textContent ?? '').replace(/\s+/g, ' ').trim();
const sentence = (text: string) => (text.match(/^.{1,240}?[.!?…](?=["”’)]*(\s|$))["”’)]*/)?.[0] ?? text.slice(0, 200)).trim();

/**
 * The first real sentence in a run of sections: skips covers, contents, credits and other front
 * matter, and pages that are mostly links, then takes the first paragraph of prose.
 */
export function firstSentence(sections: Section[], from = 0): string {
  const docs: Document[] = [];
  for (let i = from; i < sections.length && docs.length < 30; i++) {
    const s = sections[i];
    if (s.words < 3 || FRONT.test(s.title.trim())) continue;
    const doc = new DOMParser().parseFromString(s.html, 'text/html');
    const text = flat(doc.body);
    const linked = Array.from(doc.querySelectorAll('a')).reduce((n, a) => n + flat(a).length, 0);
    if (!text || linked > text.length / 2) continue;
    doc.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach((h) => h.remove());
    for (const p of Array.from(doc.querySelectorAll('p'))) {
      const line = flat(p);
      if (line.split(' ').length >= 6 && !SMALL_PRINT.test(line)) return sentence(line);
    }
    docs.push(doc);
  }
  // No paragraphs (some files set text in plain divs): the first text that reads like a sentence.
  for (const doc of docs) {
    const text = flat(doc.body);
    if (/[.!?…]/.test(text) && !SMALL_PRINT.test(text.slice(0, 240))) return sentence(text);
  }
  return '';
}

/** A new library record for a book someone has just added, in a colour from the library's pool. */
export function recordFromBook(book: LoadedBook, format: Format, shared: boolean, color: string): BookRecord {
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
    color,
    hasCover: false,
    progress: 0,
    line: book.kind === 'flow' ? firstSentence(book.sections) : `Page 1 of ${book.pages}`,
    lastOpened: now,
    ...(book.kind === 'flow' && book.series ? { series: book.series.name, seriesIndex: book.series.index } : {}),
  };
}
