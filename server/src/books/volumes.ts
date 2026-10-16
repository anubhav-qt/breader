import type { BookCard, BookVolume } from '@breader/shared';

/*
 * A novel's chapters as volumes, each read as a book of its own: its site's volumes, when nearly
 * every chapter's name says which it's in ("Vol. 3 Chapter 12"), or else a hundred chapters each.
 * A site's volume too long to read as one book goes in parts of a hundred. The last volume of a
 * novel still coming out is open: it gains chapters as they come, and is made again with them.
 */

/** Chapters in a volume made of them, and in each part of a site's volume too long. */
export const CHUNK = 100;
/** A site's volume longer than this goes in parts. */
const LONGEST = 2 * CHUNK;
/** How many of a novel's chapters must name their volume for its site's volumes to be used. */
const MARKED = 0.8;

const VOLUME = /\bvol(?:ume)?\.?\s*(\d{1,4})\b/i;
/** V3C12, as some sites write it. */
const SHORT = /^\s*v(\d{1,4})\s*c\s*\d/i;
const NUMBERED = /\b(?:chapter|chap|ch|episode|ep)\.?\s*(\d{1,5}(?:\.\d{1,2})?)/i;
const LEADING = /^\s*(\d{1,5}(?:\.\d{1,2})?)(?=\s|[.:)\-–]|$)/;

export interface PlanChapter {
  name: string;
  /** Its number, as its site or its name says, or null. */
  number: number | null;
}

/** A volume and the chapters it holds, from `from` up to (not with) `to`. */
export interface Planned extends BookVolume {
  from: number;
  to: number;
}

/** The volume a chapter's name says it's in, or null. */
export function volumeOf(name: string): number | null {
  const m = VOLUME.exec(name) ?? SHORT.exec(name);
  if (!m) return null;
  return Number(m[1]);
}

/** A chapter's number, as its site gives it or its name says, or null. */
export function chapterNumber(name: string, given: number | null): number | null {
  if (given !== null && Number.isFinite(given) && given >= 0) return given;
  const m = NUMBERED.exec(name) ?? LEADING.exec(name);
  if (!m) return null;
  return Number(m[1]);
}

/** Runs of chapters in the same site volume: [from, to, its number]. Chapters naming none go with the one before. */
function runs(chapters: PlanChapter[]): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = [];
  for (let i = 0; i < chapters.length; i++) {
    const v = volumeOf(chapters[i].name);
    const last = out[out.length - 1];
    if (last && (v === null || v === last[2])) {
      last[1] = i + 1;
      continue;
    }
    // Those before the first that names one go with it.
    let n = v ?? 1;
    if (!last && v === null) {
      const named = chapters.find((c) => volumeOf(c.name) !== null);
      if (named) n = volumeOf(named.name)!;
    }
    out.push([i, i + 1, n]);
  }
  return out;
}

/** Its chapters' names and numbers, from and to. */
function span(chapters: PlanChapter[], from: number, to: number) {
  const first = chapters[from];
  const last = chapters[to - 1];
  return { first: first.name, last: last.name, a: first.number, b: last.number };
}

/** A novel still coming out: ongoing, or not known to have ended. */
function ongoing(status: BookCard['status']): boolean {
  return status !== 'completed' && status !== 'cancelled';
}

/** The novel's volumes, in reading order. */
export function plan(chapters: PlanChapter[], status: BookCard['status']): Planned[] {
  if (chapters.length === 0) return [];
  let marked = 0;
  for (const c of chapters) {
    if (volumeOf(c.name) !== null) marked += 1;
  }
  const bySite = marked >= MARKED * chapters.length;
  const out: Planned[] = [];
  if (bySite) {
    const all = runs(chapters);
    for (let r = 0; r < all.length; r++) {
      const [from, to, n] = all[r];
      const size = to - from;
      const lastRun = r === all.length - 1;
      if (size <= LONGEST) {
        const s = span(chapters, from, to);
        out.push({ n: 0, title: `Volume ${n}`, chapters: size, first: s.first, last: s.last, open: lastRun && ongoing(status), from, to });
        continue;
      }
      let part = 1;
      for (let at = from; at < to; at += CHUNK) {
        const end = Math.min(at + CHUNK, to);
        const s = span(chapters, at, end);
        const open = lastRun && end === to && ongoing(status);
        out.push({ n: 0, title: `Volume ${n}, part ${part}`, chapters: end - at, first: s.first, last: s.last, open, from: at, to: end });
        part += 1;
      }
    }
  } else {
    for (let at = 0; at < chapters.length; at += CHUNK) {
      const end = Math.min(at + CHUNK, chapters.length);
      const s = span(chapters, at, end);
      let title = `Chapters ${at + 1}-${end}`;
      if (s.a !== null && s.b !== null && s.b >= s.a) title = `Chapters ${s.a}-${s.b}`;
      const lastChunk = end === chapters.length;
      const open = lastChunk && end - at < CHUNK && ongoing(status);
      out.push({ n: 0, title, chapters: end - at, first: s.first, last: s.last, open, from: at, to: end });
    }
  }
  for (let i = 0; i < out.length; i++) out[i].n = i + 1;
  return out;
}

/** The chapters in reading order: a site listing its newest first is turned round. */
export function oldestFirst<T extends PlanChapter>(chapters: T[]): T[] {
  const numbered = chapters.filter((c) => c.number !== null);
  if (numbered.length < 2) return chapters;
  const first = numbered[0].number!;
  const last = numbered[numbered.length - 1].number!;
  if (first > last) return [...chapters].reverse();
  return chapters;
}
