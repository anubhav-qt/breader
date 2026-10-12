import { useEffect, useState, useSyncExternalStore } from 'react';
import type { AiCastResponse, AiGender } from '@breader/shared/ai';
import type { BookColor } from '../../../data/colors';
import { readLocal, writeLocal } from '../../../lib/store';
import { keptCast, loadCast } from '../ai';
import { BUILT_IN, type Engine, type SamplePart, type VoiceInfo } from './catalog';
import { playSample } from './speaker';
import type { Marks, Two } from './two';

/*
 * Character voices: every person in a book read by a voice of their own, from the thirty of the
 * model picked (catalog.ts). There are no children's or old voices, so a woman, a girl or an old
 * woman has a woman's voice, and a man, a boy or an old man a man's. The marker gives everyone a
 * voice of each model (ai/tools/casting.ts) and marks each line with who says it, so a book can
 * hand every name its own voice.
 *
 * The server says who's in the book as far as the reader has read (server/src/lib/ai.ts castFor):
 * nobody they haven't heard from yet, by the names they know them by.
 *
 * A voice picked by hand or reshuffled is kept for the series the book is in, as the library has
 * it, by the person's id across the series: so they sound the same in every one of its books.
 *
 * The people with most to say so far get a colour each, for their face and their lines lit as
 * they're read; everyone else is lit in her colour or his.
 */

/** A woman, a man, or neither (anyone's voice will do). */
export type Kind = AiGender;

export const KINDS: Kind[] = ['F', 'M', 'N'];
export const KIND_NAME: Record<Kind, string> = { F: 'Woman', M: 'Man', N: 'Someone' };
export const KIND_PLURAL: Record<Kind, string> = { F: 'Women', M: 'Men', N: 'Others' };

/** A model's voices for people of a kind. */
export function voicesOf(kind: Kind, engine: Engine): VoiceInfo[] {
  let all = BUILT_IN.normal;
  if (engine === 'kokoro') all = BUILT_IN.immersive;
  if (kind === 'N') return all;
  return all.filter((v) => v.gender === kind);
}

export interface Character {
  /** Who says each line in the voice marks, in this book. */
  key: number;
  /** The same in every book of the series (AiCastMember.id): what their picks are kept by. */
  id: string;
  name: string;
  kind: Kind;
  /** How many lines they've said so far, which decides who gets the first pick of voices. */
  lines: number;
  /** The voice the AI picked for them in each model, by its id there; null until it has. */
  voice: Record<Engine, string> | null;
  /** Their own colour, for their face and their lines read aloud (--cast-0…), or -1 for their kind's. */
  color: number;
}

/** How many of the people with most to say get a colour of their own. */
export const COLORED = 8;

/**
 * The colours they get, in the order they're handed out: book colours, the ones furthest apart
 * first. Graphite reads like the text, so it's left out.
 */
const COLOR_ORDER: BookColor[] = ['ochre', 'teal', 'plum', 'clay', 'moss', 'lilac', 'sand', 'indigo', 'green', 'blush', 'sage', 'sky', 'rose'];

/** The colours for the people with most to say, the first first: never her colour or his (`two`), which everyone else is lit in. */
export function castPalette(two: Record<Two, BookColor>): BookColor[] {
  const out: BookColor[] = [];
  for (const c of COLOR_ORDER) {
    if (out.length === COLORED) break;
    if (c === two.F || c === two.M) continue;
    out.push(c);
  }
  return out;
}

function charactersOf(r: AiCastResponse | null): Character[] | null {
  if (!r) return null;
  // The people with most to say come first, and the first few get a colour each.
  return r.people.map((p, i) => {
    let color = -1;
    if (i < COLORED) color = i;
    return { key: p.key, id: p.id, name: p.name, kind: p.g, lines: p.lines, voice: p.voice, color };
  });
}

/** Each speaker's own colour by their key, for the people met so far who have one. */
export function castColors(book: string): Map<number, number> {
  const out = new Map<number, number>();
  const people = charactersOf(keptCast(book)) ?? [];
  for (const c of people) {
    if (c.color >= 0) out.set(c.key, c.color);
  }
  return out;
}

export interface BookCast {
  /** Who's in the book so far, the most to say first, or null until that's known. */
  people: Character[] | null;
  /** Still asking the server. */
  asking: boolean;
}

/**
 * Who's in the book so far: what was kept on this device at once, then the server's answer, asked
 * again each time it's shown so it keeps up with the reader.
 */
