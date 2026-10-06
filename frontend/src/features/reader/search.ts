import type { LoadedBook } from '../../books/types';
import type { Listen, Sentence } from './narration';

/*
 * Finding words in the book: a reader who remembers a line they read, and has gone past it or not
 * got back to it, finds it again. Every chapter's text (a PDF's, page by page) is read once and
 * kept while the book is open. Matches ignore case, accents, curly or straight quotes and dashes,
 * and how the spaces fall, so what a reader remembers finds what the page says.
 */

/** A match: its words, where they are (as a sentence, to go to), and the words around it. */
export interface Found {
  s: Sentence;
  before: string;
  after: string;
  /** How far through the book, 0 to 1. */
  f: number;
}

export interface Block {
  section: number;
  block: number;
  text: string;
  /** The text as it's compared, and for each of its characters, where it came from in `text`. */
  folded: string;
  map: number[];
  /** Where the block starts in the book, and how much of the book it is, as fractions. */
  f: number;
  span: number;
}

const SAME: Record<string, string> = {
  '‘': "'", '’': "'", '‛': "'", 'ʼ': "'", '′': "'", '`': "'",
  '“': '"', '”': '"', '„': '"', '″': '"', '«': '"', '»': '"',
  '‐': '-', '‑': '-', '‒': '-', '–': '-', '—': '-', '―': '-',
  '…': '...',
};
const SPACE = /\s/;
const MARKS = /\p{M}/gu;

/** Text as it's compared, with where each character came from. */
export function fold(text: string): { folded: string; map: number[] } {
  let folded = '';
  const map: number[] = [];
  let spaced = true;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (SPACE.test(c)) {
      if (!spaced) { folded += ' '; map.push(i); spaced = true; }
      continue;
    }
    spaced = false;
    const f = SAME[c] ?? c.normalize('NFD').replace(MARKS, '').toLowerCase();
    for (let k = 0; k < f.length; k++) { folded += f[k]; map.push(i); }
  }
  return { folded, map };
}

const read = new WeakMap<LoadedBook, Promise<Block[]>>();

/**
 * The whole book's text, a chapter (or page) at a time, through the same sentences a voice reads
 * (narration.ts), so a match goes to where the page puts it. `onRead` hears how far it's got.
 */
export function readBook(book: LoadedBook, listen: Listen, onRead?: (done: number, of: number) => void): Promise<Block[]> {
  let p = read.get(book);
  if (p) return p;
  const count = book.kind === 'flow' ? book.sections.length : book.pages;
  const weight = (i: number) => (book.kind === 'flow' ? book.sections[i].words : 1);
  let total = 0;
  for (let i = 0; i < count; i++) total += weight(i);
  total ||= 1;
  p = (async () => {
    const out: Block[] = [];
    let before = 0;
    for (let i = 0; i < count; i++) {
      const sentences = (await listen.section(i)) ?? [];
      // A block's text again, from its sentences where they sit in it.
      const texts = new Map<number, string>();
      for (const s of sentences) {
        if (s.pic !== undefined) continue;
        const t = texts.get(s.block) ?? '';
        texts.set(s.block, t.padEnd(s.start, ' ') + s.text);
      }
      const chars = [...texts.values()].reduce((n, t) => n + t.length, 0) || 1;
      let at = 0;
      for (const [block, text] of [...texts].sort((a, b) => a[0] - b[0])) {
        const share = (weight(i) / total) * (text.length / chars);
        out.push({ section: i, block, text, ...fold(text), f: before / total + (weight(i) / total) * (at / chars), span: share });
        at += text.length;
      }
      before += weight(i);
      onRead?.(i + 1, count);
      // Room for the page to breathe between chapters of a long book.
      if (i % 8 === 7) await new Promise((r) => window.setTimeout(r, 0));
    }
    return out;
  })();
  read.set(book, p);
  return p;
}

const AROUND_BEFORE = 44;
const AROUND_AFTER = 64;

/** Up to `max` matches, in reading order; `more` when there were others past them. */
export function find(blocks: Block[], query: string, max = 300): { found: Found[]; more: boolean } {
  const q = fold(query).folded.trim();
  const found: Found[] = [];
  if (!q) return { found, more: false };
  for (const b of blocks) {
    for (let k = b.folded.indexOf(q); k >= 0; k = b.folded.indexOf(q, k + q.length)) {
      if (found.length === max) return { found, more: true };
      const start = b.map[k];
      const end = b.map[k + q.length - 1] + 1;
      let before = b.text.slice(Math.max(0, start - AROUND_BEFORE), start);
      let after = b.text.slice(end, end + AROUND_AFTER);
      // Cut at a word, and say so.
      if (start > AROUND_BEFORE) before = `…${before.slice(before.indexOf(' ') + 1)}`;
      if (end + AROUND_AFTER < b.text.length) after = `${after.slice(0, Math.max(after.lastIndexOf(' '), 1))}…`;
      found.push({
        s: { section: b.section, block: b.block, start, end, text: b.text.slice(start, end) },
        before: before.trimStart(),
        after: after.trimEnd(),
        f: b.f + b.span * (start / Math.max(1, b.text.length)),
      });
    }
  }
  return { found, more: false };
}

type Highlights = { set: (name: string, h: unknown) => void; delete: (name: string) => void };
const highlights = (globalThis.CSS as unknown as { highlights?: Highlights } | undefined)?.highlights;
let flashing = 0;

/** Points at a match on the page: lit in the book's colour for a moment, then fading (`--found` on `host`). */
export function flash(range: Range | null, host: HTMLElement | null) {
  const mine = ++flashing;
  if (!highlights || !range || !host) return;
  const H = (globalThis as unknown as { Highlight: new (...r: Range[]) => unknown }).Highlight;
  highlights.set('found', new H(range));
  host.style.setProperty('--found', '1');
  const HOLD = 1600;
  const FADE = 900;
  const t0 = performance.now();
  const tick = (now: number) => {
    if (flashing !== mine) return;
    const k = Math.min(1, Math.max(0, (now - t0 - HOLD) / FADE));
    host.style.setProperty('--found', String(1 - k));
    if (k < 1) requestAnimationFrame(tick);
    else { highlights.delete('found'); host.style.removeProperty('--found'); }
  };
  requestAnimationFrame(tick);
}
