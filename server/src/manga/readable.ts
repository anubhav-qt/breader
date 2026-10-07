import type { MangaCard, MangaChapter } from '@breader/shared';

/*
 * Whether every chapter of a series can be read here, the same way wherever it's from: each whole
 * number from 1 up to its newest, parts counting toward their chapter (12.1 and 12.2 make up 12).
 * An ongoing series may lack its newest few, as they're often still on their way.
 */

/** An ongoing series still shows while its newest chapters, up to this many, aren't here yet. */
const SPARE = 2;

/** The first chapter from 1 that none of these is, or is part of. */
export function firstMissing(chapters: MangaChapter[]): number {
  const have = new Set<number>();
  for (const c of chapters) {
    if (c.chapter === null) continue;
    const n = Math.floor(Number(c.chapter));
    if (Number.isFinite(n)) have.add(n);
  }
  let n = 1;
  while (have.has(n)) n++;
  return n;
}

/** The newest whole number among these chapters: 0 when none is numbered. */
export function highest(chapters: MangaChapter[]): number {
  let top = 0;
  for (const c of chapters) {
    if (c.chapter === null) continue;
    const n = Math.floor(Number(c.chapter));
    if (n > top) top = n;
  }
  return top;
}

/**
 * The chapters run unbroken past the newest: past an ended series' last too (`last`, when its
 * source says it), and for an ongoing one, past all but its newest two.
 */
export function caughtUp(status: MangaCard['status'], last: number, missing: number, newest: number): boolean {
  if (status === 'completed' || status === 'cancelled') {
    let need = newest;
    if (last > need) need = last;
    return missing > need;
  }
  return missing > newest - SPARE;
}
