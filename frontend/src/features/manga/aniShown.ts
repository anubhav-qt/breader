import type { AniCard, MangaFound } from '@breader/shared/manga';

/*
 * Which of a list's AniList cards are shown, from what's known of where each is read (aniPick.ts).
 * On its own, with nothing to fetch, so it can be tested.
 */

/** A card shown: the series, and everywhere it was found, the first the one it opens at. */
export interface AniShown<C extends AniCard> {
  card: C;
  found: MangaFound[];
}

/** How long a card still being looked for may hold back ready ones after it in a long list, before it's left out of it. */
const LATE_MS = 2_500;

/** A card's lookup, by its id, language and whether 18+ copies count. */
export const keyOf = (c: AniCard, lang: string, adult: boolean) => `${c.id}:${lang}:${adult || c.adult ? 1 : 0}`;

/** What's known of the cards' lookups, by keyOf: where each was found, when each going began, and which failed. */
export interface Known {
  results: Map<string, MangaFound[]>;
  began: Map<string, number>;
  failed: Set<string>;
}

/** Whether a card after the i-th is ready to be shown. */
function readyAfter(cards: AniCard[], i: number, lang: string, adult: boolean, known: Known): boolean {
  for (const c of cards.slice(i + 1)) {
    const found = known.results.get(keyOf(c, lang, adult));
    if (found && found.length > 0) return true;
  }
  return false;
}

/**
 * The cards shown, in order, as far as they've been looked up: one still being looked for holds
 * back those after it. late, in a long list: the cards left out of it, to which one is added that's
 * taken LATE_MS while one after it is ready. lateAt: when the one holding the rest back will be late.
 */
export function shownOf<C extends AniCard>(cards: C[], lang: string, adult: boolean, known: Known, late: Set<string> | null, now: number): { shown: AniShown<C>[]; settled: boolean; lateAt: number | null } {
  const shown: AniShown<C>[] = [];
  for (let i = 0; i < cards.length; i++) {
    const card = cards[i];
    const k = keyOf(card, lang, adult);
    if (known.failed.has(k) || late?.has(k)) continue;
    const found = known.results.get(k);
    if (found) {
      if (found.length > 0) shown.push({ card, found });
      continue;
    }
    const since = known.began.get(k);
    if (late && since !== undefined && readyAfter(cards, i, lang, adult, known)) {
      if (now - since >= LATE_MS) {
        late.add(k);
        continue;
      }
      return { shown, settled: false, lateAt: since + LATE_MS };
    }
    return { shown, settled: false, lateAt: null };
  }
  return { shown, settled: true, lateAt: null };
}
