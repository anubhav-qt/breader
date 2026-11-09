import type { BookRecord } from '../../books/types';
import { loadRecord } from '../../books/load';
import { collectBlocks } from '../reader/dom';
import { sentencesIn, wordsIn } from '../reader/narration';

/*
 * What an audiobook reads: the book's paragraphs and headings in order, each as its sentences, as
 * reading aloud splits them. A part is one of them, made and played as one MP3.
 */

export interface Chapter {
  title: string;
  /** Its first part. */
  from: number;
}

export interface Plan {
  parts: string[][];
  chapters: Chapter[];
  words: number;
}

export async function planOf(rec: BookRecord): Promise<Plan> {
  const book = await loadRecord(rec);
  if (book.kind !== 'flow') throw new Error('Only books made of words become audiobooks.');
  const parts: string[][] = [];
  const chapters: Chapter[] = [];
  let words = 0;
  for (const section of book.sections) {
    const from = parts.length;
    const doc = new DOMParser().parseFromString(section.html, 'text/html');
    for (const el of collectBlocks(doc.body)) {
      const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      const said = sentencesIn(text, 0).map(([a, b]) => text.slice(a, b).trim()).filter(Boolean);
      if (!said.length) continue;
      parts.push(said);
      words += wordsIn(text);
    }
    if (parts.length > from) chapters.push({ title: section.title || `Part ${chapters.length + 1}`, from });
  }
  if (!parts.length) throw new Error('This book has no words to read aloud.');
  return { parts, chapters, words };
}
