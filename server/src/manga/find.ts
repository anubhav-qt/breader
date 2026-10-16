import { MANGA_KINDS, namesOf, sameKind, seriesName, type MangaFoundIn, type MangaKind, type MangaSort, type SeriesNames } from '@breader/shared';
import { log } from '../log.ts';

/*
 * One search across every place Breader looks for manga: MangaDex and each source of its Suwayomi
 * server. Every place is asked at once, each for its next lot, and what they found is shown
 * together. The same series found in three places comes three times, side by side, each with the
 * names it goes by keyed (seriesName), so the app shows it as one: those whose title is what was
 * searched for first, then those found in more places, then the places taken in turn. No place
 * goes first because of what it is. Books are found the same way (books/index.ts), as their own
 * cards.
 */

/** How long a search waits for each place. One slower is asked again with the next lot, by when what it found is kept. */
export const DEADLINE = 12_000;
/**
 * Once a place has brought something, how much longer the others are waited for: a reader sees
 * what's come, and a slow site's series join with the next lot. Not for a sheet's look for its
 * series' other copies, which waits for every place it can.
 */
export const GRACE = 1_500;
/** How long a lot waits in all when every place is late, for the first to come: within the app's 20 s for a search. */
const LONGEST = 18_000;
/** Series checked ahead of readers in MangaDex's Popular and Updated, when it's browsed: their first 12 lots. */
export const WARM = 120;
/** The most places one search asks. */
const MOST_PLACES = 50;

/** What a reader searches for, everywhere. */
export interface Wanted {
  q?: string;
  lang?: string;
  sort?: MangaSort;
  adult: boolean;
  /** 18+ series alone (adult is on too). */
  adultOnly?: boolean;
  doujinshi: boolean;
  /** At least one. */
  kinds: MangaKind[];
  /** Only series going by one of these names (seriesName keys): a series' sheet looking for its other copies. */
  names?: string[];
}

/** A series of this kind is one a search wants. One of no known kind is wanted only with every kind. */
export function wantedKind(kind: MangaKind | null, w: Wanted): boolean {
  if (kind === null) return w.kinds.length === MANGA_KINDS.length;
  return w.kinds.includes(kind);
}

/** A series going by these names is one a search wants: any, unless it asked for some names only. */
export function wantedName(titles: string[], w: { names?: string[] }): boolean {
  if (!w.names) return true;
  for (const t of titles) {
    if (w.names.includes(seriesName(t).key)) return true;
  }
  return false;
}

/** Words this short ("no", "wa") say too little on their own: a search of only these goes by its whole name. */
const SHORT = 3;

/** A search's words, keyed as names are (seriesName). */
function wordsOf(q: string): string[] {
  const parts = q.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const out: string[] = [];
  for (const p of parts) {
    const k = seriesName(p).key;
    if (k.length >= SHORT && k !== 'the' && !out.includes(k)) out.push(k);
  }
  return out;
}

/**
 * A series going by these names (seriesName keys) is one a search by name wants: one of them has
 * the whole of it, or every word of it, or half its words and its longest. A site's search that
 * also turns up whatever's like it in some way (MangaFire's does) loses what isn't.
 */
export function namedLike(q: string, names: Iterable<string>): boolean {
  const whole = seriesName(q).key;
  if (!whole) return true;
  const words = wordsOf(q);
  let longest = '';
  for (const w of words) if (w.length > longest.length) longest = w;
  for (const n of names) {
    if (n.includes(whole)) return true;
    if (!words.length) continue;
    let hit = 0;
    for (const w of words) if (n.includes(w)) hit += 1;
    if (hit === words.length || (hit * 2 >= words.length && n.includes(longest))) return true;
  }
  return false;
}

/** What a place finds: a card of some kind, or of none known, and set aside (a doujinshi) or not. */
export interface Findable {
  card: { side: boolean; kind: string | null };
}

/** A series a place found, and the names it goes by there, to tell the same series in another place. */
export interface Found<T extends Findable = MangaFoundIn> {
  item: T;
  names: string[];
}

export interface Lot<T extends Findable = MangaFoundIn> {
  found: Found<T>[];
  /** Where that place carries on, or null when it has nothing more. */
  next: string | null;
}

