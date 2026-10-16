import type { MangaChapter } from './manga.ts';

/*
 * A manga read from a catalogue, as its url in a library names it, and the chapters Read picks of
 * it: the app's to read them (frontend books/remote.ts), and the laptop's to keep every one of them
 * ahead of readers (server manga/keeper.ts), so both pick the same.
 */

/**
 * group: the group whose uploads it's read in (its copy), or null for whichever. also: the next
 * best copies elsewhere, in turn, for the chapters this one hasn't got.
 */
export type Remote =
  | { kind: 'mangadex'; series: string; lang: string; group: string | null; key: string; also: Remote[] }
  | { kind: 'source'; id: string; group: string | null; key: string; also: Remote[] };

/** The group at the end of a url, after a #. */
function groupOf(part: string | undefined): string | null {
  if (!part) return null;
  try {
    return decodeURIComponent(part);
  } catch {
    return null;
  }
}

/** One copy's url. */
function oneRemote(url: string): Remote | null {
  const md = /^mangadex:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?::([a-z]{2,3}(?:-[a-z]{2,3})?))?(?:#(.+))?$/.exec(url);
  if (md) return { kind: 'mangadex', series: md[1], lang: md[2] ?? 'en', group: groupOf(md[3]), key: md[1], also: [] };
  // A series on Breader's Suwayomi: its url is its id there.
  const source = /^(sw:[1-9]\d{0,9})(?:#(.+))?$/.exec(url);
  if (source) return { kind: 'source', id: source[1], group: groupOf(source[2]), key: source[1], also: [] };
  return null;
}

/**
 * Where a remote book is read from, by its url. `key` names it for what's kept offline. After a |,
 * each copy filling in the chapters it hasn't got (copies.ts alsoOf).
 */
export function remoteOf(url: string | undefined | null): Remote | null {
  const [first, ...rest] = (url ?? '').split('|');
  const w = oneRemote(first);
  if (!w) return null;
  for (const part of rest) {
    const also = oneRemote(part);
    if (also && also.key !== w.key && !w.also.some((x) => x.key === also.key)) w.also.push(also);
  }
  return w;
}

/** Its number: 12, 12.5; null for a oneshot or an extra. */
export function numberOf(c: { chapter: string | null }): number | null {
  const n = parseFloat(c.chapter ?? '');
  return Number.isFinite(n) && n >= 0 ? n : null;
}

const keyOf = (c: MangaChapter) => {
  const n = numberOf(c);
  return n !== null ? `n${n}` : `x${(c.title ?? '').trim().toLowerCase() || 'oneshot'}`;
};

/** By number, extras after, each as it came. */
const ofSort = (a: MangaChapter, b: MangaChapter) => {
  const x = numberOf(a);
  const y = numberOf(b);
  if (x !== null && y !== null) return x - y || a.at - b.at;
  return x !== null ? -1 : y !== null ? 1 : a.at - b.at;
};

/**
 * One upload of each chapter, in order. Of several, one that can be read here before one read on
 * its publisher's site; then the one by the group picked (the copy it's read in), where it has
 * one; then the one by the group that made the most of the series, so names and style carry on
 * from chapter to chapter; then the newest.
 */
export function pickChapters(all: MangaChapter[], prefer: string | null = null): MangaChapter[] {
  const made = new Map<string, Set<string>>();
  for (const c of all) for (const g of c.groups) {
    if (!made.has(g.id)) made.set(g.id, new Set());
    made.get(g.id)!.add(keyOf(c));
  }
  const weight = (c: MangaChapter) => Math.max(0, ...c.groups.map((g) => made.get(g.id)?.size ?? 0));
  const preferred = (c: MangaChapter) => Number(c.groups.some((g) => g.id === prefer));
  const better = (a: MangaChapter, b: MangaChapter) =>
    Number(!a.external) - Number(!b.external) || preferred(a) - preferred(b) || weight(a) - weight(b) || a.at - b.at;
  const best = new Map<string, MangaChapter>();
  for (const c of all) {
    const k = keyOf(c);
    const had = best.get(k);
    if (!had || better(c, had) > 0) best.set(k, c);
  }
  // Extras after the numbered chapters, as they came.
  return [...best.values()].sort(ofSort);
}

/** A copy filling in, its chapters picked one of each (pickChapters), and the site it's on, to credit with them. */
export interface Fill {
  site: string;
  chapters: MangaChapter[];
}

/**
 * A copy's chapters, picked one of each, with those it hasn't got (or only links to on its
 * publisher's site) from the next copies in turn, each one credited with its site. Only numbered
 * chapters fill in: extras go by their names, which sites write differently.
 */
export function filledIn(own: MangaChapter[], fills: Fill[]): MangaChapter[] {
  if (!fills.length) return own;
  const at = new Map<string, MangaChapter>();
  for (const c of own) at.set(keyOf(c), c);
  let added = false;
  for (const f of fills) {
    for (const c of f.chapters) {
      if (numberOf(c) === null || c.external) continue;
      const k = keyOf(c);
      const had = at.get(k);
      if (had && !had.external) continue;
      const groups = c.groups.length ? c.groups.map((g) => ({ ...g, name: `${g.name} · ${f.site}` })) : [{ id: f.site, name: f.site }];
      at.set(k, { ...c, groups });
      added = true;
    }
  }
  if (!added) return own;
  return [...at.values()].sort(ofSort);
}
