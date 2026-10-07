import type { MangaChapter, MangaGroup } from '@breader/shared';
import type { Picture } from './disk.ts';

/*
 * A series' copies in one place, so a reader can pick the sharpest: each group that made most of
 * its chapters is one, its uploads read wherever it has them. Each copy's pages are measured on
 * one of its chapters, the same chapter in every copy when they share one.
 */

/** The most copies of a series in one place. */
const MOST_COPIES = 4;

export interface Size {
  width: number;
  height: number;
}

/** A copy, and the chapter its pages are measured on (null when none of its chapters is here). */
export interface CopyPlan {
  group: MangaGroup | null;
  chapters: number;
  sample: MangaChapter | null;
}

/** Big-endian and little-endian numbers in a file's bytes. */
const be16 = (b: Uint8Array, at: number) => (b[at] << 8) | b[at + 1];
const be32 = (b: Uint8Array, at: number) => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
const le16 = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8);
const le24 = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8) | (b[at + 2] << 16);
const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.subarray(from, to));

/** A JPEG's size, from the first frame header among its markers. */
function jpegSize(b: Uint8Array): Size | null {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1];
    // Padding before a marker.
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    // Markers that stand alone, with nothing after them.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    // A frame header, but not the Huffman, arithmetic coding or JPEG extension ones that share the range.
    const frame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (frame) return { width: be16(b, i + 7), height: be16(b, i + 5) };
    i += 2 + be16(b, i + 2);
  }
  return null;
}

/** A WebP's size, from its first chunk: lossy, lossless or extended. */
function webpSize(b: Uint8Array): Size | null {
  const chunk = ascii(b, 12, 16);
  if (chunk === 'VP8 ' && b.length >= 30) return { width: le16(b, 26) & 0x3fff, height: le16(b, 28) & 0x3fff };
  if (chunk === 'VP8L' && b.length >= 25) {
    const width = 1 + (((b[22] & 0x3f) << 8) | b[21]);
    const height = 1 + (((b[24] & 0x0f) << 10) | (b[23] << 2) | ((b[22] & 0xc0) >> 6));
    return { width, height };
  }
  if (chunk === 'VP8X' && b.length >= 30) return { width: 1 + le24(b, 24), height: 1 + le24(b, 27) };
  return null;
}

/** A picture's width and height, from the start of its file: JPEG, PNG, WebP or GIF. */
export function sizeOf(b: Uint8Array): Size | null {
  if (b.length < 24) return null;
  let size: Size | null = null;
  if (b[0] === 0xff && b[1] === 0xd8) size = jpegSize(b);
  else if (b[0] === 0x89 && ascii(b, 1, 4) === 'PNG' && ascii(b, 12, 16) === 'IHDR') size = { width: be32(b, 16), height: be32(b, 20) };
  else if (ascii(b, 0, 4) === 'GIF8') size = { width: le16(b, 6), height: le16(b, 8) };
  else if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP') size = webpSize(b);
  if (!size || size.width === 0 || size.height === 0) return null;
  return size;
}

/** Which chapter it is, as one series counts them: its number, or an extra's title. */
function keyOf(c: MangaChapter): string {
  const n = parseFloat(c.chapter ?? '');
  if (Number.isFinite(n) && n >= 0) return `n${n}`;
  return `x${(c.title ?? '').trim().toLowerCase()}`;
}

/** The one halfway along. */
function middle<T>(list: T[]): T | null {
  if (list.length === 0) return null;
  return list[Math.floor(list.length / 2)];
}

/**
 * A series' copies in one place, the group with the most chapters first: each group that made at
 * least half its chapters, read here, not on a publisher's site. When none did, the series is one
 * copy, as it comes. total: how many chapters it has there.
 */
export function copiesOf(chapters: MangaChapter[]): { total: number; plans: CopyPlan[] } {
  const all = new Set(chapters.map(keyOf));
  const made = new Map<string, { group: MangaGroup; keys: Set<string>; uploads: MangaChapter[] }>();
  for (const c of chapters) {
    if (c.external) continue;
    for (const g of c.groups) {
      let m = made.get(g.id);
      if (!m) {
        m = { group: g, keys: new Set(), uploads: [] };
        made.set(g.id, m);
      }
      m.keys.add(keyOf(c));
      m.uploads.push(c);
    }
  }
  const big = [...made.values()].filter((m) => m.keys.size * 2 >= all.size);
  big.sort((a, b) => b.keys.size - a.keys.size);
  const most = big.slice(0, MOST_COPIES);

  if (most.length === 0) {
    const here = chapters.filter((c) => !c.external);
    return { total: all.size, plans: [{ group: null, chapters: all.size, sample: middle(here) }] };
  }

  // The chapter halfway through those every copy has, so they're measured on the same pages.
  let shared = [...most[0].keys];
  for (const m of most.slice(1)) shared = shared.filter((k) => m.keys.has(k));
  const pick = middle(shared);
  const plans = most.map((m) => {
    let sample: MangaChapter | null = null;
    if (pick) sample = m.uploads.find((c) => keyOf(c) === pick) ?? null;
    if (!sample) sample = middle(m.uploads);
    return { group: m.group, chapters: m.keys.size, sample };
  });
  return { total: all.size, plans };
}

/**
 * The size of a chapter's pages: the narrower of two from its middle, so a double-page spread
 * doesn't count as one wide page. Null when neither could be measured.
 */
export async function measure(pages: number, page: (n: number) => Promise<Picture>): Promise<Size | null> {
  if (pages === 0) return null;
  const mid = Math.floor(pages / 2);
  const tries = [mid];
  if (pages > 2) tries.push(mid - 1);
  let narrowest: Size | null = null;
  for (const n of tries) {
    let size: Size | null = null;
    try {
      size = sizeOf((await page(n)).data);
    } catch {
      // The other page may still say.
    }
    if (!size) continue;
    if (!narrowest || size.width < narrowest.width) narrowest = size;
  }
  return narrowest;
}
