import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AniCard, MangaFound } from '@breader/shared';
import { freshly } from '../lib/cache.ts';
import { log } from '../log.ts';
import { FRESH_ANYWAY, FRESH_FOR } from './covers.ts';
import { BROWSE_KINDS, type Manga } from './index.ts';
import { cardsOf, sheet, sleep } from './prefetch.ts';

/*
 * The manga walk, on the ThinkPad: never ending, whenever readers are quiet, it goes deeper into
 * Browse's lists and saves each series as its sheet asks for it (prefetch.ts): the series, every
 * place it's in, each place's chapters and sharpest copy, its cover, a source's first two chapters'
 * page links, and what AniList says of it. No pictures: those wait for a reader (keeper.ts). Every
 * answer is kept for good in the archive (lib/archive.ts) and given at once from there
 * (lib/cache.ts), so over time most series open straight away.
 *
 * It never starts over: where each list got to, and every series saved, are kept on disk. A day's
 * share is the owner's (2026-11-28): 1,500 Popular, 1,500 Top rated, 1,000 Updated and 1,000
 * Trending, then 18+ and doujinshi in the same split, then on in that split until the next day,
 * which begins at 04:00 in India, as the prefetch does. Then, after the prefetch, the update pass
 * reads the Updated lists from the top and fetches their series again, down to where the last pass
 * had got to.
 */

export const WALK_LISTS = ['popular', 'rated', 'latest', 'trending'] as const;
export type WalkList = (typeof WALK_LISTS)[number];
/** Series a day, in each list (the owner's). */
export const SHARE: Record<WalkList, number> = { popular: 1_500, rated: 1_500, latest: 1_000, trending: 1_000 };
/** Without 18+ first, then 18+ and doujinshi. */
export const SHELVES = ['all', 'adult'] as const;
export type Shelf = (typeof SHELVES)[number];
export type WalkKey = `${Shelf}:${WalkList}`;

const LANG = 'en';
/** Readers quiet this long, and the walk goes on. */
const QUIET = 20_000;
/** Between series, so a reader who comes back waits behind one series at most. */
const BREATHER = 1_000;
/** A list that failed is left alone this long. */
const REST = 3_600_000;
/** The first update pass, with no last one to stop at, reads this many series of each Updated list: a day's share. */
const FIRST_UPDATE = SHARE.latest;
/** A series that couldn't be fetched is tried again this many times, its list resting between, then let go. */
const TRIES = 3;
/** An Updated list whose every place is late is asked again this many times in the update pass, so long apart. */
const LATE_TRIES = 3;
const LATE_WAIT = 5_000;
/** The walk's day begins at 04:00 in India, 22:30 UTC, as the prefetch's (prefetch.ts). */
const DAY_SHIFT = 90 * 60_000;

/** The walk's day a moment is in. */
export function walkDay(now = Date.now()): string {
  return new Date(now + DAY_SHIFT).toISOString().slice(0, 10);
}

/** Where a list got to: the next AniList page, or the next lot of the sites' Updated list (null: from the top). */
export interface Place {
  page: number;
  next: string | null;
  /** Walked to its end: only the update pass reads it now. */
  end: boolean;
  /** Times the series it's at couldn't be fetched, one after another. */
  tries?: number;
}

export interface WalkState {
  /** The day today's counts are of (walkDay). */
  day?: string;
  /** Series saved since the day began, by list. */
  today: Partial<Record<WalkKey, number>>;
  at: Partial<Record<WalkKey, Place>>;
  /** The series the last update pass fetched, where the next one stops. */
  updated: string[];
}

/** Where the walk keeps its place and the series it saved. */
export interface WalkStore {
  load(): Promise<{ state: WalkState; seen: Set<string> }>;
  save(state: WalkState): Promise<void>;
  /** A series saved, by each id it goes by (al:<AniList id>, a site's card id). */
  saw(ids: string[]): Promise<void>;
}

export interface Turned {
  key: WalkKey;
  saved: number;
  failed: number;
}

export interface Updated {
  series: number;
  failed: number;
  minutes: number;
}

