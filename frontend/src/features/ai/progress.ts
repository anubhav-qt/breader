import { useEffect, useRef, useState } from 'react';
import type { AiStatus } from '@breader/shared/ai';
import { hasKey } from '../../data/sync';
import { api } from '../../lib/api';
import { roundNow, useRound, type Fake } from '../design/round';

/*
 * How far the AI has got with one book, for the reader who turned its switch on: waiting in line,
 * being read (which pass, how far), or done, and what each of its features can do yet. The marker
 * works in this order (ai/tools/marker.ts): the cast and who speaks every line (which 2 voices and
 * character voices need), then the music, then Revisit's notes. Asked again every little while
 * wherever it shows, so a reader sees it move.
 *
 * Design round: the server only says what's ready (GET /books/:id/ai), so `fake` (design/round.ts)
 * stands in for the rest until a design is picked and the server learns to say more.
 */

export type AiFeature = 'two' | 'cast' | 'music' | 'revisit';
/** Not started, being made now, ready to use. */
export type FeatureState = 'waiting' | 'making' | 'ready';
export type AiPhase = 'cast' | 'marks' | 'music' | 'notes';

export interface AiProgress {
  stage: 'off' | 'queued' | 'working' | 'done';
  /** In line: books to go before it. */
  ahead?: number;
  /** Being read: which pass, its step, its parts done of all, and how far all of it has got. */
  phase?: AiPhase;
  step?: string;
  parts?: number;
  of?: number;
  percent?: number;
  features: Record<AiFeature, FeatureState>;
}

/** The order the features come in, as the marker makes them. */
export const FEATURES: AiFeature[] = ['two', 'cast', 'music', 'revisit'];
export const PHASES: AiPhase[] = ['cast', 'marks', 'music', 'notes'];

const OFF: AiProgress = { stage: 'off', features: { two: 'waiting', cast: 'waiting', music: 'waiting', revisit: 'waiting' } };
const DONE: AiProgress = { stage: 'done', percent: 100, features: { two: 'ready', cast: 'ready', music: 'ready', revisit: 'ready' } };

/** What each pass is doing, as the marker's status page says it. */
const STEPS: Record<AiPhase, string> = {
  cast: 'Reading the cast from the book',
  marks: 'Marking who speaks, part by part',
  music: 'Scoring the music, scene by scene',
  notes: 'Writing the notes, part by part',
};
/** How much of the whole each pass is, roughly, by how long it takes. */
const SHARE: Record<AiPhase, number> = { cast: 0.12, marks: 0.43, music: 0.2, notes: 0.25 };

/*
 * The fake book being read moves on by itself, so the asking again can be seen: through all four
 * passes in about four minutes, then round again. Each book starts somewhere of its own.
 */
const LAP_MS = 4 * 60_000;
const PARTS = 14;

function seed(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h;
}

function working(id: string, now: number): AiProgress {
  const f = ((now + (seed(id) % LAP_MS)) % LAP_MS) / LAP_MS;
  let before = 0;
  let phase: AiPhase = 'cast';
  for (const p of PHASES) {
    if (f < before + SHARE[p]) {
      phase = p;
      break;
    }
    before += SHARE[p];
  }
  const into = (f - before) / SHARE[phase];
  const parts = phase === 'cast' ? 0 : Math.floor(into * PARTS);
  const done = (p: AiPhase) => PHASES.indexOf(p) < PHASES.indexOf(phase);
  const making = (p: AiPhase) => p === phase || (p === 'marks' && phase === 'cast');
  const state = (p: AiPhase): FeatureState => {
    if (done(p)) return 'ready';
    if (making(p)) return 'making';
    return 'waiting';
  };
  return {
    stage: 'working',
    phase,
    step: STEPS[phase],
    parts,
    of: phase === 'cast' ? 0 : PARTS,
    percent: Math.min(99, Math.floor(f * 100)),
    features: { two: state('marks'), cast: state('marks'), music: state('music'), revisit: state('notes') },
  };
}

