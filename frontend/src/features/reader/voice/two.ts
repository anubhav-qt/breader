import type { AiVoicesResponse } from '@breader/shared/ai';
import type { Sentence } from '../narration';

/*
 * 2 voices: a woman's and a man's, taking the lines the AI marked as spoken by a woman or a man
 * (server/src/routes/ai.ts), with the narration in whichever voice the book's point of view is.
 * Sentences are cut where a line starts or ends, so each piece is in one voice.
 */

export type Two = 'F' | 'M';

/** A book's voice marks, looked up by paragraph. */
export interface Marks {
  made: string;
  /** Each section's fingerprint when the AI read it (shared printOf). */
  prints: string[];
  /** Whose voice the narration is in at a paragraph, or null for the reader's pick. */
  narratorAt: (section: number, block: number) => Two | null;
  /** The lines spoken in a paragraph, in order: [start, end, voice]. */
  linesIn: (section: number, block: number) => Array<[number, number, Two]>;
}

const before = (a: readonly [number, number, ...unknown[]], s: number, b: number) => a[0] < s || (a[0] === s && a[1] <= b);

export function marksOf(r: AiVoicesResponse): Marks {
  const lines = new Map<string, Array<[number, number, Two]>>();
  for (const [s, b, start, end, g] of r.spans) {
    const k = `${s}.${b}`;
    const list = lines.get(k) ?? [];
    list.push([start, end, g]);
    lines.set(k, list);
  }
  for (const list of lines.values()) list.sort((x, y) => x[0] - y[0]);
  const narration = r.narration.slice().sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  return {
    made: r.made,
    prints: r.sections,
    narratorAt: (s, b) => {
      // The last change at or before the paragraph.
      let lo = 0;
      let hi = narration.length - 1;
      let found = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (before(narration[mid], s, b)) { found = mid; lo = mid + 1; } else hi = mid - 1;
      }
      return found >= 0 ? narration[found][2] : null;
    },
    linesIn: (s, b) => lines.get(`${s}.${b}`) ?? [],
  };
}

const SAYABLE = /[\p{L}\p{N}]/u;

/**
 * Cuts sentences where a spoken line starts or ends, and gives each piece its voice: the line's, or
 * the narration's. Bits with nothing to say (a quote mark, a space) join the piece after them, and
 * pieces side by side in the same voice stay one. A section whose text isn't the one the marks
 * were made from (`same` false) is read in one voice: the reader's pick for no point of view.
 */
export function inTwo(list: Sentence[], marks: Marks, pick: Two, same: (section: number) => boolean): Sentence[] {
  const out: Sentence[] = [];
  for (const s of list) {
    if (!same(s.section)) {
      out.push({ ...s, g: pick });
      continue;
    }
    const narr = marks.narratorAt(s.section, s.block) ?? pick;
    const pieces: Array<[number, number, Two]> = [];
    let at = s.start;
    for (const [a, b, g] of marks.linesIn(s.section, s.block)) {
      if (b <= s.start || a >= s.end) continue;
      const from = Math.max(a, s.start);
      const to = Math.min(b, s.end);
      if (from > at) pieces.push([at, from, narr]);
      pieces.push([from, to, g]);
      at = to;
    }
    if (at < s.end) pieces.push([at, s.end, narr]);

    const mine: Sentence[] = [];
    let carry: number | null = null;
    for (const [a, b, g] of pieces) {
      const from: number = carry ?? a;
      const text = s.text.slice(a - s.start, b - s.start);
      if (!SAYABLE.test(text)) {
        carry = from;
        continue;
      }
      carry = null;
      const last = mine[mine.length - 1];
      if (last && last.g === g && last.end === from) {
        last.end = b;
        last.text = s.text.slice(last.start - s.start, b - s.start);
      } else {
        mine.push({ ...s, start: from, end: b, text: s.text.slice(from - s.start, b - s.start), g });
      }
    }
    // Nothing to say after the last piece: it takes the rest.
    const last = mine[mine.length - 1];
    if (carry !== null && last) {
      last.end = s.end;
      last.text = s.text.slice(last.start - s.start);
    }
    out.push(...mine);
  }
  return out;
}
