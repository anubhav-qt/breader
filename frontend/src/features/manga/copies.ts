import { useEffect, useState } from 'react';
import type { MangaCopies, MangaFound, MangaGroup } from '@breader/shared/manga';
import { remoteUrl, sourceUrl } from '../../books/remote';
import { mangadex, sources, type MangaPrefs } from '../../lib/mangadex';
import { sameSeries } from './found';

/*
 * A series' copies, for its sheet (MangaSheet.tsx): everywhere it's found, by the same name looked
 * for again, and in each place each group that made most of it, its pages measured by the laptop.
 * The sharpest is read unless the reader picks another. A place's copies are asked once a visit.
 */

/** One way to read the series: a group's uploads in one place, or the place's as they come. */
export interface Copy {
  /** Its place's id and its group's: sw:44#official. */
  key: string;
  found: MangaFound;
  group: MangaGroup | null;
  chapters: number;
  /** How many chapters the series has in that place. */
  of: number;
  width: number | null;
}

/** A place the series is in, and its copies once measured. */
export type Place = { found: MangaFound; state: 'measuring' | 'failed' } | { found: MangaFound; state: 'ready'; copies: Copy[] };

/** A copy's key, from its place's id and its group's. */
export function copyKey(id: string, group: string | null): string {
  if (group === null) return id;
  return `${id}#${group}`;
}

/** The url a series is read from in this copy (books/remote.ts). */
export function urlOf(found: MangaFound, group: string | null, lang: string): string {
  if (found.kind === 'mangadex') return remoteUrl(found.card.id, lang, group);
  return sourceUrl(found.card.id, group);
}

const measured = new Map<string, Promise<MangaCopies>>();

/** A place's copies, asked once a visit. One that failed is asked again next time. */
function copiesIn(found: MangaFound, lang: string): Promise<MangaCopies> {
  let key = found.card.id;
  if (found.kind === 'mangadex') key += `:${lang}`;
  let going = measured.get(key);
  if (!going) {
    if (found.kind === 'mangadex') going = mangadex.copies(found.card.id, lang);
    else going = sources.copies(found.card.id);
    measured.set(key, going);
    going.catch(() => measured.delete(key));
  }
  return going;
}

/** The most names a search takes. */
const MOST_NAMES = 40;

/** Every name the series goes by where it was found, keyed as the server keys them (seriesName). */
function namesIn(found: MangaFound[]): string[] {
  const out: string[] = [];
  for (const f of found) {
    for (const k of f.keys) {
      if (k.length === 0 || k.length > 200) continue;
      if (!out.includes(k)) out.push(k);
    }
  }
  return out.slice(0, MOST_NAMES);
}

/**
 * The first three lots of a search for the title, which is where the same series turns up. Every
 * place is asked, each checking only series of the same name, so a slow site checks one or two.
 */
async function lookFor(title: string, names: string[], prefs: MangaPrefs): Promise<MangaFound[]> {
  let only: string[] | undefined = undefined;
  if (names.length > 0) only = names;
  const out: MangaFound[] = [];
  let next: string | undefined = undefined;
  for (let lot = 0; lot < 3; lot++) {
    const r = await mangadex.search({ q: title, lang: prefs.lang || undefined, adult: prefs.adult, doujinshi: true, names: only, next });
    out.push(...r.items);
    if (!r.next) break;
    next = r.next;
  }
  return out;
}

/**
 * The places known, with what a search found added: the same series, or a place already known
 * found again, which knows more of itself than one opened from My manga.
 */
function withFound(known: MangaFound[], items: MangaFound[]): MangaFound[] {
  const out = [...known];
  for (const f of items) {
    const at = out.findIndex((x) => x.card.id === f.card.id);
    if (at >= 0) out[at] = f;
  }
  for (const f of items) {
    if (out.some((x) => x.card.id === f.card.id)) continue;
    if (sameSeries(out, f)) out.push(f);
  }
  return out;
}

