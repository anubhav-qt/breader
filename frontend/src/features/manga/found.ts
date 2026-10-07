import type { MangaFound } from '@breader/shared/manga';
import { KIND_NAME, mangadex, RATING_NAME, sources, STATUS_NAME } from '../../lib/mangadex';

/** A series a search found, as its card shows it: in Browse, and on a series' Elsewhere row. */
export interface FoundView {
  key: string;
  title: string;
  /** The quiet line under the title: where it's from, then what else is known. */
  meta: string;
  /** A MangaDex cover comes in two sizes, a source's in one. */
  cover: { src: string; srcSet: string | undefined } | null;
  adult: boolean;
}

export function viewOf(f: MangaFound): FoundView {
  if (f.kind === 'mangadex') {
    const c = f.card;
    const meta = [f.source, KIND_NAME[c.kind]];
    if (c.year) meta.push(String(c.year));
    if (c.status) meta.push(STATUS_NAME[c.status]);
    if (c.rating === 'suggestive') meta.push(RATING_NAME.suggestive);
    let cover: FoundView['cover'] = null;
    if (c.cover) {
      const small = mangadex.coverUrl(c.id, c.cover, 256);
      const big = mangadex.coverUrl(c.id, c.cover, 512);
      cover = { src: small, srcSet: `${small} 256w, ${big} 512w` };
    }
    return {
      key: c.id,
      title: c.title,
      meta: meta.join(' · '),
      cover,
      adult: c.rating === 'erotica' || c.rating === 'pornographic',
    };
  }
  const c = f.card;
  const meta = [f.source];
  if (c.kind) meta.push(KIND_NAME[c.kind]);
  if (c.status) meta.push(STATUS_NAME[c.status]);
  let cover: FoundView['cover'] = null;
  if (c.cover) cover = { src: sources.coverUrl(c.cover), srcSet: undefined };
  return { key: c.id, title: c.title, meta: meta.join(' · '), cover, adult: c.adult };
}
