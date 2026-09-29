import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Style } from './quotes.ts';

/*
 * What the tools share: where things live, the queue of books, and a book as extract.ts leaves it.
 * Everything under ai/work and ai/out is private (the books themselves, and what's made from them)
 * and git ignores it.
 */

export const AI = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const ROOT = resolve(AI, '..');
export const WORK = join(AI, 'work');
export const OUT = join(AI, 'out');
export const bookDir = (key: string) => join(WORK, key);

export type Format = 'EPUB' | 'PDF' | 'TXT' | 'MD' | 'Text';
export type Gender = 'M' | 'F' | 'N';
/** A paragraph: [section, block], the same numbers the reader gives it. */
export type Pos = [number, number];

export const posText = (p: Pos) => `${p[0]}:${p[1]}`;
export function parsePos(s: unknown): Pos | null {
  if (typeof s !== 'string') return null;
  const m = s.trim().match(/^(\d+):(\d+)$/);
  return m ? [Number(m[1]), Number(m[2])] : null;
}
export const cmp = (a: Pos, b: Pos) => a[0] - b[0] || a[1] - b[1];

/** One file in the production library, however many readers hold it. */
export interface QueueBook {
  rank: number;
  key: string;
  sha256: string;
  title: string;
  author: string;
  format: Format;
  size: number;
  /** Where the file is: an object in R2, or a sample bundled with the app (a path under frontend/public). */
  r2Key?: string;
  sample?: string;
  series?: string;
  seriesIndex?: number;
  /** Someone has read some of it. */
  started: boolean;
  /** The furthest anyone has got, 0 to 1. */
  progress: number;
  lastRead: string;
  /** How many libraries hold it. */
  readers: number;
}

export interface Queue {
  made: string;
  books: QueueBook[];
  /** Books that couldn't be listed, and why (a file that never finished uploading). */
  skipped: string[];
}

/** A paragraph-level element of a chapter: its tag and its exact text (textContent). */
export interface Block {
  tag: string;
  text: string;
  words: number;
}

export interface Section {
  title: string;
  blocks: Block[];
  words: number;
  /** Its blocks' count and a hash of their text, so the app can tell it parsed the same text. */
  print: string;
}

/** A numbered quote in a paragraph: [start, end) characters of the block's text. */
export interface Seg {
  s: number;
  b: number;
  n: number;
  start: number;
  end: number;
  /** runs-on: the speech carries on in the next paragraph. The rest want a look. */
  note?: 'runs-on' | 'unclosed' | 'dash';
}

/** A stretch of the book read and marked in one go: text/NNNN.md and marks/NNNN.txt. */
export interface Part {
  n: number;
  from: Pos;
  to: Pos;
  words: number;
}

export interface Book {
  v: 1;
  key: string;
  sha256: string;
  title: string;
  author: string;
  format: Format;
  kind: 'flow' | 'pdf';
  words: number;
  style: Style;
  sections: Section[];
  parts: Part[];
  segs: Seg[];
  /** Paragraphs whose quote marks don't pair up. */
  stray: Pos[];
}

export const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, 'utf8')) as T;
export function writeJson(file: string, value: unknown) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export const partName = (n: number) => String(n).padStart(4, '0');
export const inPart = (p: Part, at: Pos) => cmp(at, p.from) >= 0 && cmp(at, p.to) <= 0;
export const hasText = (t: string) => /[\p{L}\p{N}]/u.test(t);

/** FNV-1a over UTF-16 code units: small, and the same in the browser. */
export function fnv(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
export const fingerprint = (texts: string[]) => `${texts.length}:${fnv(texts.join('\u0001'))}`;

export function slug(title: string): string {
  const s = title
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return s || 'book';
}

export const QUEUE = join(WORK, 'queue.json');

export function loadQueue(): Queue {
  if (!existsSync(QUEUE)) throw new Error('No queue yet. Run: npm --prefix ai run books');
  return readJson<Queue>(QUEUE);
}

export const isPacked = (b: { sha256: string }) => existsSync(join(OUT, `${b.sha256}.json`));
export const isFetched = (key: string) => existsSync(join(bookDir(key), 'book.json'));

/** A book named by its rank in the queue, its key, or the start of its key or SHA-256. */
export function findBook(arg: string): QueueBook {
  const q = loadQueue();
  const a = arg.trim().toLowerCase();
  const hit = /^\d+$/.test(a) && Number(a) <= q.books.length
    ? q.books.find((b) => b.rank === Number(a))
    : q.books.find((b) => b.key === a) ?? q.books.find((b) => b.key.startsWith(a) || b.sha256.startsWith(a));
  if (!hit) throw new Error(`No book "${arg}" in the queue. Run: npm --prefix ai run books`);
  return hit;
}

export function loadBook(arg: string): Book {
  const key = existsSync(join(bookDir(arg), 'book.json')) ? arg : findBook(arg).key;
  const file = join(bookDir(key), 'book.json');
  if (!existsSync(file)) throw new Error(`${key} isn't fetched yet. Run: npm --prefix ai run fetch -- ${key}`);
  return readJson<Book>(file);
}

/** Every text block of a part, in order. */
export function* blocksOf(book: Book, p: Part): Generator<{ at: Pos; block: Block }> {
  for (let s = p.from[0]; s <= p.to[0]; s++) {
    const blocks = book.sections[s]?.blocks ?? [];
    const first = s === p.from[0] ? p.from[1] : 0;
    const last = s === p.to[0] ? p.to[1] : blocks.length - 1;
    for (let b = first; b <= last; b++) yield { at: [s, b], block: blocks[b] };
  }
}

export const blockAt = (book: Book, at: Pos): Block | undefined => book.sections[at[0]]?.blocks[at[1]];

/** Marks files that exist, by part number. */
export function marksFiles(key: string): number[] {
  const dir = join(bookDir(key), 'marks');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((f) => f.match(/^(\d{4})\.txt$/)?.[1])
    .filter((n): n is string => !!n)
    .map(Number)
    .sort((a, b) => a - b);
}

export const count = (n: number) => n.toLocaleString('en-GB');
/** "1 line", "2 lines". */
export const plural = (n: number, one = 'line', many = `${one}s`) => `${count(n)} ${n === 1 ? one : many}`;

/** Arguments after the command, and --flags with or without values. */
export function args(): { rest: string[]; flags: Record<string, string | true> } {
  const rest: string[] = [];
  const flags: Record<string, string | true> = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { rest.push(a); continue; }
    const [k, v] = a.slice(2).split('=', 2);
    if (v !== undefined) flags[k] = v;
    else if (argv[i + 1] && !argv[i + 1].startsWith('--') && k === 'by') flags[k] = argv[++i];
    else flags[k] = true;
  }
  return { rest, flags };
}

/** Runs a command, printing a failure plainly instead of a stack. */
export function main(run: () => Promise<number | void> | number | void) {
  Promise.resolve()
    .then(run)
    .then((code) => { process.exitCode = code ?? 0; })
    .catch((err: unknown) => {
      console.error(`\n${err instanceof Error ? err.message : String(err)}`);
      if (process.env.AI_DEBUG && err instanceof Error) console.error(err.stack);
      process.exitCode = 1;
    });
}
