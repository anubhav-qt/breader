import { AI_KINDS, type AiAt, type AiEntry, type AiFile, type AiGender, type AiVoicesResponse, type RevisitEntry, type RevisitResponse } from '@breader/shared';

/*
 * The spoiler line. An AI read the whole book (shared/src/ai.ts); a reader has read up to their
 * mark. These cut the notes there, so nothing past it ever leaves the server: who's come in by
 * then, what the book calls them by then, what's known and what's happened by then. Pure, so the
 * tests can check every edge without a database.
 */

/** Paragraph a is at or before paragraph b. */
const le = (a: readonly [number, number, ...unknown[]], b: AiAt) => a[0] < b[0] || (a[0] === b[0] && a[1] <= b[1]);
const before = (a: readonly [number, number, ...unknown[]], b: readonly [number, number, ...unknown[]]) => a[0] - b[0] || a[1] - b[1];
const at = (p: readonly [number, number, ...unknown[]]): AiAt => [p[0], p[1]];

/**
 * Where the notes stop for a reader with this mark: the paragraph they've read to, or null (all
 * of it) once they've read the book through. No mark yet means nothing's been read.
 */
export function cutAt(mark: { pos?: { section: number; block: number }; progress?: number; n?: number } | null | undefined): AiAt | null {
  if (!mark?.pos) return [0, 0];
  if ((mark.n ?? 0) >= 1 || (mark.progress ?? 0) >= 1) return null;
  return [mark.pos.section, mark.pos.block];
}

type Pinned = [number, number, string];

function upTo<T extends readonly [number, number, ...unknown[]]>(list: T[], p: AiAt | null): T[] {
  return (p ? list.filter((x) => le(x, p)) : list.slice()).sort(before);
}

const latest = <T extends readonly [number, number, ...unknown[]]>(list: T[], p: AiAt | null): T | undefined => upTo(list, p).at(-1);

/** One kind of notes (people, places or words), cut at p, with the ones revealed to be someone else folded into them. */
function cutKind(list: AiEntry[], p: AiAt | null): RevisitEntry[] {
  const index = new Map(list.map((e, i) => [e.id, i]));
  const shown = (e: AiEntry) => upTo(e.names, p).length > 0;

  // Whose entry each shown one is by p: its own, or the one it turned out to be.
  const home = (i: number): number => {
    const seen = new Set<number>();
    let cur = i;
    for (;;) {
      seen.add(cur);
      const m = list[cur].merge;
      if (!m || (p && !le(m, p))) return cur;
      const next = index.get(m[2]);
      if (next === undefined || seen.has(next) || !shown(list[next])) return cur;
      cur = next;
    }
  };

  const groups = new Map<number, AiEntry[]>();
  for (const [i, e] of list.entries()) {
    if (!shown(e)) continue;
    const h = home(i);
    groups.set(h, [...(groups.get(h) ?? []), e]);
  }

  const out: RevisitEntry[] = [];
  for (const [h, members] of groups) {
    const own = list[h];
    const names = members.flatMap((e) => upTo(e.names, p)).sort(before);
    const name = latest(own.names, p)![2];
    const also = [...new Set(names.map((n) => n[2]))].filter((n) => n !== name);
    const about = latest(own.about, p) ?? latest(members.flatMap((e) => e.about), p);
    const events = members.flatMap((e) => upTo(e.events, p)).sort(before);
    const points: Pinned[] = [...names, ...(about ? [about] : []), ...events].sort(before);
    out.push({
      key: h,
      name,
      also,
      about: about?.[2] ?? '',
      events: events.map(([s, b, t]) => [s, b, t]),
      first: at(points[0]),
      last: at(points.at(-1)!),
      seen: [...new Set(points.map((x) => x[0]))].sort((a, b) => a - b),
    });
  }
  return out.sort((a, b) => before(a.first, b.first) || a.key - b.key);
}

/** The Revisit notes a reader at p may see: nobody they haven't met, nothing they haven't read. */
export function revisitFor(f: Pick<AiFile, 'made' | 'revisit'>, p: AiAt | null): RevisitResponse {
  const cut = Object.fromEntries(AI_KINDS.map((k) => [k, cutKind(f.revisit[k], p)])) as Record<(typeof AI_KINDS)[number], RevisitEntry[]>;
  return { made: f.made, upTo: p, ...cut };
}

type Voices = AiFile['voices'];

/** How someone in the cast sounds at a paragraph, going by the reveals before it. */
function soundAt(c: Voices['cast'][number], p: AiAt): AiGender {
  let g = c.g;
  for (const ch of (c.changes ?? []).slice().sort(before)) if (le(ch, p)) g = ch[2];
  return g;
}

/**
 * The voice marks with nothing to tell: per paragraph, whose voice the narration takes (the
 * narrator's own in the first person, whose eyes we're behind in the third, null where it's
 * nobody's or nobody's a woman or a man), and the lines a woman or a man speaks. Everything
 * else (names, who says what, lines by neither) stays here; those are read as narration.
 */
export function voicesFor(f: Pick<AiFile, 'made' | 'sections' | 'voices'>): AiVoicesResponse {
  const v = f.voices;
  const narr = v.narration.slice().sort(before);
  const points = [...narr.map(at), ...v.cast.flatMap((c) => (c.changes ?? []).map(at))].sort(before);
  const narration: AiVoicesResponse['narration'] = [];
  for (const p of points) {
    const now = latest(narr, p);
    if (!now) continue;
    const who = now[2] >= 0 ? now[2] : now[3];
    const g = who >= 0 && v.cast[who] ? soundAt(v.cast[who], p) : 'N';
    const voice = g === 'N' ? null : g;
    const prev = narration.at(-1);
    if (prev && prev[0] === p[0] && prev[1] === p[1]) prev[2] = voice;
    else if (!prev || prev[2] !== voice) narration.push([p[0], p[1], voice]);
  }
  // A later change at the same paragraph can make two in a row the same again.
  const tidy = narration.filter((n, i) => i === 0 || n[2] !== narration[i - 1][2]);
  const spans = v.spans.flatMap(([s, b, start, end, g]): AiVoicesResponse['spans'] => (g === 'N' ? [] : [[s, b, start, end, g]]));
  return { made: f.made, sections: f.sections, narration: tidy, spans };
}
