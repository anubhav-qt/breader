import { wordMarks, type Listen, type Sentence } from './narration';
import type { Spot } from './pacing';

/* The keys themselves are in keymap.ts, apart, so the library's audiobook keys load without the reader. */
export * from './keymap';

/* Finding places */

/** A sentence's words; a picture has none. */
const wordsOf = (s: Sentence) => (s.pic !== undefined ? 0 : wordMarks(s.text).length);

/** The next chapter on with anything in it (`dir` -1: back), or null past either end of the book. */
async function nextWith(l: Listen, section: number, dir: 1 | -1) {
  for (let k = section + dir; k >= 0; k += dir) {
    const list = await l.section(k);
    if (!list) return null;
    if (list.length) return list;
  }
  return null;
}

/**
 * The place `words` words on from a spot, or back when it's negative, into the chapters either
 * side; held at the book's ends. A spot's word is the one it's on, so 0 finds the chapter's own
 * sentence holding it (a voice's spot can be part of one, cut for 2 voices).
 */
export async function wordsOn(l: Listen, from: Spot, words: number): Promise<Spot | null> {
  let list = await l.section(from.s.section);
  if (!list) return null;
  let i = list.findIndex((s) => {
    if (from.s.pic !== undefined) return s.pic === from.s.pic;
    return s.block === from.s.block && s.start <= from.s.start && from.s.start < s.end;
  });
  if (i < 0) return null;
  // The word it's on: the words that end before where it's got to.
  const into = from.s.start + from.at - list[i].start;
  let w = 0;
  if (from.at > 0) w = wordMarks(list[i].text).filter((m) => m.at < into).length;
  w += words;
  while (w >= wordsOf(list[i])) {
    w -= wordsOf(list[i]);
    if (i + 1 < list.length) {
      i++;
      continue;
    }
    const next = await nextWith(l, list[i].section, 1);
    if (!next) return { s: list[i], at: 0 };
    list = next;
    i = 0;
  }
  while (w < 0) {
    if (i > 0) {
      i--;
    } else {
      const before = await nextWith(l, list[i].section, -1);
      if (!before) return { s: list[i], at: 0 };
      list = before;
      i = list.length - 1;
    }
    w += wordsOf(list[i]);
  }
  const s = list[i];
  if (w === 0) return { s, at: 0 };
  return { s, at: wordMarks(s.text)[w].at };
}

/** The start of the sentence after the one a spot is in, or the one before it. */
export async function sentenceOn(l: Listen, from: Spot, dir: 1 | -1): Promise<Spot | null> {
  const here = await wordsOn(l, from, 0);
  if (!here) return null;
  let words = -1;
  if (dir === 1) words = wordsOf(here.s);
  const there = await wordsOn(l, { s: here.s, at: 0 }, words);
  if (!there) return null;
  return { s: there.s, at: 0 };
}

/** A chapter's stretch of the book: each of its sections (a PDF: pages) and about how many words it has. */
export interface Part {
  section: number;
  words: number;
}

/** The sentence `f` of the way into a chapter: 0 its first, 1 its last. */
export async function partWay(l: Listen, parts: Part[], f: number): Promise<Spot | null> {
  let total = 0;
  for (const p of parts) total += p.words;
  // The section it's in, and how far into that.
  let want = f * total;
  let k = 0;
  while (k < parts.length - 1 && want >= parts[k].words) {
    want -= parts[k].words;
    k++;
  }
  let into = 0;
  if (parts[k].words > 0) into = Math.min(1, want / parts[k].words);
  // A section with nothing to say (a picture on its own) gives the last sentence before it.
  for (let j = k; j >= 0; j--) {
    const all = (await l.section(parts[j].section)) ?? [];
    const list = all.filter((s) => s.pic === undefined);
    if (!list.length) continue;
    if (j < k) return { s: list[list.length - 1], at: 0 };
    return { s: sentenceAt(list, into), at: 0 };
  }
  return null;
}

/** The sentence `into` of the way through a list's words. */
function sentenceAt(list: Sentence[], into: number) {
  let total = 0;
  for (const s of list) total += wordsOf(s);
  let w = Math.floor(into * total);
  for (const s of list) {
    if (w < wordsOf(s)) return s;
    w -= wordsOf(s);
  }
  return list[list.length - 1];
}