/** A pretend book's progress, for the design round. */
export function fakeProgress(id: string, on: boolean, fake: Fake, now = Date.now()): AiProgress {
  if (!on || fake === 'off') return OFF;
  if (fake === 'ready') return DONE;
  if (fake === 'queued') return { ...OFF, stage: 'queued', ahead: 1 + (seed(id) % 4) };
  return working(id, now);
}

/** What the server says today: only what's ready. Nothing yet means it's somewhere in line. */
function fromStatus(s: AiStatus): AiProgress {
  if (s.voices && s.music && s.revisit) return DONE;
  const ready = (on: boolean): FeatureState => (on ? 'ready' : 'waiting');
  const stage = s.made ? 'working' : 'queued';
  return { stage, features: { two: ready(s.voices), cast: ready(s.voices), music: ready(s.music), revisit: ready(s.revisit) } };
}

/** Asked again this often while it shows: the fake one more often, to watch it move. */
const EVERY_MS = 20_000;
const FAKE_EVERY_MS = 3_000;

/** A book's AI progress, asked again every little while for as long as it's on screen. */
export function useAiProgress(id: string, on: boolean): AiProgress {
  const { fake } = useRound();
  const [live, setLive] = useState<AiProgress>(on ? { ...OFF, stage: 'queued' } : OFF);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (fake === 'live') return;
    const t = window.setInterval(() => setNow(Date.now()), FAKE_EVERY_MS);
    return () => window.clearInterval(t);
  }, [fake]);

  useEffect(() => {
    if (fake !== 'live' || !on || !hasKey()) return;
    let alive = true;
    const ask = () => {
      if (document.hidden) return;
      api.get<AiStatus>(`/v1/books/${encodeURIComponent(id)}/ai`)
        .then((s) => { if (alive) setLive(fromStatus(s)); })
        .catch(() => { /* asked again in a moment */ });
    };
    ask();
    const t = window.setInterval(ask, EVERY_MS);
    document.addEventListener('visibilitychange', ask);
    return () => {
      alive = false;
      window.clearInterval(t);
      document.removeEventListener('visibilitychange', ask);
    };
  }, [fake, id, on]);

  if (fake !== 'live') return fakeProgress(id, on, fake, now);
  if (!on) return OFF;
  return live;
}

/** The same, once, without asking the server: for many cards at a time. */
export function progressNow(id: string, on: boolean): AiProgress | null {
  const { fake } = roundNow();
  if (fake === 'live') return null;
  return fakeProgress(id, on, fake);
}

/** In line, said as a reader would: next, or how many go first. */
export function inLine(p: AiProgress): string {
  if (p.ahead === undefined) return 'In line';
  if (p.ahead <= 1) return 'Next in line';
  return `${p.ahead} books before it`;
}

/**
 * A card's progress, for the spark in its corner: the pretend one, moving, or with the server asked
 * nothing (one ask a card would be a lot of asking), just done for a book whose switch is on.
 */
export function useCardProgress(id: string, on: boolean): AiProgress {
  const { fake } = useRound();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (fake === 'live' || !on) return;
    const t = window.setInterval(() => setNow(Date.now()), FAKE_EVERY_MS);
    return () => window.clearInterval(t);
  }, [fake, on]);
  if (fake !== 'live') return fakeProgress(id, on, fake, now);
  if (!on) return OFF;
  return DONE;
}

/**
 * Parts that just became ready, said for a few seconds: "2 voices are ready". Nothing on the first
 * look, only on a change while it's open.
 */
export function useNowReady(p: AiProgress, ms = 6000): AiFeature[] {
  const before = useRef<AiProgress | null>(null);
  const [news, setNews] = useState<AiFeature[]>([]);
  useEffect(() => {
    const was = before.current;
    before.current = p;
    if (!was) return;
    const turned = FEATURES.filter((f) => p.features[f] === 'ready' && was.features[f] !== 'ready');
    if (!turned.length) return;
    setNews(turned);
  }, [p]);
  useEffect(() => {
    if (!news.length) return;
    const t = window.setTimeout(() => setNews([]), ms);
    return () => window.clearTimeout(t);
  }, [news, ms]);
  return news;
}