export interface Walk {
  /** One page of the list most behind its share; null when every list is walked to its end. */
  turn(signal?: AbortSignal): Promise<Turned | null>;
  /** The daily update pass. */
  update(signal?: AbortSignal): Promise<Updated>;
  /** Series saved since the day began, by list, and in all. */
  today(): Promise<{ lists: WalkState['today']; saved: number; ever: number }>;
}

export interface WalkOptions {
  store: WalkStore;
  /** Whether it may go on: readers quiet, nothing else running. Asked between series. */
  quiet?: () => boolean;
  breather?: number;
  /** Between asks of a late Updated list in the update pass. Tests go faster. */
  lateWait?: number;
}

const blank = (): WalkState => ({ today: {}, at: {}, updated: [] });
const shelfOf = (key: WalkKey) => key.split(':')[0] as Shelf;
const listOf = (key: WalkKey) => key.split(':')[1] as WalkList;
const keysOf = (shelf: Shelf) => WALK_LISTS.map((l): WalkKey => `${shelf}:${l}`);

/**
 * The list to walk next: of those not at their end or resting, the one furthest behind its share,
 * without 18+ while any of those is short of its share, then 18+; with every share met, on in the
 * same split.
 */
export function pick(state: WalkState, resting: (key: WalkKey) => boolean = () => false): WalkKey | null {
  const done = (key: WalkKey) => state.today[key] ?? 0;
  const behind = (key: WalkKey) => done(key) / SHARE[listOf(key)];
  const open = SHELVES.flatMap(keysOf).filter((k) => !state.at[k]?.end && !resting(k));
  if (open.length === 0) return null;
  let choices: WalkKey[] = [];
  for (const shelf of SHELVES) {
    choices = open.filter((k) => shelfOf(k) === shelf && behind(k) < 1);
    if (choices.length > 0) break;
  }
  if (choices.length === 0) choices = open;
  let best = choices[0];
  for (const k of choices) {
    if (behind(k) < behind(best)) best = k;
  }
  return best;
}

/** The ids a site's series goes by, one per place it's in. */
const idsOf = (card: MangaFound[]) => card.map((f) => f.card.id);

/** A series couldn't be fetched: its list rests, and it's tried again later. */
class TryLater extends Error {}

/**
 * Whether to let go of a series that couldn't be fetched, saving what it got, and go on: only once
 * it's been tried TRIES times. Until then its list rests and comes back to it.
 */
function letGo(at: Place): boolean {
  const tries = (at.tries ?? 0) + 1;
  if (tries < TRIES) {
    at.tries = tries;
    return false;
  }
  at.tries = 0;
  return true;
}

/** A new day: its counts start again. */
function dayBegins(state: WalkState, now = Date.now()): void {
  const day = walkDay(now);
  if (state.day === day) return;
  state.day = day;
  state.today = {};
}