/** One place a search looks. */
export interface Place<T extends Findable = MangaFoundIn> {
  /** Its part of where a search carries on: md, or sw and the source's id. */
  key: string;
  /** Shown under the title of each series it found. */
  name: string;
  /** Its next lot, from where it had got to ('0' at the start). */
  lot(at: string): Promise<Lot<T>>;
}

/** What a search found, and where it carries on, or null once every place is done. */
export interface Result<T extends Findable = MangaFoundIn> {
  items: Array<T & SeriesNames>;
  next: string | null;
}

interface Answer<T extends Findable> {
  lot: Lot<T> | null;
  /** Didn't answer in time. */
  late: boolean;
  error: unknown;
}

/** A place's lot, or that it was late or failed. */
function within<T extends Findable>(going: Promise<Lot<T>>, ms: number): Promise<Answer<T>> {
  return new Promise((done) => {
    const timer = setTimeout(() => done({ lot: null, late: true, error: null }), ms);
    going.then(
      (lot) => {
        clearTimeout(timer);
        done({ lot, late: false, error: null });
      },
      (error) => {
        clearTimeout(timer);
        done({ lot: null, late: false, error });
      },
    );
  });
}

/**
 * Each place's lot, or that it was late or failed: each waited for up to `deadline`, and once one
 * has brought something, the rest only `grace` longer. onLot: each lot as it comes, in time.
 */
function answersOf<T extends Findable>(going: Promise<Lot<T>>[], deadline: number, grace: number | null, onLot?: (i: number, lot: Lot<T>) => void): Promise<Answer<T>[]> {
  return new Promise((done) => {
    const answers: Array<Answer<T> | undefined> = going.map(() => undefined);
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    let left = going.length;
    let over = false;
    let graced = false;
    const finish = () => {
      if (over) return;
      over = true;
      for (const t of timers) clearTimeout(t);
      done(answers.map((a) => a ?? { lot: null, late: true, error: null }));
    };
    if (left === 0) {
      finish();
      return;
    }
    timers.push(setTimeout(finish, deadline));
    going.forEach((g, i) => {
      g.then(
        (lot) => {
          if (over) return;
          answers[i] = { lot, late: false, error: null };
          onLot?.(i, lot);
          left -= 1;
          if (left === 0) finish();
          else if (grace !== null && !graced && lot.found.length > 0) {
            graced = true;
            timers.push(setTimeout(finish, grace));
          }
        },
        (error) => {
          if (over) return;
          answers[i] = { lot: null, late: false, error };
          left -= 1;
          if (left === 0) finish();
        },
      );
    });
  });
}

/** Waits until the first of these lots comes or fails, or ms pass. */
function firstOf(going: Promise<unknown>[], ms: number): Promise<void> {
  return new Promise((done) => {
    const timer = setTimeout(done, ms);
    const stop = () => {
      clearTimeout(timer);
      done();
    };
    for (const g of going) {
      g.then(stop, stop);
    }
  });
}

/** Whether every place asked was late. */
function allLate(answers: Answer<Findable>[]): boolean {
  if (answers.length === 0) return false;
  for (const a of answers) {
    if (!a.late) return false;
  }
  return true;
}

/** Where each place had got to, by its key. Without next, every place from the start. */
function startsAt(places: Array<{ key: string }>, next: string | undefined): Map<string, string> {
  const at = new Map<string, string>();
  if (!next) {
    for (const p of places) at.set(p.key, '0');
    return at;
  }
  for (const part of next.split(',')) {
    const colon = part.indexOf(':');
    at.set(part.slice(0, colon), part.slice(colon + 1));
  }
  return at;
}

/** Series that go by the same name, found in one place or several. */
interface Group<T extends Findable> {
  side: boolean;
  /** The first known kind of its series: one of another kind is another series. */
  kind: string | null;
  names: Set<string>;
  places: Set<string>;
  /** Its first series' turn. */
  first: number;
  items: Array<T & SeriesNames>;
}

/**
 * What every place found, in the order a reader sees it: series grouped by name, each group's
 * cards side by side. Doujinshi and anthologies go last, and make groups of their own. strict: a
 * search by name keeps only series that go by it (namedLike), any of a group's names will do.
 */
