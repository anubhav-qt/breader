import type { ShelfItem } from '../../data/useLibrary';

/*
 * A card's names, tidied from what files say about themselves: the title without the publisher's
 * imprint or its volume, which gets a number of its own, and a subtitle kept apart; the first
 * author, not the illustrator or translator credited beside them.
 */

export interface CardNames {
  title: string;
  sub?: string;
  vol?: number;
  author: string;
  /** Others credited, left off the card. */
  more: number;
}

const VOL = /^(.+?)(?:\s*[,:(\-–—]\s*|\s+)(?:vol(?:ume)?\.?|book|part|no\.|#)\s*(\d{1,3})\)?(?:\s*[:\-–—.]\s*(.+))?$/i;
const TRAILING = /\s*[([]([^()[\]]+)[)\]]\s*$/;
const SUBTITLE = /^(.+?)(?::\s+|;\s*or,?\s+|\s+[-–—]\s+)(.+)$/;
const CREDIT = /\s*[([]?\b(?:illustrat(?:or|ed by|ions? by)|translat(?:or|ed by)|edit(?:or|ed by)|ed\.|trans\.|foreword)\b.*$/i;
const tidy = (s: string) => s.replace(/[\s,:;\-–—]+$/, '').replace(/^[\s,:;\-–—]+/, '').trim();

export function cardTitle(raw: string, seriesIndex?: number) {
  // A PDF's title is often its file's name.
  let title = raw.replace(/^microsoft \w+ - /i, '').replace(/\.(docx?|pages|pdf|epub|txt|md)$/i, '').replace(/_+/g, ' ').replace(/\s+/g, ' ').trim();
  let vol: number | undefined;
  let sub: string | undefined;
  // A bracket at the end is an imprint, a format or the volume: "(Pushkin Vertigo)", "[Light Novel]", "(Book 2)".
  for (let m = title.match(TRAILING); m && m.index! > 0; m = title.match(TRAILING)) {
    const n = m[1].match(/^(?:vol(?:ume)?\.?|book|part|no\.|#)\s*(\d{1,3})$/i);
    if (n) vol = Number(n[1]);
    title = title.slice(0, m.index);
  }
  const v = title.match(VOL);
  if (v) {
    title = v[1].replace(TRAILING, '');
    vol = Number(v[2]);
    sub = v[3] && tidy(v[3]);
  } else {
    const s = title.match(SUBTITLE);
    if (s && s[1].length >= 2) { title = s[1]; sub = tidy(s[2]); }
  }
  title = tidy(title) || raw;
  // A file's name in lower case reads as one with a capital.
  if (title === title.toLowerCase()) title = title[0].toUpperCase() + title.slice(1);
  return { title, sub: sub || undefined, vol: vol ?? seriesIndex };
}

export function cardAuthor(raw: string) {
  const parts = raw
    .split(/\s*(?:;|&|\s\/\s|\band\b|\bwith\b)\s*/i)
    .flatMap((p) => {
      // "Tolkien, J. R. R." is one name, surname first; "Tsutomu Sato, Kana Ishida" is two.
      const c = p.split(/\s*,\s*/);
      return c.length === 2 && !/\s/.test(c[0]) && !CREDIT.test(c[1]) ? [`${c[1]} ${c[0]}`] : c;
    })
    .map((p) => p.replace(CREDIT, '').trim())
    .filter(Boolean);
  return { author: parts[0] ?? '', more: Math.max(0, parts.length - 1) };
}

export const cardNames = (b: ShelfItem): CardNames => ({ ...cardTitle(b.title, b.seriesIndex), ...cardAuthor(b.author) });