/** Wider pages first, to the nearest 50 pixels; then more of the place's chapters; then more chapters. */
function sharper(a: Copy, b: Copy): boolean {
  const aw = Math.round((a.width ?? 0) / 50);
  const bw = Math.round((b.width ?? 0) / 50);
  if (aw !== bw) return aw > bw;
  const ah = a.chapters / Math.max(1, a.of);
  const bh = b.chapters / Math.max(1, b.of);
  if (ah !== bh) return ah > bh;
  return a.chapters > b.chapters;
}

/** The copy read unless the reader picks another: the sharpest measured, an edition (Color) only when there's nothing else. */
export function sharpest(places: Place[]): Copy | null {
  let best: Copy | null = null;
  let bestEdition: Copy | null = null;
  for (const p of places) {
    if (p.state !== 'ready') continue;
    for (const c of p.copies) {
      if (c.width === null) continue;
      if (p.found.edition) {
        if (!bestEdition || sharper(c, bestEdition)) bestEdition = c;
      } else if (!best || sharper(c, best)) {
        best = c;
      }
    }
  }
  if (best) return best;
  return bestEdition;
}

/** Every copy measured, sharpest first, editions after the rest. */
export function inOrder(places: Place[]): Copy[] {
  const plain: Copy[] = [];
  const editions: Copy[] = [];
  for (const p of places) {
    if (p.state !== 'ready') continue;
    for (const c of p.copies) {
      if (p.found.edition) editions.push(c);
      else plain.push(c);
    }
  }
  const order = (a: Copy, b: Copy) => {
    if (sharper(a, b)) return -1;
    if (sharper(b, a)) return 1;
    return 0;
  };
  return [...plain.sort(order), ...editions.sort(order)];
}

/**
 * The series' places and their copies, as they're found and measured. settled: the search is done
 * and every place measured, or failed to be. lang: the language MangaDex's copies are in.
 */
export function useCopies(title: string, start: MangaFound[], prefs: MangaPrefs, lang: string): { places: Place[]; settled: boolean } {
  const [found, setFound] = useState<MangaFound[]>(start);
  const [looking, setLooking] = useState(true);
  const [answers, setAnswers] = useState<Map<string, MangaCopies | 'failed'>>(new Map());

  useEffect(() => {
    let live = true;
    lookFor(title, namesIn(start), prefs).then(
      (items) => {
        if (!live) return;
        setFound((known) => withFound(known, items));
        setLooking(false);
      },
      () => {
        if (live) setLooking(false);
      },
    );
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, prefs.lang, prefs.adult]);

  // Each place is asked once a visit (copiesIn), so asking again as more are found costs nothing.
  useEffect(() => {
    let live = true;
    for (const f of found) {
      const key = answerKey(f, lang);
      copiesIn(f, lang).then(
        (c) => {
          if (live) setAnswers((a) => new Map(a).set(key, c));
        },
        () => {
          if (live) setAnswers((a) => new Map(a).set(key, 'failed'));
        },
      );
    }
    return () => { live = false; };
  }, [found, lang]);

  const places: Place[] = found.map((f) => {
    const answer = answers.get(answerKey(f, lang));
    if (answer === undefined) return { found: f, state: 'measuring' };
    if (answer === 'failed') return { found: f, state: 'failed' };
    const copies = answer.copies.map((c) => {
      let group: string | null = null;
      if (c.group) group = c.group.id;
      return { key: copyKey(f.card.id, group), found: f, group: c.group, chapters: c.chapters, of: answer.chapters, width: c.width };
    });
    return { found: f, state: 'ready', copies };
  });
  let settled = !looking;
  for (const p of places) {
    if (p.state === 'measuring') settled = false;
  }
  return { places, settled };
}

/** Where a place's copies are kept in answers: MangaDex's by language. */
function answerKey(f: MangaFound, lang: string): string {
  if (f.kind === 'mangadex') return `${f.card.id}:${lang}`;
  return f.card.id;
}
