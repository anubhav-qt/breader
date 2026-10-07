import { MANGA_KINDS, namesOf, sameKind, seriesName, type MangaFound, type MangaFoundIn, type MangaKind, type MangaSearchResult, type MangaSort } from '@breader/shared';
import { log } from '../log.ts';

/*
 * One search across every place Breader looks for manga: MangaDex and each source of its Suwayomi
 * server. Every place is asked at once, each for its next lot, and what they found is shown
 * together. The same series found in three places comes three times, side by side, each with the
 * names it goes by keyed (seriesName), so the app shows it as one: those whose title is what was
 * searched for first, then those found in more places, then the places taken in turn. No place
 * goes first because of what it is.
 */

/** How long a search waits for each place. One slower is asked again with the next lot, by when what it found is kept. */
const DEADLINE = 12_000;
/** The most places one search asks. */
const MOST_PLACES = 50;

/** What a reader searches for, everywhere. */
export interface Wanted {
  q?: string;
  lang?: string;
  sort?: MangaSort;
  adult: boolean;
  doujinshi: boolean;
  /** At least one. */
  kinds: MangaKind[];
}

/** A series of this kind is one a search wants. One of no known kind is wanted only with every kind. */
export function wantedKind(kind: MangaKind | null, w: Wanted): boolean {
  if (kind === null) return w.kinds.length === MANGA_KINDS.length;
  return w.kinds.includes(kind);
}

/** A series a place found, and the names it goes by there, to tell the same series in another place. */
export interface Found {
  item: MangaFoundIn;
  names: string[];
}

export interface Lot {
  found: Found[];
  /** Where that place carries on, or null when it has nothing more. */
  next: string | null;
}

/** One place a search looks. */
export interface Place {
  /** Its part of where a search carries on: md, or sw and the source's id. */
  key: string;
  /** Shown under the title of each series it found. */
  name: string;
  /** Its next lot, from where it had got to ('0' at the start). */
  lot(at: string): Promise<Lot>;
}

interface Answer {
  lot: Lot | null;
  /** Didn't answer in time. */
  late: boolean;
  error: unknown;
}

/** A place's lot, or that it was late or failed. */
function within(going: Promise<Lot>, ms: number): Promise<Answer> {
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

/** Where each place had got to, by its key. Without next, every place from the start. */
function startsAt(places: Place[], next: string | undefined): Map<string, string> {
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
interface Group {
  side: boolean;
  /** The first known kind of its series: one of another kind is another series. */
  kind: MangaKind | null;
  names: Set<string>;
  places: Set<string>;
  /** Its first series' turn. */
  first: number;
  items: MangaFound[];
}

/**
 * What every place found, in the order a reader sees it: series grouped by name, each group's
 * cards side by side. Doujinshi and anthologies go last, and make groups of their own.
 */
export function rank(q: string | undefined, lots: Array<{ place: Place; found: Found[] }>): MangaFound[] {
  // Each place's series take turns: every place's first, then every place's second, and so on.
  const turns: Array<{ found: Found; place: string; at: number }> = [];
  for (let p = 0; p < lots.length; p++) {
    const { place, found } = lots[p];
    for (let i = 0; i < found.length; i++) turns.push({ found: found[i], place: place.key, at: i * lots.length + p });
  }
  turns.sort((a, b) => a.at - b.at);

  const groups: Group[] = [];
  for (const turn of turns) {
    const item: MangaFound = { ...turn.found.item, ...namesOf(turn.found.names) };
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
  const exact = (g: Group) => wanted !== '' && g.names.has(wanted);
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
  return groups.flatMap((g) => g.items);
}

/**
 * The next lot from every place, from where next says each had got to. A place that fails is left
 * out from then on; one that's late is asked again next time. Only when every place failed is that
 * the answer.
 */
export async function find(places: Place[], q: string | undefined, next: string | undefined, deadline = DEADLINE): Promise<MangaSearchResult> {
  const byName = [...places].sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
  const known = byName.slice(0, MOST_PLACES);
  const at = startsAt(known, next);
  const asked = known.filter((p) => at.has(p.key));
  const answers = await Promise.all(asked.map((p) => within(p.lot(at.get(p.key)!), deadline)));

  const lots: Array<{ place: Place; found: Found[] }> = [];
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
  return { items: rank(q, lots), next: carryOn };
}
