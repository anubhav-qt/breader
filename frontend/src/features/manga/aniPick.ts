import { useEffect, useRef, useState } from 'react';
import { MOST_KEPT, type AniCard, type MangaFound } from '@breader/shared/manga';
import { anilist, KIND_NAME, STATUS_NAME, type MangaPrefs } from '../../lib/mangadex';
import { keyOf, shownOf, type AniShown } from './aniShown';

/*
 * A series AniList knows (Browse's Popular, Trending and Top rated, and a series' page's related and
 * similar ones), as a card. AniList knows series, not where to read them, so each is looked for on
 * the sites first (server manga/anifound.ts, kept there for everyone), those the server knows in
 * one ask a page, and only one found somewhere is shown, in its list's order, opening where it was found.
 */

/** Lookups at once, per list. */
const AT_ONCE = 4;

/** Where each was found in this tab, by its id, language and whether 18+ copies count. */
const results = new Map<string, MangaFound[]>();
const going = new Map<string, Promise<void>>();
/** When each lookup going began. */
const began = new Map<string, number>();
/** Ones that couldn't be looked up just now: left out, and looked up again the next time their list is. */
const failed = new Set<string>();

function lookup(c: AniCard, lang: string, adult: boolean): Promise<void> {
  const k = keyOf(c, lang, adult);
  if (results.has(k)) return Promise.resolve();
  let g = going.get(k);
  if (!g) {
    failed.delete(k);
    began.set(k, Date.now());
    g = anilist.found(c.id, lang, adult || c.adult).then(
      (found) => { results.set(k, found); },
      () => { failed.add(k); },
    ).finally(() => {
      going.delete(k);
      began.delete(k);
    });
    going.set(k, g);
  }
  return g;
}

/** Some cards asked of the server in one go, all with 18+ copies counting (wide) or none. */
async function askSome(cards: AniCard[], lang: string, wide: boolean): Promise<void> {
  let found: Record<string, MangaFound[]>;
  try {
    found = await anilist.foundKept(cards.map((c) => c.id), lang, wide);
  } catch {
    // Each is looked up alone instead.
    return;
  }
  for (const c of cards) {
    const f = found[c.id];
    if (f) results.set(keyOf(c, lang, wide), f);
  }
}

/** Where the server already knows the cards are read, asked in one go (MOST_KEPT at a time), so only the rest are looked up one by one. */
async function askKept(cards: AniCard[], lang: string, adult: boolean): Promise<void> {
  const narrow: AniCard[] = [];
  const wide: AniCard[] = [];
  for (const c of cards) {
    const k = keyOf(c, lang, adult);
    if (results.has(k) || going.has(k)) continue;
    if (adult || c.adult) wide.push(c);
    else narrow.push(c);
  }
  const asks: Promise<void>[] = [];
  for (let i = 0; i < narrow.length; i += MOST_KEPT) asks.push(askSome(narrow.slice(i, i + MOST_KEPT), lang, false));
  for (let i = 0; i < wide.length; i += MOST_KEPT) asks.push(askSome(wide.slice(i, i + MOST_KEPT), lang, true));
  await Promise.all(asks);
}

/** Every card looked up, those the server knows in one go, the rest AT_ONCE at a time, in order; each() after each. */
async function lookAll(cards: AniCard[], lang: string, adult: boolean, live: () => boolean, each: () => void): Promise<void> {
  await askKept(cards, lang, adult);
  if (!live()) return;
  each();
  const todo = cards.filter((c) => !results.has(keyOf(c, lang, adult)));
  let i = 0;
  const worker = async () => {
    while (live() && i < todo.length) {
      const c = todo[i++];
      await lookup(c, lang, adult);
      if (live()) each();
    }
  };
  await Promise.all(Array.from({ length: AT_ONCE }, worker));
}

/** A list's next cards looked up before they're shown, so they're ready when they are. */
export function primeFound(cards: AniCard[], prefs: MangaPrefs): Promise<void> {
  return lookAll(cards, prefs.lang, prefs.adult, () => true, () => {});
}

/**
 * A list's cards that can be read somewhere, in its order, as far as they've been looked up: one
 * still being looked for holds back those after it, so cards never jump about as they come. In a
 * long list (list says which), one that's late is left out of it instead, until it's another list
 * (shownOf). settled: every card looked up, or left out.
 */
export function useAniFound<C extends AniCard>(cards: C[], prefs: MangaPrefs, list?: string): { shown: AniShown<C>[]; settled: boolean } {
  const [, setTick] = useState(0);
  const lang = prefs.lang;
  const adult = prefs.adult;
  const late = useRef({ list, keys: new Set<string>() });
  if (late.current.list !== list) late.current = { list, keys: new Set() };

  useEffect(() => {
    let live = true;
    void lookAll(cards, lang, adult, () => live, () => setTick((t) => t + 1));
    return () => { live = false; };
  }, [cards, lang, adult]);

  let lateKeys: Set<string> | null = null;
  if (list !== undefined) lateKeys = late.current.keys;
  const { shown, settled, lateAt } = shownOf(cards, lang, adult, { results, began, failed }, lateKeys, Date.now());

  useEffect(() => {
    if (lateAt === null) return;
    const t = setTimeout(() => setTick((n) => n + 1), Math.max(0, lateAt - Date.now()));
    return () => clearTimeout(t);
  }, [lateAt]);

  return { shown, settled };
}

/** What's known of it, under its title: its kind, when it started, whether it's still going. */
export function aniMeta(card: AniCard): string {
  const parts: string[] = [];
  if (card.format !== 'Manga') parts.push(card.format);
  else if (card.kind) parts.push(KIND_NAME[card.kind]);
  if (card.year) parts.push(String(card.year));
  if (card.status) parts.push(STATUS_NAME[card.status]);
  return parts.join(' · ');
}
