import { useEffect, useRef, useState, type RefObject } from 'react';
import type { AiStatus } from '@breader/shared/ai';
import type { AiMusicResponse, MusicLink } from '@breader/shared/music';
import { api } from '../../lib/api';
import { loadMusic } from './ai';
import type { ViewHandle } from './FlowView';
import type { Sentence } from './narration';
import type { Spot } from './pacing';
import { useVoicePrefs, voicePrefs } from './voice/prefs';
import { wav } from './voice/speaker';

/*
 * Background music (shared/src/music.ts), scored the way an anime is: each scene of the book plays
 * a track from its soundtrack, or silence, from the paragraph it starts at. It plays only while the
 * book is read aloud or lit up in Immersive, never in plain reading, and only where the chapter is
 * the text the music was made for. A chapter that parses differently stays quiet.
 *
 * A track plays once, from the paragraph its scene starts at, and silence follows it until a scene
 * with another track. The music follows where the reader is, never a clock: however fast or slow
 * they read, nothing speeds up, skips or plays again.
 *
 * The music goes through Web Audio, so its loudness can be set on an iPhone too, where an audio
 * element's own volume can't be. Two decks take turns, so one scene's track fades into the next.
 * The voice keeps the media keys and the lock screen; the music never asks for them.
 */

/** Seconds one scene's track takes to fade into the next. */
const CROSSFADE = 2.5;
/** Seconds the music takes to fade away when the voice or the light stops, and to come back. */
const FADE = 0.8;
/** How often it looks where the reader is, in milliseconds. */
const EVERY = 1000;
/** A track's link is asked for again this long before it runs out, in milliseconds. */
const EARLY = 60_000;
/** Not in any scene: the book closed, or nothing has played yet. */
const NOWHERE = -2;

interface Deck {
  el: HTMLAudioElement;
  gain: GainNode;
  /** The track it holds, by its number in the book's list. */
  track: number;
  /** When its track's link runs out. */
  until: number;
  /** Has played once from a tap, so it may play again without one (iPhones). */
  unlocked: boolean;
  /** Counts its fades, so a pause waiting on an old one doesn't land on a newer one. */
  fades: number;
}

interface Graph {
  ctx: AudioContext;
  /** The music's own loudness, apart from the voice. */
  master: GainNode;
  decks: [Deck, Deck];
}

let graph: Graph | null = null;
/** The open book has music: only then does a tap wake the sound. */
let hasMusic = false;
let silence: string | null = null;

/** The scene the music is on: a cue (an index into the book's cues), -1 before the first or where the text differs. */
let heard = NOWHERE;
/** The deck with that scene's track, playing or waiting; null for silence. */
let current: Deck | null = null;
/** The deck started last, so the next one starts on the other. */
let last: Deck | null = null;
/** The voice or the light has stopped, and the music waits where it was. */
let resting = false;

function build(): Graph | null {
  if (graph) return graph;
  if (typeof AudioContext === 'undefined') return null;
  const ctx = new AudioContext();
  const master = ctx.createGain();
  master.gain.value = voicePrefs().musicVolume;
  master.connect(ctx.destination);
  const deck = (): Deck => {
    const el = new Audio();
    // The file store's links are on another address: without this, Web Audio hears only silence.
    el.crossOrigin = 'anonymous';
    el.preload = 'auto';
    const gain = ctx.createGain();
    gain.gain.value = 0;
    ctx.createMediaElementSource(el).connect(gain);
    gain.connect(master);
    return { el, gain, track: -1, until: 0, unlocked: false, fades: 0 };
  };
  graph = { ctx, master, decks: [deck(), deck()] };
  return graph;
}

/**
 * Call from the tap that starts the voice or the light: browsers only let sound start from one.
 * Each deck plays a moment, too quiet to hear, and may play again later without a tap.
 */
export function unlockMusic() {
  if (!hasMusic || !voicePrefs().music) return;
  const g = build();
  if (!g) return;
  const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
  if (session) session.type = 'playback';
  void g.ctx.resume().catch(() => {});
  silence ??= URL.createObjectURL(wav(new Float32Array(2400), 24_000));
  for (const d of g.decks) {
    if (d.unlocked || !d.el.paused) continue;
    if (!d.el.src) d.el.src = silence;
    d.el.play().then(() => {
      d.unlocked = true;
      // Its gain is down, so nothing was heard. Unless the music has started on it since, it waits again.
      if (d !== current || resting) d.el.pause();
    }, () => {});
  }
}

/** Takes a deck to a loudness over some seconds, and once it's silent, pauses it if `rest`. */
function fade(d: Deck, to: number, seconds: number, rest = false) {
  const g = graph!;
  const now = g.ctx.currentTime;
  const p = d.gain.gain;
  p.cancelScheduledValues(now);
  p.setValueAtTime(p.value, now);
  p.linearRampToValueAtTime(to, now + seconds);
  d.fades++;
  const mine = d.fades;
  if (!rest) return;
  window.setTimeout(() => {
    if (d.fades === mine) d.el.pause();
  }, seconds * 1000 + 50);
}

/** Plays a deck from where it is, fading in over some seconds. */
function begin(d: Deck, seconds: number) {
  d.el.play().then(
    () => { d.unlocked = true; },
    (e: Error) => console.warn('The browser wouldn’t play the music:', e),
  );
  fade(d, 1, seconds);
}

/** Each track's link, by book and number, kept until a minute before it runs out. */
const links = new Map<string, MusicLink>();

