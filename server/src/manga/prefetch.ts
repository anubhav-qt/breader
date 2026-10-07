import { MANGA_KINDS, sameKind, type MangaFound, type MangaKind, type MangaSort } from '@breader/shared';
import { freshly } from '../lib/cache.ts';
import { log } from '../log.ts';
import type { Manga } from './index.ts';

/*
 * Once a day, at 04:00 in India (22:30 UTC), Browse's first screens are fetched ahead of readers: the first
 * 50 series in each order (Popular, Updated, New, Top rated), with every kind on and with each kind
 * alone, in English and without 18+ or doujinshi, as Browse first opens. Then, for each series,
 * what its sheet asks for: the series, the other places it's in, each place's copies measured, its
 * chapters and its cover. Everything it touches is brought up to date and kept on for days
 * (lib/cache.ts), so readers are given it straight away, and what they open is fetched again
 * behind them. One call at a time, with a pause between series, so readers' own calls go first.
 */

const SORTS: MangaSort[] = ['popular', 'latest', 'new', 'rated'];
/** Every kind together, as Browse opens, and each alone. */
const KINDS: MangaKind[][] = [[...MANGA_KINDS], ...MANGA_KINDS.map((k) => [k])];
/** Series fetched in each list. */
const FIRST = 50;
/** Lots a list asks for at most, should many come short. */
const MOST_LOTS = 20;
/** The other places a series' sheet looks for it in: the first three lots of a search for its title (frontend copies.ts). */
const PLACE_LOTS = 3;
/** The most names that search takes. */
const MOST_NAMES = 40;
const LANG = 'en';
/** Between series, so a reader's calls never wait long behind these. */
const BREATHER = 1_000;

export interface Prefetched {
  lists: number;
  series: number;
  places: number;
  failed: number;
  minutes: number;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((done) => {
    const t = setTimeout(done, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); done(); }, { once: true });
  });

/** The same series as these, as the app tells it (frontend found.ts): one card in Browse. */
function sameSeries(found: MangaFound[], f: MangaFound): boolean {
  if (found.length === 0) return false;
  if (found[0].card.side !== f.card.side) return false;
  for (const x of found) {
    if (!sameKind(x.card.kind, f.card.kind)) return false;
  }
  return found.some((x) => x.keys.some((k) => f.keys.includes(k)));
}

/** What a search found, as Browse's cards: each series with every place it was found in. */
function cardsOf(items: MangaFound[]): MangaFound[][] {
  const cards: MangaFound[][] = [];
  for (const f of items) {
    const card = cards.find((c) => sameSeries(c, f));
    if (card) card.push(f);
    else cards.push([f]);
  }
  return cards;
}

/** The first 50 cards of one of Browse's lists. */
async function list(manga: Manga, sort: MangaSort, kinds: MangaKind[], signal?: AbortSignal): Promise<MangaFound[][]> {
  const items: MangaFound[] = [];
  let next: string | undefined = undefined;
  for (let lot = 0; lot < MOST_LOTS && !signal?.aborted; lot++) {
    const r = await manga.search({ lang: LANG, sort, adult: false, doujinshi: false, kinds, next });
    for (const f of r.items) {
      if (!items.some((x) => x.card.id === f.card.id)) items.push(f);
    }
    if (!r.next || cardsOf(items).length >= FIRST) break;
    // Every place late: it's where it was, and asking at once would only say so again.
    if (r.next === next && r.items.length === 0) await sleep(5_000, signal);
    next = r.next;
  }
  return cardsOf(items).slice(0, FIRST);
}

/** Every name the series goes by where it was found, as its sheet sends them (frontend copies.ts). */
function namesIn(found: MangaFound[]): string[] {
  const out: string[] = [];
  for (const f of found) {
    for (const k of f.keys) {
      if (k.length === 0 || k.length > 200) continue;
      if (!out.includes(k)) out.push(k);
    }
  }
  return out.slice(0, MOST_NAMES);
}

/** What a series' sheet asks for. Returns how many places it's in, and how many of the asks failed. */
async function sheet(manga: Manga, card: MangaFound[]): Promise<{ places: number; failed: number }> {
  let failed = 0;
  const step = async (what: () => Promise<unknown>) => {
    try {
      await what();
    } catch (err) {
      failed += 1;
      log.debug({ err }, 'a prefetch step failed');
    }
  };
  const main = card[0];
  if (main.kind === 'mangadex') await step(() => manga.series(main.card.id, false));
  else await step(() => manga.sourceSeries(main.card.id, false));

  // The other places it's in.
  const places = [...card];
  const names = namesIn(card);
  let next: string | undefined = undefined;
  for (let lot = 0; lot < PLACE_LOTS; lot++) {
    let r;
    try {
      r = await manga.search({ q: main.card.title, lang: LANG, doujinshi: true, names: names.length > 0 ? names : undefined, next });
    } catch (err) {
      failed += 1;
      log.debug({ err }, 'a prefetch step failed');
      break;
    }
    for (const f of r.items) {
      if (places.some((x) => x.card.id === f.card.id)) continue;
      if (sameSeries(places, f)) places.push(f);
    }
    if (!r.next) break;
    next = r.next;
  }

  for (const f of places) {
    const id = f.card.id;
    if (f.kind === 'mangadex') {
      const file = f.card.cover;
      if (file) {
        await step(() => manga.cover(id, file, '256'));
        await step(() => manga.cover(id, file, '512'));
      }
      await step(() => manga.chapters(id, LANG));
      await step(() => manga.copies(id, LANG));
    } else {
      if (f.card.cover) await step(() => manga.sourceCover(id));
      await step(() => manga.sourceChapters(id));
      await step(() => manga.copies(id, ''));
    }
  }
  return { places: places.length, failed };
}

/** Browse's first screens and their series, fetched ahead of readers. */
export function prefetch(manga: Manga, signal?: AbortSignal): Promise<Prefetched> {
  return freshly(async () => {
    const started = Date.now();
    const done = new Set<string>();
    const out: Prefetched = { lists: 0, series: 0, places: 0, failed: 0, minutes: 0 };
    for (const kinds of KINDS) {
      for (const sort of SORTS) {
        if (signal?.aborted) break;
        let cards: MangaFound[][];
        try {
          cards = await list(manga, sort, kinds, signal);
          out.lists += 1;
        } catch (err) {
          out.failed += 1;
          log.warn({ err, sort, kinds }, 'a list couldn’t be prefetched');
          continue;
        }
        for (const card of cards) {
          if (signal?.aborted) break;
          // A series in several lists is fetched once.
          if (card.some((f) => done.has(f.card.id))) continue;
          for (const f of card) done.add(f.card.id);
          const r = await sheet(manga, card);
          out.series += 1;
          out.places += r.places;
          out.failed += r.failed;
          await sleep(BREATHER, signal);
        }
      }
    }
    out.minutes = Math.round((Date.now() - started) / 60_000);
    return out;
  });
}

/** When it runs: 04:00 in India, quiet there, after the worker's 03:00 backup. In UTC, so the server's TZ doesn't matter. */
const AT_UTC = { hour: 22, minute: 30 };

/** How long until the next run. */
export function untilPrefetch(now = new Date()): number {
  const at = new Date(now);
  at.setUTCHours(AT_UTC.hour, AT_UTC.minute, 0, 0);
  if (at.getTime() <= now.getTime()) at.setUTCDate(at.getUTCDate() + 1);
  return at.getTime() - now.getTime();
}
