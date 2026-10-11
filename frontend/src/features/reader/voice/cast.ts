import { useEffect, useState, useSyncExternalStore } from 'react';
import type { AiCastResponse, AiGender } from '@breader/shared/ai';
import { readLocal, writeLocal } from '../../../lib/store';
import { keptCast, loadCast } from '../ai';
import { BUILT_IN, type Engine, type SamplePart, type VoiceInfo } from './catalog';
import { playSample } from './speaker';

/*
 * Character voices: every person in a book read by a voice of their own, from the thirty of the
 * model picked (catalog.ts). There are no children's or old voices, so a woman, a girl or an old
 * woman has a woman's voice, and a man, a boy or an old man a man's. The marker gives everyone a
 * voice of each model (ai/tools/casting.ts) and marks each line with who says it, so a book can
 * hand every name its own voice.
 *
 * The server says who's in the book as far as the reader has read (server/src/lib/ai.ts castFor):
 * nobody they haven't heard from yet, by the names they know them by.
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
  id: string;
  name: string;
  kind: Kind;
  /** How many lines they've said so far, which decides who gets the first pick of voices. */
  lines: number;
  /** The voice the AI picked for them in each model, by its id there; null until it has. */
  voice: Record<Engine, string> | null;
}

function charactersOf(r: AiCastResponse | null): Character[] | null {
  if (!r) return null;
  return r.people.map((p) => ({ id: String(p.key), name: p.name, kind: p.g, lines: p.lines, voice: p.voice }));
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
  /** Each book's voices picked by hand, by character: the voice's key. */
  picks: Record<string, Record<string, string>>;
  /** How many times each book's voices were reshuffled; none keeps the AI's picks. */
  seeds: Record<string, number>;
}

const KEY = 'breader.cast.v2';
// v1 kept picks and shuffles for the design round's pretend cast; only whether it was on carries over.
const before = readLocal<Partial<CastState>>('breader.cast.v1', {});
let state: CastState = { on: before.on ?? false, picks: {}, seeds: {}, ...readLocal<Partial<CastState>>(KEY, {}) };
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

export function pickVoice(book: string, character: string, voice: string) {
  const mine = { ...(state.picks[book] ?? {}), [character]: voice };
  set({ ...state, picks: { ...state.picks, [book]: mine } });
}

/** Everyone's voices handed out again, a different way, the AI's picks and the ones picked by hand too. */
export function reshuffle(book: string) {
  const seed = (state.seeds[book] ?? 0) + 1;
  const picks = { ...state.picks };
  delete picks[book];
  set({ ...state, picks, seeds: { ...state.seeds, [book]: seed } });
}

/** Back to the AI's picks: no reshuffles, and nothing picked by hand. */
export function aiPicks(book: string) {
  const picks = { ...state.picks };
  delete picks[book];
  const seeds = { ...state.seeds };
  delete seeds[book];
  set({ ...state, picks, seeds });
}

export interface Cast {
  c: Character;
  v: VoiceInfo;
  /** Picked by hand, rather than handed out. */
  picked: boolean;
}

/**
 * Who reads whom in a book, in a model: picked by hand, or the AI's pick, or, once reshuffled,
 * handed out by line count, so the people with most to say get the first voices. Two share a voice
 * only once the women's or the men's run out.
 */
export function castOf(book: string, people: Character[], engine: Engine, s: CastState = state): Cast[] {
  const seed = s.seeds[book] ?? 0;
  const picks = s.picks[book] ?? {};
  const handed: Record<Kind, number> = { F: 0, M: 0, N: 0 };
  const out: Cast[] = [];
  for (const c of people) {
    const fit = voicesOf(c.kind, engine);
    const own = fit.find((v) => v.key === picks[c.id]);
    if (own) {
      out.push({ c, v: own, picked: true });
      continue;
    }
    let ai: VoiceInfo | undefined;
    if (c.voice) {
      const key = `${engine}:${c.voice[engine]}`;
      ai = fit.find((v) => v.key === key);
    }
    if (seed === 0 && ai) {
      out.push({ c, v: ai, picked: false });
      continue;
    }
    const at = (handed[c.kind] + seed) % fit.length;
    handed[c.kind] += 1;
    out.push({ c, v: fit[at], picked: false });
  }
  return out;
}

/**
 * Each speaker's voice for reading the book aloud, by their key: as the voice sheet hands them out
 * (castOf) for the people met so far, and the AI's pick (`picks`, from the voice marks) for anyone
 * further on. Anyone missing reads in her voice or his.
 */
export function castVoices(book: string, engine: Engine, picks: Map<number, Record<Engine, string>>): Map<number, VoiceInfo> {
  const out = new Map<number, VoiceInfo>();
  const all = voicesOf('N', engine);
  for (const [key, voice] of picks) {
    const v = all.find((x) => x.key === `${engine}:${voice[engine]}`);
    if (v) out.set(key, v);
  }
  const people = charactersOf(keptCast(book)) ?? [];
  for (const x of castOf(book, people, engine)) out.set(Number(x.c.id), x.v);
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
