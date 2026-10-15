/*
 * The panel labeller's data (README.md): a page picked to label, and its labels as saved. Shared by
 * the labeller in the browser, the server that saves it (vite.config.ts) and export.ts.
 *
 * A panel is four corners, each a whole pixel of the page's own picture, counted from its top left
 * edge: 0 to its width across, 0 to its height down. The corners keep the order they were first
 * placed in (top left, top right, bottom right, bottom left), however far one is dragged, and
 * nothing rounds, sorts, squares off or clips them after: what's saved is what was on screen.
 */

/**
 * Pages come in sets, labelled one after another: the first is picked in picks.json and fetched
 * into data/pages.json, the second in picks2.json and data/pages2.json, and so on.
 */
export const picksOf = (set: number) => (set === 1 ? 'picks.json' : `picks${set}.json`);
export const pagesOf = (set: number) => (set === 1 ? 'pages.json' : `pages${set}.json`);

/**
 * The sets fetched, in order, from the names of the files in data/. A set not fetched here is
 * skipped, so the later ones still count on a machine that only has those.
 */
export function setsIn(files: string[]): number[] {
  const sets: number[] = [];
  for (const f of files) {
    const m = f.match(/^pages(\d*)\.json$/);
    if (!m) continue;
    if (m[1] === '') sets.push(1);
    else sets.push(Number(m[1]));
  }
  return sets.sort((a, b) => a - b);
}

/** A corner: whole pixels from the picture's top left edge, across then down. */
export type Point = [number, number];
/** A panel's four corners, in the order they were first placed. */
export type Quad = [Point, Point, Point, Point];

/** A page picked to label (picks.json), and its picture once fetched (data/pages.json). */
export interface Page {
  id: string;
  series: string;
  title: string;
  /** MangaDex's chapter, its number, and the page in it, from 1. */
  chapter: string;
  number: string;
  page: number;
  /** What this page brings to the set. */
  note: string;
  /** Its picture, in data/pages, exactly as fetched. */
  file: string;
  sha256: string;
  width: number;
  height: number;
}

/** A page's labels, as saved in data/labels/<page>.json. */
export interface Label {
  v: 1;
  page: string;
  file: string;
  sha256: string;
  width: number;
  height: number;
  /** The panels, in the order they're read. None is a page with no panels (a cover, a credits page). */
  panels: Quad[];
  /** What Breader's own panel finder (frames.ts) found, as it found it, to measure a model against. */
  found: Quad[];
  /**
   * The model's guess the labelling started from, as it guessed it, or null when it started from
   * what Breader found. Labels saved before there were guesses don't have it.
   */
  guessed?: Guessed | null;
  saved: string;
}

/** A guess at a page's panels by a round of the panel model (README.md, model/). */
export interface Guessed {
  /** Which round: round-1, round-2 and on. */
  model: string;
  panels: Quad[];
}

/** The model's guess for a page not labelled yet, as written to data/guesses/<page>.json. */
export interface Guess extends Guessed {
  v: 1;
  page: string;
  file: string;
  sha256: string;
  width: number;
  height: number;
  made: string;
  /** How sure the model was of each panel, 0 to 1. */
  sure: number[];
}

/** What the labeller sends to save. */
export interface Edit {
  panels: Quad[];
  found: Quad[];
  guessed: Guessed | null;
}

/** What the labelling of a page started from: the model's guess, or else what Breader found. */
export const startOf = (l: { found: Quad[]; guessed?: Guessed | null }): Quad[] => l.guessed?.panels ?? l.found;

/** Why some quads can't be saved for a page this size, or null when they can. */
export function wrongIn(quads: unknown, width: number, height: number): string | null {
  if (!Array.isArray(quads)) return 'not a list of panels';
  for (const [n, q] of quads.entries()) {
    if (!Array.isArray(q) || q.length !== 4) return `panel ${n + 1} doesn't have four corners`;
    for (const p of q) {
      if (!Array.isArray(p) || p.length !== 2) return `panel ${n + 1} has a corner that isn't a point`;
      const [x, y] = p;
      if (!Number.isInteger(x) || !Number.isInteger(y)) return `panel ${n + 1} has a corner off whole pixels`;
      if (x < 0 || x > width || y < 0 || y > height) return `panel ${n + 1} has a corner off the page`;
    }
  }
  return null;
}

/** Whether two lists of panels are the same, corner for corner. */
export function samePanels(a: Quad[], b: Quad[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