export function makeWalk(manga: Manga, opts: WalkOptions): Walk {
  const quiet = opts.quiet ?? (() => true);
  const breather = opts.breather ?? BREATHER;
  const lateWait = opts.lateWait ?? LATE_WAIT;
  let loaded: Promise<{ state: WalkState; seen: Set<string> }> | null = null;
  const load = () => {
    if (!loaded) loaded = opts.store.load();
    return loaded;
  };
  /** Lists that failed lately, until when. */
  const resting = new Map<WalkKey, number>();
  const rests = (key: WalkKey) => (resting.get(key) ?? 0) > Date.now();

  async function saved(seen: Set<string>, ids: string[]) {
    const fresh = ids.filter((id) => !seen.has(id));
    for (const id of fresh) seen.add(id);
    if (fresh.length > 0) await opts.store.saw(fresh);
  }

  /** An AniList series: where it's read, its sheet there, and AniList's own page and cover. */
  async function aniSeries(card: AniCard, freshFor: number, adult: boolean): Promise<{ ids: string[]; failed: number; ok: boolean }> {
    let failed = 0;
    const step = async <T>(what: () => Promise<T>): Promise<T | undefined> => {
      try {
        return await what();
      } catch (err) {
        failed += 1;
        log.debug({ err }, 'a walk step failed');
        return undefined;
      }
    };
    const ids = [`al:${card.id}`];
    await step(() => manga.anilist.about(card.id, adult));
    const found = await step(() => manga.aniFound(card.id, LANG, adult));
    if (found === undefined) return { ids, failed, ok: false };
    let ok = true;
    if (found.length > 0) {
      await step(() => manga.anilist.cover(card.id, 256));
      const r = await sheet(manga, found, freshFor, adult);
      failed += r.failed;
      ok = r.ok;
      ids.push(...idsOf(found));
    }
    return { ids, failed, ok };
  }

  /** The next page of one of AniList's lists. */
  async function aniPage(key: WalkKey, at: Place, state: WalkState, seen: Set<string>, signal?: AbortSignal): Promise<Turned> {
    const out: Turned = { key, saved: 0, failed: 0 };
    const adult = shelfOf(key) === 'adult';
    const sort = listOf(key) as Exclude<WalkList, 'latest'>;
    const page = await manga.anilist.list({ sort, page: at.page, adult, adultOnly: adult, kinds: [...BROWSE_KINDS] });
    // Past AniList's last page its pages come empty. One with every series left out (kinds Browse
    // hasn't) isn't the end while AniList says there's more.
    if (page.items.length === 0) {
      if (page.more) at.page += 1;
      else at.end = true;
      return out;
    }
    let freshFor = FRESH_ANYWAY;
    if (sort !== 'trending') freshFor = FRESH_FOR[sort] ?? FRESH_ANYWAY;
    for (const card of page.items) {
      if (seen.has(`al:${card.id}`)) continue;
      if (signal?.aborted || !quiet()) return out;
      const r = await aniSeries(card, freshFor, adult);
      if (!r.ok && !letGo(at)) throw new TryLater(`AniList’s ${card.id} couldn’t be fetched`);
      at.tries = 0;
      await saved(seen, r.ids);
      out.saved += 1;
      out.failed += r.failed;
      state.today[key] = (state.today[key] ?? 0) + 1;
      await opts.store.save(state);
      await sleep(breather, signal);
    }
    at.page += 1;
    return out;
  }

  /** One of the sites' Updated lists, as Browse asks for it. */
  const latest = (adult: boolean, next: string | null) =>
    manga.search({ lang: LANG, sort: 'latest', adult, adultOnly: adult, doujinshi: adult, kinds: [...BROWSE_KINDS], next: next ?? undefined });

  /** The next lot of the sites' Updated list. */
  async function latestLot(key: WalkKey, at: Place, state: WalkState, seen: Set<string>, signal?: AbortSignal): Promise<Turned> {
    const out: Turned = { key, saved: 0, failed: 0 };
    const adult = shelfOf(key) === 'adult';
    const r = await latest(adult, at.next);
    // Every place late: it's where it was, and is asked again another turn.
    if (r.items.length === 0 && r.next !== null && r.next === at.next) return out;
    for (const card of cardsOf(r.items)) {
      if (idsOf(card).some((id) => seen.has(id))) continue;
      if (signal?.aborted || !quiet()) return out;
      const s = await sheet(manga, card, FRESH_FOR.latest ?? FRESH_ANYWAY, adult);
      if (!s.ok && !letGo(at)) throw new TryLater(`${card[0].card.id} couldn’t be fetched`);
      at.tries = 0;
      await saved(seen, idsOf(card));
      out.saved += 1;
      out.failed += s.failed;
      state.today[key] = (state.today[key] ?? 0) + 1;
      await opts.store.save(state);
      await sleep(breather, signal);
    }
    // At its end, or a place stuck where it was, which another lot wouldn't move.
    if (r.next === null || r.next === at.next) at.end = true;
    else at.next = r.next;
    return out;
  }

  return {
    async turn(signal) {
      const { state, seen } = await load();
      dayBegins(state);
      const key = pick(state, rests);
      if (!key) return null;
      let at = state.at[key];
      if (!at) {
        at = { page: 1, next: null, end: false };
        state.at[key] = at;
      }
      try {
        let out: Turned;
        if (listOf(key) === 'latest') out = await latestLot(key, at, state, seen, signal);
        else out = await aniPage(key, at, state, seen, signal);
        await opts.store.save(state);
        return out;
      } catch (err) {
        log.warn({ err, key }, 'a list couldn’t be walked just now');
        resting.set(key, Date.now() + REST);
        // Its tries, kept for when it's back.
        await opts.store.save(state).catch(() => {});
        return { key, saved: 0, failed: 1 };
      }
    },

    update(signal) {
      return freshly(async () => {
        const started = Date.now();
        const { state } = await load();
        const out: Updated = { series: 0, failed: 0, minutes: 0 };
        const last = new Set(state.updated);
        const now = new Set<string>();
        for (const shelf of SHELVES) {
          const adult = shelf === 'adult';
          let next: string | null = null;
          let read = 0;
          let late = 0;
          while (!signal?.aborted) {
            let r;
            try {
              r = await latest(adult, next);
            } catch (err) {
              out.failed += 1;
              log.warn({ err, shelf }, 'an Updated list couldn’t be read for the update pass');
              break;
            }
            // Every place late: asked again a few times before this list is left for the day.
            if (r.items.length === 0 && r.next !== null && r.next === next) {
              late += 1;
              if (late > LATE_TRIES) break;
              await sleep(lateWait, signal);
              continue;
            }
            late = 0;
            const cards = cardsOf(r.items).filter((card) => !idsOf(card).some((id) => now.has(id)));
            // A lot all fetched last time: the rest of the list hasn't changed since.
            const old = cards.filter((card) => idsOf(card).some((id) => last.has(id)));
            if (last.size > 0 && cards.length > 0 && old.length === cards.length) break;
            for (const card of cards) {
              if (signal?.aborted) break;
              const s = await sheet(manga, card, FRESH_FOR.latest ?? FRESH_ANYWAY, adult);
              for (const id of idsOf(card)) now.add(id);
              out.series += 1;
              out.failed += s.failed;
              read += 1;
              await sleep(breather, signal);
            }
            // At the end, or a place stuck where it was.
            if (r.next === null || r.next === next) break;
            if (last.size === 0 && read >= FIRST_UPDATE) break;
            next = r.next;
          }
        }
        if (!signal?.aborted) {
          state.updated = [...now];
          await opts.store.save(state);
        }
        out.minutes = Math.round((Date.now() - started) / 60_000);
        return out;
      });
    },

    async today() {
      const { state, seen } = await load();
      let saved = 0;
      for (const n of Object.values(state.today)) saved += n ?? 0;
      return { lists: { ...state.today }, saved, ever: seen.size };
    },
  };
}

