import { useEffect, useState, useSyncExternalStore } from 'react';
import { readLocal, writeLocal } from '../../../lib/store';
import { BUILT_IN, type SamplePart } from './catalog';
import { playSample } from './speaker';

/*
 * Character voices: every person in a book read by a voice of their own, picked from a lineup of 30
 * built in (10 men, 10 women, 3 boys, 3 girls, 2 old men, 2 old women), each kind for the people of
 * that kind. The marker's first pass lists the cast (ai/tools/cast.ts), and from then on each line
 * is marked with who says it, so a book can hand every name its own voice.
 *
 * Design round: the lineup's own voices aren't made yet, so each one here is a built-in voice's
 * sample, played higher or lower (a child's higher, an old voice lower), to hear the idea. The cast
 * is a pretend one, the same for every book, until the server says who's in each.
 */

export type Kind = 'M' | 'F' | 'boy' | 'girl' | 'oldM' | 'oldF';

export const KINDS: Kind[] = ['F', 'M', 'girl', 'boy', 'oldF', 'oldM'];
export const KIND_NAME: Record<Kind, string> = { M: 'Man', F: 'Woman', boy: 'Boy', girl: 'Girl', oldM: 'Old man', oldF: 'Old woman' };
export const KIND_PLURAL: Record<Kind, string> = { M: 'Men', F: 'Women', boy: 'Boys', girl: 'Girls', oldM: 'Old men', oldF: 'Old women' };

export interface CastVoice {
  id: string;
  name: string;
  kind: Kind;
  /** The built-in voice whose sample stands in for it, and how much higher (over 1) or lower it's played. */
  base: string;
  pitch: number;
}

const v = (id: string, name: string, kind: Kind, base: string, pitch = 1): CastVoice => ({ id, name, kind, base, pitch });

export const LINEUP: CastVoice[] = [
  v('f1', 'Kristin', 'F', 'piper:kristin'),
  v('f2', 'Heart', 'F', 'kokoro:af_heart'),
  v('f3', 'Emma', 'F', 'kokoro:bf_emma'),
  v('f4', 'Cori', 'F', 'piper:cori'),
  v('f5', 'Bella', 'F', 'kokoro:af_bella'),
  v('f6', 'Linda', 'F', 'piper:ljspeech'),
  v('f7', 'Ivy', 'F', 'piper:kristin', 1.05),
  v('f8', 'June', 'F', 'piper:cori', 0.96),
  v('f9', 'Mae', 'F', 'kokoro:af_heart', 1.04),
  v('f10', 'Rose', 'F', 'kokoro:bf_emma', 0.95),
  v('m1', 'Michael', 'M', 'kokoro:am_michael'),
  v('m2', 'George', 'M', 'kokoro:bm_george'),
  v('m3', 'Norman', 'M', 'piper:norman'),
  v('m4', 'Northern', 'M', 'piper:northern'),
  v('m5', 'Theo', 'M', 'piper:norman', 1.05),
  v('m6', 'Hugh', 'M', 'piper:northern', 0.95),
  v('m7', 'Sam', 'M', 'kokoro:am_michael', 1.05),
  v('m8', 'Will', 'M', 'kokoro:bm_george', 0.96),
  v('m9', 'Ash', 'M', 'piper:norman', 0.92),
  v('m10', 'Rafe', 'M', 'kokoro:am_michael', 0.93),
  v('b1', 'Pip', 'boy', 'kokoro:af_heart', 1.12),
  v('b2', 'Tam', 'boy', 'piper:kristin', 1.1),
  v('b3', 'Kit', 'boy', 'kokoro:am_michael', 1.28),
  v('g1', 'Lulu', 'girl', 'kokoro:af_bella', 1.2),
  v('g2', 'Wren', 'girl', 'piper:cori', 1.18),
  v('g3', 'Dot', 'girl', 'kokoro:af_heart', 1.22),
  v('o1', 'Abe', 'oldM', 'kokoro:bm_george', 0.86),
  v('o2', 'Silas', 'oldM', 'piper:norman', 0.88),
  v('o3', 'Edna', 'oldF', 'piper:ljspeech', 0.88),
  v('o4', 'Maud', 'oldF', 'kokoro:bf_emma', 0.9),
];

export const voicesOf = (kind: Kind) => LINEUP.filter((x) => x.kind === kind);
export const lineupVoice = (id: string) => LINEUP.find((x) => x.id === id);

export interface Character {
  id: string;
  name: string;
  kind: Kind;
  role: string;
  /** How many lines they have, which decides who gets the first pick of voices. */
  lines: number;
}

