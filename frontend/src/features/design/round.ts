import { useSyncExternalStore } from 'react';

/*
 * Development only: this round's designs, to choose between. Each feature has a few, switched from
 * the dashed strip (DesignBar.tsx) in the library and the reader, and kept in the link (?ai=B) and
 * on this device. `fake` stands in for the AI marker, which never runs on a dev stack, so every
 * state a book can be in can be seen: its switch off, waiting in line, being read, or done.
 *
 * Once a design is picked, the others and this file go.
 */

export const AI_DESIGNS = ['A', 'B', 'C', 'D', 'E'] as const;
export const PLAY_DESIGNS = ['A', 'B', 'C', 'D', 'E'] as const;
export const CAST_DESIGNS = ['A', 'B', 'C', 'D'] as const;
export const FAKES = ['live', 'off', 'queued', 'working', 'ready'] as const;

export type AiDesign = (typeof AI_DESIGNS)[number];
export type PlayDesign = (typeof PLAY_DESIGNS)[number];
export type CastDesign = (typeof CAST_DESIGNS)[number];
export type Fake = (typeof FAKES)[number];

/** What each design is called on the strip. */
export const NAMES = {
  ai: { A: 'Unlocks', B: 'Dot meter', C: 'Glyph', D: 'Steps', E: 'Note' },
  play: { A: 'Deck', B: 'Split', C: 'Nudge', D: 'Modes', E: 'Peek' },
  cast: { A: 'Auto', B: 'Cast list', C: 'Board', D: 'Speaking' },
} as const;

export interface Round {
  ai: AiDesign;
  play: PlayDesign;
  cast: CastDesign;
  fake: Fake;
}

const KEY = 'breader.design-round.v1';
/** The picks: the dot meter, the deck, and character voices handed out by themselves. */
const DEFAULT: Round = { ai: 'B', play: 'A', cast: 'A', fake: 'working' };
const dev = import.meta.env.DEV;

function pick<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  if (typeof v === 'string' && (allowed as readonly string[]).includes(v)) return v as T;
  return fallback;
}

function load(): Round {
  // Outside development nothing is pretend: the AI's progress is what the server says.
  if (!dev) return { ...DEFAULT, fake: 'live' };
  let saved: Partial<Round> = {};
  try {
    saved = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Round>;
  } catch {
    saved = {};
  }
  const q = new URLSearchParams(window.location.search);
  return {
    ai: pick(q.get('ai') ?? saved.ai, AI_DESIGNS, DEFAULT.ai),
    play: pick(q.get('play') ?? saved.play, PLAY_DESIGNS, DEFAULT.play),
    cast: pick(q.get('cast') ?? saved.cast, CAST_DESIGNS, DEFAULT.cast),
    fake: pick(q.get('aistate') ?? saved.fake, FAKES, DEFAULT.fake),
  };
}

let round = load();
const subs = new Set<() => void>();

/** Writes the picks into the link, so a link shows the same designs. */
function writeLink(r: Round) {
  const url = new URL(window.location.href);
  url.searchParams.set('ai', r.ai);
  url.searchParams.set('play', r.play);
  url.searchParams.set('cast', r.cast);
  url.searchParams.set('aistate', r.fake);
  window.history.replaceState(window.history.state, '', url);
}

export function setRound(patch: Partial<Round>) {
  round = { ...round, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(round));
  } catch {
    /* kept for this visit only */
  }
  writeLink(round);
  subs.forEach((f) => f());
}

export function roundNow(): Round {
  return round;
}

export function useRound(): Round {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => { subs.delete(f); };
    },
    () => round,
  );
}