/** When a reader last asked for manga (routes/manga.ts): the walk waits until they've been quiet a while. */
let readerAt = 0;

export function readerAsked(now = Date.now()): void {
  readerAt = now;
}

export function readersQuiet(now = Date.now()): boolean {
  return now - readerAt > QUIET;
}

/** The walk's place and the series it saved, on the laptop's disk: a small JSON file, and a line per id. */
export function walkFiles(dir: string): WalkStore {
  const stateFile = join(dir, 'walk.json');
  const seenFile = join(dir, 'walk-seen.txt');
  let made: Promise<unknown> | null = null;
  const ready = () => {
    if (!made) made = mkdir(dir, { recursive: true });
    return made;
  };
  const read = async (file: string) => {
    try {
      return await readFile(file, 'utf8');
    } catch {
      return '';
    }
  };
  /** One write at a time, each the whole state, so the file is never half one and half another. */
  let writing: Promise<void> = Promise.resolve();
  return {
    async load() {
      const state = blank();
      const text = await read(stateFile);
      if (text) {
        try {
          Object.assign(state, JSON.parse(text) as Partial<WalkState>);
        } catch (err) {
          log.warn({ err }, 'the walk’s place couldn’t be read; it goes on from the top, skipping what it saved');
        }
      }
      const seen = new Set<string>();
      for (const line of (await read(seenFile)).split('\n')) {
        if (line) seen.add(line);
      }
      return { state, seen };
    },
    save(state) {
      const text = JSON.stringify(state);
      // One that failed doesn't stop the next.
      writing = writing.catch(() => {}).then(async () => {
        await ready();
        const tmp = `${stateFile}.tmp`;
        await writeFile(tmp, text);
        await rename(tmp, stateFile);
      });
      return writing;
    },
    async saw(ids) {
      await ready();
      await appendFile(seenFile, ids.map((id) => `${id}\n`).join(''));
    },
  };
}
