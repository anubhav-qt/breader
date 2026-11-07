import { MANGA_KINDS, type AniCard, type MangaKind } from '@breader/shared';

/*
 * The names of the series the server knows (Browse's AniList lists, as they're fetched or warmed),
 * looked through as a reader types: a name, or one of its words, starting with what's typed, or
 * close to it, a letter or two off ("solo levelling" finds Solo Leveling). All in memory, a few
 * thousand series, so a look takes a few milliseconds and asks no one.
 */

/** A name keyed as a search is (seriesName): lower case, no accents or spaces, and where each word starts. */
interface Keyed {
  key: string;
  /** starts[j]: a word starts at key[j]. */
  starts: boolean[];
}

interface Known {
  card: AniCard;
  /** Its place in the lists, the most read first. */
  rank: number;
  names: Keyed[];
}

/** What a look wants. */
export interface NamesAsk {
  q: string;
  adult: boolean;
  adultOnly: boolean;
  kinds: MangaKind[];
}

/** The most names a look gives. */
export const MOST_NAMES_SHOWN = 8;

/** A name's words as keys, as seriesName keys them, without a "the" in front. */
function wordsOf(name: string): string[] {
  const bare = name.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
  const parts = bare.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (parts.length > 1 && parts[0] === 'the') parts.shift();
  const words: string[] = [];
  for (const p of parts) {
    const w = p.replace(/uu/g, 'u').replace(/ou/g, 'o');
    if (w) words.push(w);
  }
  return words;
}

export function keyed(name: string): Keyed {
  const words = wordsOf(name);
  let key = '';
  const starts: boolean[] = [];
  for (const w of words) {
    starts.push(true);
    for (let i = 1; i < w.length; i++) starts.push(false);
    key += w;
  }
  starts.push(false);
  return { key, starts };
}

/** How many letters a search may be off by: none while it's short, more as it gets longer. */
export function slackOf(length: number): number {
  if (length <= 3) return 0;
  if (length <= 7) return 1;
  return 2;
}

/** Rows reused from one name to the next, so a look makes no garbage: grown as names need. */
let rowsFor = 0;
let twoBack = new Int32Array(0);
let oneBack = new Int32Array(0);
let row = new Int32Array(0);

function roomFor(n: number) {
  if (n <= rowsFor) return;
  rowsFor = n * 2;
  twoBack = new Int32Array(rowsFor);
  oneBack = new Int32Array(rowsFor);
  row = new Int32Array(rowsFor);
}

/**
 * How far q is from the start of a name, or of one of its words when anyWord, that starts with q's
 * first letter: letters to change, add, take out or swap round, past which the name may go on
 * ("solo lev" is 0 from Solo Leveling). Gives up, with slack + 1, once it's past slack.
 */
export function distance(q: string, name: Keyed, slack: number, anyWord: boolean): number {
  const n = name.key.length;
  const over = slack + 1;
  roomFor(n + 1);
  // prev[j]: q's first i letters matched to the name up to j, starting at a word's start.
  let before = twoBack;
  let prev = oneBack;
  let cur = row;
  // A name, or word, starts with q's first letter: a slip is seldom the first letter typed.
  const first = q.charCodeAt(0);
  for (let j = 0; j <= n; j++) {
    let free = j === 0;
    if (anyWord) free = name.starts[j];
    if (free && name.key.charCodeAt(j) !== first) free = false;
    if (free) prev[j] = 0;
    else prev[j] = over;
  }
  for (let i = 1; i <= q.length; i++) {
    const letter = q.charCodeAt(i - 1);
    const last = q.charCodeAt(i - 2);
    cur[0] = Math.min(over, prev[0] + 1);
    let least = cur[0];
    for (let j = 1; j <= n; j++) {
      let cost = 1;
      if (letter === name.key.charCodeAt(j - 1)) cost = 0;
      let d = prev[j - 1] + cost;
      if (prev[j] + 1 < d) d = prev[j] + 1;
      if (cur[j - 1] + 1 < d) d = cur[j - 1] + 1;
      // Two letters swapped round ("levle").
      if (i > 1 && j > 1 && letter === name.key.charCodeAt(j - 2) && last === name.key.charCodeAt(j - 1)) {
        if (before[j - 2] + 1 < d) d = before[j - 2] + 1;
      }
      if (d > over) d = over;
      cur[j] = d;
      if (d < least) least = d;
    }
    if (least >= over) return over;
    const spare = before;
    before = prev;
    prev = cur;
    cur = spare;
  }
  let best = over;
  for (let j = 0; j <= n; j++) {
    if (prev[j] < best) best = prev[j];
  }
  return best;
}

/** How close a series' names come to q: the closest, and whether that's only in a later word. */
function closestOf(q: string, names: Keyed[], slack: number): { d: number; inWord: boolean } {
  // Any word first: most names aren't near at all, and that's found as quickly either way.
  let d = slack + 1;
  for (const name of names) {
    const any = distance(q, name, slack, true);
    if (any < d) d = any;
    if (d === 0) break;
  }
  if (d > slack) return { d, inWord: false };
  for (const name of names) {
    if (distance(q, name, slack, false) === d) return { d, inWord: false };
  }
  return { d, inWord: true };
}

/** Whether a card is one a look wants: of a kind asked for, and 18+ only as asked. */
function wanted(card: AniCard, ask: NamesAsk): boolean {
  if (ask.adultOnly && !card.adult) return false;
  if (!ask.adult && !ask.adultOnly && card.adult) return false;
  if (ask.kinds.length >= MANGA_KINDS.length) return true;
  return card.kind !== null && ask.kinds.includes(card.kind);
}

export class Names {
  private known = new Map<number, Known>();

  /** A series seen in a list, at that place in it; seen again higher, it keeps the higher place. */
  add(card: AniCard, rank: number): void {
    const had = this.known.get(card.id);
    let best = rank;
    if (had && had.rank < rank) best = had.rank;
    const names: Keyed[] = [];
    const seen = new Set<string>();
    for (const n of [card.title, ...card.names]) {
      const k = keyed(n);
      if (!k.key || seen.has(k.key)) continue;
      seen.add(k.key);
      names.push(k);
    }
    this.known.set(card.id, { card, rank: best, names });
  }

  get size(): number {
    return this.known.size;
  }

  /**
   * The series whose names are closest to q, the most read first: those starting with it before
   * those with a word that does. Of those a letter or two off, only the closest, and only those at
   * a name's start when there are some. None when q has no letters or numbers.
   */
  look(ask: NamesAsk, most = MOST_NAMES_SHOWN): AniCard[] {
    const q = keyed(ask.q).key;
    if (!q) return [];
    const slack = slackOf(q.length);
    const hits: Array<{ card: AniCard; d: number; inWord: boolean; rank: number }> = [];
    for (const k of this.known.values()) {
      if (!wanted(k.card, ask)) continue;
      const { d, inWord } = closestOf(q, k.names, slack);
      if (d <= slack) hits.push({ card: k.card, d, inWord, rank: k.rank });
    }
    let closest = slack + 1;
    for (const h of hits) {
      if (h.d < closest) closest = h.d;
    }
    let shown = hits.filter((h) => h.d === closest);
    // A letter or two off at a name's start says more than in a later word ("narto" is Naruto, not The Art of…).
    const atStart = shown.some((h) => !h.inWord);
    if (closest > 0 && atStart) shown = shown.filter((h) => !h.inWord);
    shown.sort((a, b) => {
      if (a.inWord !== b.inWord) {
        if (a.inWord) return 1;
        return -1;
      }
      return a.rank - b.rank;
    });
    return shown.slice(0, most).map((h) => h.card);
  }
}
