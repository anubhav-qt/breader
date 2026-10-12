import type { AiVoicesResponse } from '@breader/shared/ai';
import type { Sentence } from '../narration';
import type { Engine } from './catalog';

/*
 * 2 voices: a woman's and a man's, taking the lines the AI marked as spoken by a woman or a man
 * (server/src/routes/ai.ts), with the narration in whichever voice the book's point of view is.
 * Sentences are cut where a line starts or ends, so each piece is in one voice.
 *
 * Character voices cut the same way, and say who each piece is by: the line's speaker, or the
 * narrator telling the story in the first person (voice/cast.ts picks their voices).
 */

export type Two = 'F' | 'M';

/** A book's voice marks, looked up by paragraph. */
export interface Marks {
  made: string;
  /** Each section's fingerprint when the AI read it (shared printOf). */
  prints: string[];
  /** Whose voice the narration is in at a paragraph, or null for the reader's pick. */
  narratorAt: (section: number, block: number) => Two | null;
  /** The lines spoken in a paragraph, in order: [start, end, voice, who], who the speaker's key or -1. */
  linesIn: (section: number, block: number) => Array<[number, number, Two, number]>;
  /** Who tells the story in the first person at a paragraph: their key, or -1. */
  tellerAt: (section: number, block: number) => number;
  /** The voice the AI picked for each speaker, by key: its id in each model. */
  picks: Map<number, Record<Engine, string>>;
  /** Each speaker's id across the series, by key (AiCastMember.id). */
  ids: Map<number, string>;
}

const before = (a: readonly [number, number, ...unknown[]], s: number, b: number) => a[0] < s || (a[0] === s && a[1] <= b);

/** The last change at or before the paragraph, in a list sorted by paragraph: its index, or -1. */
function lastAt(list: ReadonlyArray<readonly [number, number, ...unknown[]]>, s: number, b: number) {
  let lo = 0;
  let hi = list.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (before(list[mid], s, b)) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found;
}

const byPlace = (x: readonly [number, number, ...unknown[]], y: readonly [number, number, ...unknown[]]) => x[0] - y[0] || x[1] - y[1];

export function marksOf(r: AiVoicesResponse): Marks {
  const lines = new Map<string, Array<[number, number, Two, number]>>();
  for (const [i, [s, b, start, end, g]] of r.spans.entries()) {
    const k = `${s}.${b}`;
    const list = lines.get(k) ?? [];
    list.push([start, end, g, r.who?.[i] ?? -1]);
    lines.set(k, list);
  }
  for (const list of lines.values()) list.sort((x, y) => x[0] - y[0]);
  const narration = r.narration.slice().sort(byPlace);
  const tellers = (r.tellers ?? []).slice().sort(byPlace);
  const picks = new Map<number, Record<Engine, string>>();
  for (const [key, piper, kokoro] of r.picks ?? []) picks.set(key, { piper, kokoro });
  const ids = new Map<number, string>(r.ids ?? []);
  return {
    made: r.made,
    prints: r.sections,
    narratorAt: (s, b) => {
      const at = lastAt(narration, s, b);
      return at >= 0 ? narration[at][2] : null;
    },
    linesIn: (s, b) => lines.get(`${s}.${b}`) ?? [],
    tellerAt: (s, b) => {
      const at = lastAt(tellers, s, b);
      return at >= 0 ? tellers[at][2] : -1;
    },
    picks,
    ids,
  };
}

const SAYABLE = /[\p{L}\p{N}]/u;

/**
 * Cuts sentences where a spoken line starts or ends, and gives each piece its voice: the line's, or
 * the narration's. Bits with nothing to say (a quote mark, a space) join the piece after them, and
 * pieces side by side in the same voice stay one. A section whose text isn't the one the marks
 * were made from (`same` false) is read in one voice: the reader's pick for no point of view.
 * For character voices (`cast`), each piece also says who it's by, and pieces by two people stay apart.
 */
export function inTwo(list: Sentence[], marks: Marks, pick: Two, same: (section: number) => boolean, cast = false): Sentence[] {
  const out: Sentence[] = [];
  for (const s of list) {
    // A picture has nothing to say, in either voice.
    if (s.pic !== undefined) {
      out.push(s);
      continue;
    }
    if (!same(s.section)) {
      out.push({ ...s, g: pick });
      continue;
    }
    const narr = marks.narratorAt(s.section, s.block) ?? pick;
    let teller = -1;
    if (cast) teller = marks.tellerAt(s.section, s.block);
    const pieces: Array<[number, number, Two, number]> = [];
    let at = s.start;
    for (const [a, b, g, who] of marks.linesIn(s.section, s.block)) {
      if (b <= s.start || a >= s.end) continue;
      const from = Math.max(a, s.start);
      const to = Math.min(b, s.end);
      if (from > at) pieces.push([at, from, narr, teller]);
      let speaker = -1;
      if (cast) speaker = who;
      pieces.push([from, to, g, speaker]);
      at = to;
    }
    if (at < s.end) pieces.push([at, s.end, narr, teller]);

    const mine: Sentence[] = [];
    let carry: number | null = null;
    for (const [a, b, g, who] of pieces) {
      const from: number = carry ?? a;
      const text = s.text.slice(a - s.start, b - s.start);
      if (!SAYABLE.test(text)) {
        carry = from;
        continue;
      }
      carry = null;
      const last = mine[mine.length - 1];
      if (last && last.g === g && last.who === who && last.end === from) {
        last.end = b;
        last.text = s.text.slice(last.start - s.start, b - s.start);
      } else {
        mine.push({ ...s, start: from, end: b, text: s.text.slice(from - s.start, b - s.start), g, who });
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
