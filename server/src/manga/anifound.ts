import { MOST_NAMES, sameKind, sameSeries, seriesName, type AniCard, type MangaFound, type MangaSearchResult } from '@breader/shared';

/*
 * Where a series AniList knows can be read. AniList knows series, not sites, so its names are looked
 * for everywhere a search looks: its English title first, then another in Latin letters, keeping
 * series going by one of its names and of the kind AniList says it is. Found in several places, its
 * copies are one entry, as Browse groups them (frontend found.ts); the entry found in the most
 * places is the one AniList means, another of its names likely a namesake.
 */

type Search = (q: { q: string; lang?: string; adult: boolean; doujinshi: boolean; names: string[] }) => Promise<MangaSearchResult>;

/** Its names as a search looks for them (shared seriesName). */
function keysOf(card: AniCard): string[] {
  const keys: string[] = [];
  for (const n of card.names) {
    const { key } = seriesName(n);
    if (key && !keys.includes(key)) keys.push(key);
  }
  return keys.slice(0, MOST_NAMES);
}

/** Written in Latin letters: a name the sites are likely to have it by. */
const latin = (s: string) => /^[\x20-\x7e‘’“”–—]+$/.test(s);

/** Each series as one entry: each found joins the first entry it's the same series as, in order. */
function entriesOf(items: MangaFound[]): MangaFound[][] {
  const entries: MangaFound[][] = [];
  for (const f of items) {
    const entry = entries.find((e) => sameSeries(e, f));
    if (entry) entry.push(f);
    else entries.push([f]);
  }
  return entries;
}

/** Years a site's start year may be off AniList's and still be the same series. */
const YEARS_OFF = 1;

/**
 * Whether a site's series is the one AniList means: it goes by one of AniList's names whole, not
 * just one starting the same ("Vagabond - … Exhibition Catalog" isn't Vagabond), and it started
 * when AniList says, where both say.
 */
export function isCardsSeries(card: AniCard, f: MangaFound, names = keysOf(card)): boolean {
  if (!f.keys.some((k) => names.includes(k))) return false;
  const year = f.kind === 'mangadex' ? f.card.year : null;
  if (card.year && year && Math.abs(card.year - year) > YEARS_OFF) return false;
  return true;
}

/** Everywhere it was found, the first the one it opens at; none when no site has it. */
export async function copiesOfCard(card: AniCard, search: Search, lang: string | undefined, adult: boolean): Promise<MangaFound[]> {
  const names = keysOf(card);
  if (names.length === 0) return [];
  const asks = [card.title];
  const other = card.names.find((n) => n !== card.title && latin(n));
  if (other) asks.push(other);
  for (const q of asks) {
    const r = await search({ q, lang, adult, doujinshi: false, names });
    const items = r.items.filter((f) => isCardsSeries(card, f, names));
    const entries = entriesOf(items).filter((e) => !e[0].card.side && sameKind(e[0].card.kind, card.kind));
    if (entries.length === 0) continue;
    entries.sort((a, b) => b.length - a.length);
    return entries[0];
  }
  return [];
}