export function rank<T extends Findable = MangaFoundIn>(q: string | undefined, lots: Array<{ place: Place<T>; found: Found<T>[] }>, strict = false): Array<T & SeriesNames> {
  // Each place's series take turns: every place's first, then every place's second, and so on.
  const turns: Array<{ found: Found<T>; place: string; at: number }> = [];
  for (let p = 0; p < lots.length; p++) {
    const { place, found } = lots[p];
    for (let i = 0; i < found.length; i++) turns.push({ found: found[i], place: place.key, at: i * lots.length + p });
  }
  turns.sort((a, b) => a.at - b.at);

  const groups: Group<T>[] = [];
  for (const turn of turns) {
    const item: T & SeriesNames = { ...turn.found.item, ...namesOf(turn.found.names) };
    const side = item.card.side;
    const kind = item.card.kind;
    const names = item.keys;
    let group = groups.find((g) => g.side === side && sameKind(g.kind, kind) && names.some((n) => g.names.has(n)));
    if (!group) {
      group = { side, kind, names: new Set(), places: new Set(), first: turn.at, items: [] };
      groups.push(group);
    }
    if (group.kind === null) group.kind = kind;
    for (const n of names) group.names.add(n);
    group.places.add(turn.place);
    group.items.push(item);
  }

  const wanted = seriesName(q ?? '').key;
  const exact = (g: Group<T>) => wanted !== '' && g.names.has(wanted);
  groups.sort((a, b) => {
    if (a.side !== b.side) {
      if (a.side) return 1;
      return -1;
    }
    if (exact(a) !== exact(b)) {
      if (exact(a)) return -1;
      return 1;
    }
    if (a.places.size !== b.places.size) return b.places.size - a.places.size;
    return a.first - b.first;
  });
  let shown = groups;
  if (strict && q) shown = groups.filter((g) => namedLike(q, g.names));
  return shown.flatMap((g) => g.items);
}

/**
 * The next lot from every place, from where next says each had got to. A place that fails is left
 * out from then on; one that's late is asked again next time. Only when every place failed is that
 * the answer. When every place is late, a lot with nothing in it would only be asked for again, so
 * it waits a while longer for the first to come. grace: null waits out the deadline for every place.
 * strict: only series going by what was searched for (rank). onSome: what's come so far, as each
 * place brings something, before the lot's whole. most: the most places asked, the first by name.
 */
export async function find<T extends Findable = MangaFoundIn>(
  places: Place<T>[],
  q: string | undefined,
  next: string | undefined,
  deadline = DEADLINE,
  grace: number | null = GRACE,
  strict = false,
  onSome?: (items: Array<T & SeriesNames>) => void,
  most = MOST_PLACES,
): Promise<Result<T>> {
  const byName = [...places].sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
  const known = byName.slice(0, most);
  const at = startsAt(known, next);
  const asked = known.filter((p) => at.has(p.key));
  const going = asked.map((p) => p.lot(at.get(p.key)!));
  // What's come so far, ranked as the whole lot will be, each time a place brings something.
  const come: Array<{ place: Place<T>; found: Found<T>[] } | null> = asked.map(() => null);
  let onLot: ((i: number, lot: Lot<T>) => void) | undefined;
  if (onSome) {
    onLot = (i, lot) => {
      if (lot.found.length === 0) return;
      come[i] = { place: asked[i], found: lot.found };
      const items = rank(q, come.filter((x) => x !== null), strict);
      if (items.length > 0) onSome(items);
    };
  }
  let answers = await answersOf(going, deadline, grace, onLot);
  if (allLate(answers)) {
    await firstOf(going, LONGEST - deadline);
    // Those come by now answer straight away; the rest are late.
    answers = await Promise.all(going.map((g) => within(g, 0)));
  }

  const lots: Array<{ place: Place<T>; found: Found<T>[] }> = [];
  const carry: string[] = [];
  let answered = false;
  let failed: unknown = null;
  for (let i = 0; i < asked.length; i++) {
    const place = asked[i];
    const answer = answers[i];
    if (answer.lot) {
      answered = true;
      lots.push({ place, found: answer.lot.found });
      if (answer.lot.next !== null) carry.push(`${place.key}:${answer.lot.next}`);
    } else if (answer.late) {
      answered = true;
      carry.push(`${place.key}:${at.get(place.key)}`);
    } else {
      log.warn({ err: answer.error, place: place.name }, 'a place couldn’t be searched, so the search goes on without it');
      if (failed === null) failed = answer.error;
    }
  }
  if (!answered && failed !== null) throw failed;

  let carryOn: string | null = null;
  if (carry.length > 0) carryOn = carry.join(',');
  return { items: rank(q, lots, strict), next: carryOn };
}