export function useBookCast(book: string): BookCast {
  const [people, setPeople] = useState<Character[] | null>(() => charactersOf(keptCast(book)));
  const [asking, setAsking] = useState(true);
  useEffect(() => {
    let live = true;
    setAsking(true);
    void loadCast(book).then((r) => {
      if (!live) return;
      if (r) setPeople(charactersOf(r));
      setAsking(false);
    });
    return () => { live = false; };
  }, [book]);
  return { people, asking };
}

interface CastState {
  /** Character voices picked over 1 voice or 2. */
  on: boolean;
  /** Each series' voices picked by hand, by character: the voice's key. */
  picks: Record<string, Record<string, string>>;
  /** Each series' voices from its last reshuffle, by character: the voice's key in each model. */
  dealt: Record<string, Record<string, Record<Engine, string>>>;
  /** How many times each series' voices were reshuffled, so the next one hands them out another way. */
  seeds: Record<string, number>;
  /** The series each book is in, as the library has it; a book in none keeps its picks to itself. */
  series: Record<string, string>;
}

const KEY = 'breader.cast.v3';
// v2 kept picks by book and by where someone was in its cast, v1 for the design round's pretend
// cast; only whether it was on carries over.
const v2 = readLocal<Partial<CastState>>('breader.cast.v2', {});
const v1 = readLocal<Partial<CastState>>('breader.cast.v1', {});
let wasOn = v1.on ?? false;
if (v2.on !== undefined) wasOn = v2.on;
let state: CastState = { on: wasOn, picks: {}, dealt: {}, seeds: {}, series: {}, ...readLocal<Partial<CastState>>(KEY, {}) };
const subs = new Set<() => void>();

function set(next: CastState) {
  state = next;
  writeLocal(KEY, state);
  subs.forEach((f) => f());
}

export function useCast(): CastState {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => { subs.delete(f); };
    },
    () => state,
  );
}

export const setCastOn = (on: boolean) => set({ ...state, on });

/** The picks as they are now, for the voice reading. */
export const castNow = () => state;

/** Where a book's picks are kept: its series, or the book itself. */
function scopeOf(book: string, s: CastState = state) {
  const series = s.series[book];
  if (series) return `series:${series}`;
  return `book:${book}`;
}

/** Puts a book in a series (seriesKey, gallery/series.ts), or none, for whose picks it shares. */
export function castInSeries(book: string, series: string | null) {
  const now = state.series[book] ?? null;
  if (now === series) return;
  const all = { ...state.series };
  if (series) all[book] = series;
  else delete all[book];
  set({ ...state, series: all });
}

/** What the voice reading starts the sentence again for: Characters on or off, and a change to the book's picks. */
export function castSig(s: CastState, book: string) {
  const scope = scopeOf(book, s);
  return JSON.stringify([s.on, s.picks[scope] ?? {}, s.dealt[scope] ?? {}]);
}

export function pickVoice(book: string, character: string, voice: string) {
  const scope = scopeOf(book);
  const mine = { ...(state.picks[scope] ?? {}), [character]: voice };
  set({ ...state, picks: { ...state.picks, [scope]: mine } });
}

/**
 * The whole series' voices handed out again, a different way, the AI's picks and the ones picked
 * by hand too: the people here by line count, so the ones with most to say get the first voices,
 * kept for them in every book of the series, and everyone else back to the AI's picks.
 */
export function reshuffle(book: string, people: Character[]) {
  const scope = scopeOf(book);
  const seed = (state.seeds[scope] ?? 0) + 1;
  const dealt: Record<string, Record<Engine, string>> = {};
  const handed: Record<Kind, number> = { F: 0, M: 0, N: 0 };
  for (const c of people) {
    const piper = voicesOf(c.kind, 'piper');
    const kokoro = voicesOf(c.kind, 'kokoro');
    const at = handed[c.kind] + seed;
    handed[c.kind] += 1;
    dealt[c.id] = { piper: piper[at % piper.length].key, kokoro: kokoro[at % kokoro.length].key };
  }
  set({ ...state, picks: { ...state.picks, [scope]: {} }, dealt: { ...state.dealt, [scope]: dealt }, seeds: { ...state.seeds, [scope]: seed } });
}

/** Whether the book's series was reshuffled since it last went back to the AI's picks. */
export function reshuffled(book: string, s: CastState = state) {
  const dealt = s.dealt[scopeOf(book, s)];
  if (!dealt) return false;
  return Object.keys(dealt).length > 0;
}

