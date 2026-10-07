/*
 * What a series' genres and tags say, by name, as Suwayomi's sources and Komga write them (MangaDex
 * has tag ids of its own, mangadex.ts): which keep it out always, which mark it for adults, and
 * which make it a side work (a doujinshi or an anthology).
 */

const NEVER = new Set(['loli', 'lolicon', 'shota', 'shotacon']);
const ADULT = new Set(['adult', 'hentai', 'smut', 'erotica', 'pornographic']);
const SIDE = new Set(['doujinshi', 'anthology']);

function any(genres: string[], names: Set<string>): boolean {
  for (const g of genres) {
    if (names.has(g.trim().toLowerCase())) return true;
  }
  return false;
}

/** Sexual content with children: never shown. */
export function neverGenre(genres: string[]): boolean {
  return any(genres, NEVER);
}

/** For adults: shown only with 18+. */
export function adultGenre(genres: string[]): boolean {
  return any(genres, ADULT);
}

/** A doujinshi or an anthology: shown only with the Doujinshi switch, after the rest. */
export function sideGenre(genres: string[]): boolean {
  return any(genres, SIDE);
}

/** Only web links, as a source's are typed in by people. */
export function web(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol === 'https:' || u.protocol === 'http:') return u.href;
    return null;
  } catch {
    return null;
  }
}
