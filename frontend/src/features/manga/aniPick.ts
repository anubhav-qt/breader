import { useEffect, useState } from 'react';
import type { AniCard, MangaFound } from '@breader/shared/manga';
import { anilist, KIND_NAME, STATUS_NAME, type MangaPrefs } from '../../lib/mangadex';

/*
 * A series AniList knows (Browse's Popular, Trending and Top rated, and a series' page's related and
 * similar ones), as a card. AniList knows series, not where to read them, so each is looked for on
 * the sites first (server manga/anifound.ts, kept there a day for everyone), and only one found
 * somewhere is shown, in its list's order, opening where it was found.
 */

/** A card shown: the series, and everywhere it was found, the first the one it opens at. */
export interface AniShown<C extends AniCard> {
  card: C;
  found: MangaFound[];
}

/** Lookups at once, per list. */
const AT_ONCE = 4;

/** Where each was found in this tab, by its id, language and whether 18+ copies count. */
const results = new Map<string, MangaFound[]>();
const going = new Map<string, Promise<void>>();
/** Ones that couldn't be looked up just now: left out, and looked up again the next time their list is. */
const failed = new Set<string>();

const keyOf = (c: AniCard, lang: string, adult: boolean) => `${c.id}:${lang}:${adult || c.adult ? 1 : 0}`;

function lookup(c: AniCard, lang: string, adult: boolean): Promise<void> {
  const k = keyOf(c, lang, adult);
  if (results.has(k)) return Promise.resolve();
  let g = going.get(k);
  if (!g) {
    failed.delete(k);
    g = anilist.found(c.id, lang, adult || c.adult).then(
      (found) => { results.set(k, found); },
      () => { failed.add(k); },
    ).finally(() => going.delete(k));
    going.set(k, g);
  }
  return g;
}

/**
 * A list's cards that can be read somewhere, in its order, as far as they've been looked up: one
 * still being looked for holds back those after it, so cards never jump about as they come.
 * settled: every card looked up.
 */
export function useAniFound<C extends AniCard>(cards: C[], prefs: MangaPrefs): { shown: AniShown<C>[]; settled: boolean } {
  const [, setTick] = useState(0);
  const lang = prefs.lang;
  const adult = prefs.adult;

  useEffect(() => {
    let live = true;
    const todo = cards.filter((c) => !results.has(keyOf(c, lang, adult)));
    let i = 0;
    const worker = async () => {
      while (live && i < todo.length) {
        const c = todo[i++];
        await lookup(c, lang, adult);
        if (live) setTick((t) => t + 1);
      }
    };
    for (let n = 0; n < AT_ONCE; n++) void worker();
    return () => { live = false; };
  }, [cards, lang, adult]);

  const shown: AniShown<C>[] = [];
  let settled = true;
  for (const card of cards) {
    const k = keyOf(card, lang, adult);
    if (failed.has(k)) continue;
    const found = results.get(k);
    if (!found) {
      settled = false;
      break;
    }
    if (found.length > 0) shown.push({ card, found });
  }
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