async function linkFor(bookId: string, n: number): Promise<MusicLink | null> {
  const key = `${bookId}:${n}`;
  const have = links.get(key);
  if (have && have.expiresAt - EARLY > Date.now()) return have;
  try {
    const link = await api.get<MusicLink>(`/v1/books/${encodeURIComponent(bookId)}/music/${n}`);
    links.set(key, link);
    return link;
  } catch {
    return null;
  }
}

/** The cue a paragraph is in: the last one at or before it, or -1 before the first. */
export function cueAt(cues: AiMusicResponse['cues'], s: { section: number; block: number }): number {
  let at = -1;
  for (let i = 0; i < cues.length; i++) {
    const [section, block] = cues[i];
    const before = section < s.section || (section === s.section && block <= s.block);
    if (!before) break;
    at = i;
  }
  return at;
}

/** The scene the reader is in: its track carries on, comes back, or fades into the next scene's. */
async function toCue(bookId: string, score: AiMusicResponse, cue: number) {
  const g = build();
  if (!g) return;
  if (g.ctx.state === 'suspended') void g.ctx.resume().catch(() => {});
  if (cue === heard) {
    if (resting) await wake(bookId);
    return;
  }
  let n = -1;
  if (cue >= 0) n = score.cues[cue][2];
  heard = cue;
  if (current && current.track === n) {
    // The next scene has the track that's on: it carries on, or stays over, never starting again.
    if (resting) await wake(bookId);
    return;
  }
  resting = false;
  const was = current;
  current = null;
  if (was) fade(was, 0, CROSSFADE, true);
  if (n < 0) return;
  const link = await linkFor(bookId, n);
  if (!link || heard !== cue) return;
  let d = g.decks[0];
  if (last === g.decks[0]) d = g.decks[1];
  last = d;
  d.track = n;
  d.until = link.expiresAt;
  d.el.src = link.url;
  current = d;
  // The voice or the light stopped while the link came: the track starts when it's back.
  if (resting) return;
  begin(d, CROSSFADE);
}

/** The voice or the light is back in the same scene: its track carries on from where it was. */
async function wake(bookId: string) {
  resting = false;
  const d = current;
  // Silence, or a track that has played to its end: silence follows it.
  if (!d || d.el.ended) return;
  if (d.until - EARLY < Date.now()) {
    const link = await linkFor(bookId, d.track);
    if (!link || current !== d || resting) return;
    const at = d.el.currentTime;
    d.until = link.expiresAt;
    d.el.src = link.url;
    d.el.currentTime = at;
  }
  begin(d, FADE);
}

/** The voice or the light stopped: the music fades away and waits where it is. */
function rest() {
  resting = true;
  if (current) fade(current, 0, FADE, true);
}

/** The book closed: the music stops, and the sound sleeps until a book wakes it again. */
function leave() {
  heard = NOWHERE;
  current = null;
  resting = false;
  const g = graph;
  if (!g) return;
  for (const d of g.decks) fade(d, 0, FADE, true);
  window.setTimeout(() => {
    if (heard !== NOWHERE) return;
    for (const d of g.decks) {
      d.el.removeAttribute('src');
      d.el.load();
    }
    void g.ctx.suspend().catch(() => {});
  }, FADE * 1000 + 100);
}

/**
 * The open book's music: on while the voice reads or the light moves, `open` the book, and the
 * reader hasn't turned it off in the voice sheet. It looks where they are about once a second.
 */
export function useMusic(
  view: RefObject<ViewHandle | null>,
  bookId: string,
  status: AiStatus,
  open: boolean,
  narration: { playing: boolean; current: () => Sentence | null },
  pacing: { running: boolean; current: () => Spot | null },
) {
  const prefs = useVoicePrefs();
  const [score, setScore] = useState<AiMusicResponse | null>(null);
  // Whether each chapter is the text the music was made for (shared printOf), as it's reached.
  const same = useRef(new Map<number, boolean>());
  useEffect(() => {
    same.current = new Map();
    if (!status.music || !status.made) { setScore(null); return; }
    let live = true;
    void loadMusic(bookId, status.made).then((m) => { if (live) setScore(m); });
    return () => { live = false; };
  }, [bookId, status.music, status.made]);

  useEffect(() => {
    hasMusic = open && !!score;
    return () => { hasMusic = false; };
  }, [open, score]);

  useEffect(() => {
    const g = graph;
    if (g) g.master.gain.setTargetAtTime(prefs.musicVolume, g.ctx.currentTime, 0.05);
  }, [prefs.musicVolume]);

  const where = useRef<() => Sentence | null>(() => null);
  where.current = () => {
    if (narration.playing) return narration.current();
    return pacing.current()?.s ?? null;
  };

  const on = open && prefs.music && !!score && (narration.playing || pacing.running);
  useEffect(() => {
    if (!on || !score) { rest(); return; }
    let live = true;
    let looking = false;
    const look = async () => {
      const s = where.current();
      if (!s || looking) return;
      looking = true;
      try {
        const known = same.current;
        if (!known.has(s.section)) {
          const print = await view.current?.listen.print?.(s.section);
          known.set(s.section, !!print && print === score.sections[s.section]);
        }
        let cue = -1;
        if (known.get(s.section)) cue = cueAt(score.cues, s);
        if (live) await toCue(bookId, score, cue);
      } finally {
        looking = false;
      }
    };
    void look();
    const t = window.setInterval(() => void look(), EVERY);
    return () => {
      live = false;
      window.clearInterval(t);
    };
  }, [on, score, bookId, view]);

  // Leaving the book, the music goes too.
  useEffect(() => {
    if (!open) { leave(); return; }
    return leave;
  }, [open]);
}