/** Back to the AI's picks in every book of the series: no reshuffles, and nothing picked by hand. */
export function aiPicks(book: string) {
  const scope = scopeOf(book);
  const picks = { ...state.picks };
  delete picks[scope];
  const dealt = { ...state.dealt };
  delete dealt[scope];
  set({ ...state, picks, dealt });
}

export interface Cast {
  c: Character;
  v: VoiceInfo;
  /** Picked by hand, rather than handed out. */
  picked: boolean;
  /** Handed out by a reshuffle, here or in another book of the series. */
  shuffled: boolean;
}

/** One of `fit` by its key, if it's there. */
const voiceIn = (fit: VoiceInfo[], key: string | undefined) => fit.find((v) => v.key === key);

/**
 * Who reads whom in a book, in a model: picked by hand, or reshuffled, in any book of the series,
 * or else the AI's pick, or, in a book marked before the AI picked voices, handed out by line
 * count, so the people with most to say get the first voices. Two share a voice only once the
 * women's or the men's run out.
 */
export function castOf(book: string, people: Character[], engine: Engine, s: CastState = state): Cast[] {
  const scope = scopeOf(book, s);
  const seed = s.seeds[scope] ?? 0;
  const picks = s.picks[scope] ?? {};
  const dealt = s.dealt[scope] ?? {};
  const handed: Record<Kind, number> = { F: 0, M: 0, N: 0 };
  const out: Cast[] = [];
  for (const c of people) {
    const fit = voicesOf(c.kind, engine);
    const own = voiceIn(fit, picks[c.id]);
    if (own) {
      out.push({ c, v: own, picked: true, shuffled: false });
      continue;
    }
    const mine = dealt[c.id];
    if (mine) {
      const again = voiceIn(fit, mine[engine]);
      if (again) {
        out.push({ c, v: again, picked: false, shuffled: true });
        continue;
      }
    }
    if (c.voice) {
      const ai = voiceIn(fit, `${engine}:${c.voice[engine]}`);
      if (ai) {
        out.push({ c, v: ai, picked: false, shuffled: false });
        continue;
      }
    }
    const at = (handed[c.kind] + seed) % fit.length;
    handed[c.kind] += 1;
    out.push({ c, v: fit[at], picked: false, shuffled: false });
  }
  return out;
}

/**
 * Each speaker's voice for reading the book aloud, by their key: as the voice sheet hands them out
 * (castOf) for the people met so far, and for anyone further on, as picked or reshuffled in
 * another book of the series, or else the AI's pick, from the voice `marks`. Without them, only
 * the people met so far. Anyone missing reads in her voice or his.
 */
export function castVoices(book: string, engine: Engine, marks: Pick<Marks, 'picks' | 'ids'> | null): Map<number, VoiceInfo> {
  const out = new Map<number, VoiceInfo>();
  if (marks) {
    const all = voicesOf('N', engine);
    const scope = scopeOf(book);
    const picks = state.picks[scope] ?? {};
    const dealt = state.dealt[scope] ?? {};
    for (const [key, id] of marks.ids) {
      let v = voiceIn(all, picks[id]);
      const mine = dealt[id];
      if (!v && mine) v = voiceIn(all, mine[engine]);
      const ai = marks.picks.get(key);
      if (!v && ai) v = voiceIn(all, `${engine}:${ai[engine]}`);
      if (v) out.set(key, v);
    }
  }
  const people = charactersOf(keptCast(book)) ?? [];
  for (const x of castOf(book, people, engine)) out.set(x.c.key, x.v);
  return out;
}

/** A voice's sample, one part of it. */
export function hearVoice(voice: VoiceInfo, part: SamplePart = 'greeting') {
  if (!voice.sample || !('parts' in voice.sample)) return null;
  return playSample(voice.sample.parts[part]);
}

/**
 * Who's speaking, pretended: the cast taking turns, a few seconds each, while the voice reads. A
 * real one comes from the marks, line by line. `people`: the most to say first.
 */
export function useSpeaking(people: Character[], playing: boolean): Character | null {
  const [turn, setTurn] = useState(0);
  useEffect(() => {
    if (!playing) return;
    const t = window.setInterval(() => setTurn((n) => n + 1), 3500);
    return () => window.clearInterval(t);
  }, [playing]);
  if (!people.length) return null;
  // Most turns go to the people with most to say.
  const order = [0, 1, 0, 2, 1, 4, 0, 3, 1, 5, 7, 0, 6, 1, 8, 9];
  const i = order[turn % order.length] % people.length;
  return people[i];
}
