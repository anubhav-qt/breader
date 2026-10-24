import { sameSeries, type MangaFound, type MangaKind } from '@breader/shared/manga';
import { KIND_NAME, mangadex, RATING_NAME, sources, STATUS_NAME } from '../../lib/mangadex';

/*
 * The same series found in several places, or twice in one, is one entry: one card in Browse, its
 * copies listed on its page (MangaPage.tsx). Series are the same by name (shared sameSeries), when
 * both are doujinshi or neither, and their kinds don't clash.
 */

/** A series as one card: everywhere it was found, the first the one it opens at. */
export interface Entry {
  /** The first found's id, naming the card. */
  key: string;
  found: MangaFound[];
}

/** A series' card in Browse. */
export interface EntryView {
  key: string;
  title: string;
  /** The quiet line under the title: where it's from, then what else is known. */
  meta: string;
  /** A MangaDex cover comes in two sizes, a source's in one. */
  cover: { src: string; srcSet: string | undefined } | null;
  adult: boolean;
}

/** What a search found, as cards: each series joins the first card it's the same series as, in order. */
export function entriesOf(items: MangaFound[]): Entry[] {
  const entries: Entry[] = [];
  for (const f of items) {
    const entry = entries.find((e) => sameSeries(e.found, f));
    if (entry) entry.found.push(f);
    else entries.push({ key: f.card.id, found: [f] });
  }
  return entries;
}

function coverOf(f: MangaFound): EntryView['cover'] {
  if (f.kind === 'mangadex') {
    const c = f.card;
    if (!c.cover) return null;
    const small = mangadex.coverUrl(c.id, c.cover, 256);
    const big = mangadex.coverUrl(c.id, c.cover, 512);
    return { src: small, srcSet: `${small} 256w, ${big} 512w` };
  }
  if (!f.card.cover) return null;
  // The laptop makes each source's cover at both widths (server manga/covers.ts).
  const small = sources.coverUrl(`${f.card.cover}?size=256`);
  const big = sources.coverUrl(`${f.card.cover}?size=512`);
  return { src: small, srcSet: `${small} 256w, ${big} 512w` };
}

function adultOf(f: MangaFound): boolean {
  if (f.kind === 'mangadex') return f.card.rating === 'erotica' || f.card.rating === 'pornographic';
  return f.card.adult;
}

/** Where a series was found: its one site, or how many. */
function placesOf(found: MangaFound[]): string {
  const sites = new Set(found.map((f) => f.source));
  if (sites.size === 1) return found[0].source;
  return `${sites.size} sites`;
}

/** An entry's card: the first found's title, the first cover any has, and what they know between them. */
export function viewOf(e: Entry): EntryView {
  let kind: MangaKind | null = null;
  let status: string | null = null;
  let year: number | null = null;
  let suggestive = false;
  let cover: EntryView['cover'] = null;
  let adult = false;
  for (const f of e.found) {
    if (!kind && f.card.kind) kind = f.card.kind;
    if (!status && f.card.status) status = f.card.status;
    if (!cover) cover = coverOf(f);
    if (adultOf(f)) adult = true;
    if (f.kind === 'mangadex') {
      if (!year && f.card.year) year = f.card.year;
      if (f.card.rating === 'suggestive') suggestive = true;
    }
  }
  const meta = [placesOf(e.found)];
  if (kind) meta.push(KIND_NAME[kind]);
  if (year) meta.push(String(year));
  if (status) meta.push(STATUS_NAME[status]);
  if (suggestive) meta.push(RATING_NAME.suggestive);
  return { key: e.key, title: e.found[0].card.title, meta: meta.join(' · '), cover, adult };
}