/** A pretend cast, for every book in this round. */
export const SAMPLE_CAST: Character[] = [
  { id: 'mira', name: 'Mira', kind: 'F', role: 'Leads the story', lines: 412 },
  { id: 'tobin', name: 'Tobin', kind: 'M', role: 'Her partner', lines: 388 },
  { id: 'sera', name: 'Sera', kind: 'F', role: 'A rival', lines: 140 },
  { id: 'garret', name: 'Garret', kind: 'M', role: 'A teacher', lines: 122 },
  { id: 'pip', name: 'Pip', kind: 'boy', role: 'A street kid', lines: 48 },
  { id: 'hesk', name: 'Old Hesk', kind: 'oldM', role: 'Keeps the inn', lines: 64 },
  { id: 'rourke', name: 'Captain Rourke', kind: 'M', role: 'The guard', lines: 40 },
  { id: 'lulu', name: 'Lulu', kind: 'girl', role: 'Pip’s sister', lines: 27 },
  { id: 'wyn', name: 'Nan Wyn', kind: 'oldF', role: 'A healer', lines: 31 },
  { id: 'ines', name: 'Ines', kind: 'F', role: 'A merchant', lines: 22 },
];

interface CastState {
  /** Character voices picked over 1 voice or 2. */
  on: boolean;
  /** Each book's voices picked by hand, by character. */
  picks: Record<string, Record<string, string>>;
  /** Each book's shuffle, for the voices handed out by themselves. */
  seeds: Record<string, number>;
}

const KEY = 'breader.cast.v1';
let state: CastState = { on: false, picks: {}, seeds: {}, ...readLocal<Partial<CastState>>(KEY, {}) };
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

export function pickVoice(book: string, character: string, voice: string) {
  const mine = { ...(state.picks[book] ?? {}), [character]: voice };
  set({ ...state, picks: { ...state.picks, [book]: mine } });
}

/** Everyone's voices handed out again, a different way, the ones picked by hand too. */
export function reshuffle(book: string) {
  const seed = (state.seeds[book] ?? 0) + 1;
  const picks = { ...state.picks };
  delete picks[book];
  set({ ...state, picks, seeds: { ...state.seeds, [book]: seed } });
}

export interface Cast {
  c: Character;
  v: CastVoice;
  /** Picked by hand, rather than handed out. */
  picked: boolean;
}

/**
 * Who reads whom in a book: picked by hand, or handed out by line count, so the people with most to
 * say get the first voices of their kind. Two of a kind share a voice only once that kind runs out.
 */
export function castOf(book: string, s: CastState = state): Cast[] {
  const seed = s.seeds[book] ?? 0;
  const picks = s.picks[book] ?? {};
  const byLines = [...SAMPLE_CAST].sort((a, b) => b.lines - a.lines);
  const handed: Record<Kind, number> = { M: 0, F: 0, boy: 0, girl: 0, oldM: 0, oldF: 0 };
  const out = new Map<string, Cast>();
  for (const c of byLines) {
    const kind = voicesOf(c.kind);
    const own = picks[c.id] ? lineupVoice(picks[c.id]) : undefined;
    if (own) {
      out.set(c.id, { c, v: own, picked: true });
      continue;
    }
    const at = (handed[c.kind] + seed) % kind.length;
    handed[c.kind] += 1;
    out.set(c.id, { c, v: kind[at], picked: false });
  }
  return SAMPLE_CAST.map((c) => out.get(c.id)!);
}

/** A lineup voice's sample: its built-in voice's, played at its own pitch. */
export function hearVoice(voice: CastVoice, part: SamplePart = 'greeting') {
  const all = [...BUILT_IN.normal, ...BUILT_IN.immersive];
  const base = all.find((x) => x.key === voice.base);
  if (!base?.sample || !('parts' in base.sample)) return null;
  const audio = playSample(base.sample.parts[part]);
  audio.preservesPitch = false;
  audio.playbackRate = voice.pitch;
  return audio;
}

/**
 * Who's speaking, pretended: the cast taking turns, a few seconds each, while the voice reads. A
 * real one comes from the marks, line by line.
 */
export function useSpeaking(book: string, playing: boolean): Cast | null {
  const cast = castOf(book, useCast());
  const [turn, setTurn] = useState(0);
  useEffect(() => {
    if (!playing) return;
    const t = window.setInterval(() => setTurn((n) => n + 1), 3500);
    return () => window.clearInterval(t);
  }, [playing]);
  if (!cast.length) return null;
  // Most turns go to the people with most to say.
  const order = [0, 1, 0, 2, 1, 4, 0, 3, 1, 5, 7, 0, 6, 1, 8, 9];
  const i = order[turn % order.length] % cast.length;
  const byLines = [...cast].sort((a, b) => b.c.lines - a.c.lines);
  return byLines[i];
}
