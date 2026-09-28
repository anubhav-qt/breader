import type { Position, ReadMark } from './types';

/** Faster than this, in words a minute, pages are being passed, not read. */
const PACE = 1200;
/** A screen with fewer words is a title page or a picture, too little to measure the others by. */
const MIN_SCREEN = 150;

/** A place the reader has come to, and about how many words fit on the screen there. */
export interface Place {
  pos: Position;
  progress: number;
  line: string;
  screen: number;
}

export const screenWords = (screen: number) => Math.max(MIN_SCREEN, screen);

/** The later of two marks: a new reading of the book, or further into the same one. */
export function laterMark(a: ReadMark | undefined, b: ReadMark | undefined): ReadMark | undefined {
  if (!a || !b) return a ?? b;
  const na = a.n ?? 0;
  const nb = b.n ?? 0;
  if (na !== nb) return na > nb ? a : b;
  return b.progress > a.progress ? b : a;
}

/**
 * Follows the reader through a book and keeps the mark: how far they've really read. Pages turned
 * no faster than anyone reads carry it on from where it is. A jump ahead (the contents, the
 * scrubber, pages flicked past) leaves it behind, unless the reader stays and reads three screens
 * on from there. Looking back, or going back to read a part again, never moves it back; reading on
 * past it from there carries it on. A finished book read again from well before its end starts a
 * new reading.
 */
export function markTracker(start: ReadMark | undefined, words: number) {
  const total = Math.max(1, words);
  let mark = start;
  let last: { at: number; t: number } | null = null;
  /** Words the time since the last move would let anyone read, up to a couple of screens. */
  let bank = 0;
  /** The stretch being read without a jump: where it began, and the words read in it. */
  let run = { from: 0, read: 0 };

  return {
    get: () => mark,
    /** The reader is somewhere new. Returns the mark, moved or not. */
    step(p: Place, t = Date.now()): ReadMark {
      const here: ReadMark = { pos: p.pos, progress: p.progress, line: p.line, ...(mark?.n ? { n: mark.n } : {}) };
      const screen = screenWords(p.screen);
      const cap = screen * 2 + 50;
      const at = p.progress * total;
      if (!mark) mark = here;
      if (!last) {
        // Where the book opens was being read when it closed.
        last = { at, t };
        bank = 0;
        run = { from: at, read: 0 };
        return mark;
      }
      bank = Math.min(cap, bank + ((t - last.t) * PACE) / 60_000);
      const d = at - last.at;
      const reading = d > 0 && d <= bank;
      if (reading) {
        bank -= d;
        run.read += d;
      } else if (d < 0 && -d <= screen * 2) {
        // A look back: still the same stretch.
      } else if (d !== 0) {
        run = { from: at, read: 0 };
      }
      last = { at, t };

      const markAt = mark.progress * total;
      if (mark.progress >= 1) {
        if (run.read >= screen * 3 && run.from < markAt - screen * 10) mark = { ...here, n: (mark.n ?? 0) + 1 };
      } else if (reading && at > markAt && (run.from <= markAt + screen || run.read >= screen * 3)) {
        mark = here;
      }
      return mark;
    },
  };
}
