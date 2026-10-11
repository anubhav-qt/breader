import { useEffect, useState, useSyncExternalStore } from 'react';
import { readLocal, writeLocal } from '../../../lib/store';
import { BUILT_IN, type Engine, type SamplePart, type VoiceInfo } from './catalog';
import { playSample } from './speaker';

/*
 * Character voices: every person in a book read by a voice of their own, from the thirty of the
 * model picked (catalog.ts). There are no children's or old voices, so a woman, a girl or an old
 * woman has a woman's voice, and a man, a boy or an old man a man's. The marker gives everyone a
 * voice of each model (ai/tools/casting.ts) and marks each line with who says it, so a book can
 * hand every name its own voice.
 *
 * Design round: the cast is a pretend one, the same for every book, until the server says who's in
 * each, and its voices are handed out here.
 */

export type Kind = 'M' | 'F' | 'boy' | 'girl' | 'oldM' | 'oldF';

export const KINDS: Kind[] = ['F', 'M', 'girl', 'boy', 'oldF', 'oldM'];
export const KIND_NAME: Record<Kind, string> = { M: 'Man', F: 'Woman', boy: 'Boy', girl: 'Girl', oldM: 'Old man', oldF: 'Old woman' };
export const KIND_PLURAL: Record<Kind, string> = { M: 'Men', F: 'Women', boy: 'Boys', girl: 'Girls', oldM: 'Old men', oldF: 'Old women' };

/** Whose voices each kind reads with. */
const SIDE: Record<Kind, 'F' | 'M'> = { F: 'F', girl: 'F', oldF: 'F', M: 'M', boy: 'M', oldM: 'M' };

/** A model's voices for people of a kind. */
export function voicesOf(kind: Kind, engine: Engine): VoiceInfo[] {
  let all = BUILT_IN.normal;
  if (engine === 'kokoro') all = BUILT_IN.immersive;
  return all.filter((v) => v.gender === SIDE[kind]);
}

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
  /** Each book's voices picked by hand, by character: the voice's key. */
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
  v: VoiceInfo;
  /** Picked by hand, rather than handed out. */
  picked: boolean;
}

/**
 * Who reads whom in a book, in a model: picked by hand, or handed out by line count, so the people
 * with most to say get the first voices. Two share a voice only once the women's or the men's run out.
 */
export function castOf(book: string, engine: Engine, s: CastState = state): Cast[] {
  const seed = s.seeds[book] ?? 0;
  const picks = s.picks[book] ?? {};
  const byLines = [...SAMPLE_CAST].sort((a, b) => b.lines - a.lines);
  const handed = { F: 0, M: 0 };
  const out = new Map<string, Cast>();
  for (const c of byLines) {
    const fit = voicesOf(c.kind, engine);
    const own = fit.find((v) => v.key === picks[c.id]);
    if (own) {
      out.set(c.id, { c, v: own, picked: true });
      continue;
    }
    const side = SIDE[c.kind];
    const at = (handed[side] + seed) % fit.length;
    handed[side] += 1;
    out.set(c.id, { c, v: fit[at], picked: false });
  }
  return SAMPLE_CAST.map((c) => out.get(c.id)!);
}

/** A voice's sample, one part of it. */
export function hearVoice(voice: VoiceInfo, part: SamplePart = 'greeting') {
  if (!voice.sample || !('parts' in voice.sample)) return null;
  return playSample(voice.sample.parts[part]);
}

/**
 * Who's speaking, pretended: the cast taking turns, a few seconds each, while the voice reads. A
 * real one comes from the marks, line by line.
 */
export function useSpeaking(playing: boolean): Character {
  const [turn, setTurn] = useState(0);
  useEffect(() => {
    if (!playing) return;
    const t = window.setInterval(() => setTurn((n) => n + 1), 3500);
    return () => window.clearInterval(t);
  }, [playing]);
  // Most turns go to the people with most to say.
  const order = [0, 1, 0, 2, 1, 4, 0, 3, 1, 5, 7, 0, 6, 1, 8, 9];
  const i = order[turn % order.length] % SAMPLE_CAST.length;
  const byLines = [...SAMPLE_CAST].sort((a, b) => b.lines - a.lines);
  return byLines[i];
}
