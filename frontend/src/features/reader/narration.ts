import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react';
import { readLocal, writeLocal } from '../../lib/store';
import type { Loc, ViewHandle } from './FlowView';

/*
 * Reading aloud with the device's own voices (the Web Speech API): from the top of the page on
 * screen, a sentence at a time. The sentence being read is lit in the book's colour, and pages and
 * chapters turn as the voice reaches them. Turn the page or jump to a chapter while it reads, and it
 * carries on from there.
 *
 * Each view (FlowView, PdfView) says what its text is and keeps the sentence being read on screen
 * (ViewHandle.listen); this file does the speaking.
 */

/** A stretch of a chapter's block (a PDF: of the page's text) to say in one go. */
export interface Sentence {
  section: number;
  block: number;
  start: number;
  end: number;
  text: string;
}

export interface Listen {
  /** The chapter on screen (a PDF: the page). */
  at: () => number;
  /** Its sentences from the top of the page on screen to its end. */
  from: () => Promise<Sentence[]>;
  /**
   * Keeps a sentence on screen as it's read, `at` characters in: lights it, and turns the page (or
   * scrolls) when the voice reaches the next one. False when the reader has gone somewhere else.
   */
  show: (s: Sentence, at: number) => boolean;
  /** Whether that spot is on the page on screen. */
  onScreen: (s: Sentence, at: number) => boolean;
  clear: () => void;
  /** On to the next chapter (a PDF: page); false at the end of the book. */
  next: () => boolean;
}

export const canNarrate = typeof window !== 'undefined' && 'speechSynthesis' in window;

/* Sentences */

/** Voices stumble on very long utterances, and Chrome cuts some off after about fifteen seconds. */
const LONGEST = 220;
const ABBREV = /(?:^|\s)(?:mr|mrs|ms|dr|st|jr|sr|vs|etc|e\.g|i\.e|no|p|pp|vol|ch|fig)\.$/i;
const SAYABLE = /[\p{L}\p{N}]/u;

/** Splits text into sentences from `from` on, as [start, end) character ranges. */
export function sentencesIn(text: string, from: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const push = (a: number, b: number) => {
    if (!SAYABLE.test(text.slice(a, b))) return;
    // Long ones break at a comma or semicolon, or failing that a space.
    while (b - a > LONGEST) {
      const part = text.slice(a, a + LONGEST);
      const cut = Math.max(part.search(/[,;:—–][^,;:—–]*$/), part.lastIndexOf(' '));
      const at = cut > LONGEST / 3 ? a + cut + 1 : a + LONGEST;
      out.push([a, at]);
      a = at;
    }
    if (SAYABLE.test(text.slice(a, b))) out.push([a, b]);
  };
  const re = /[.!?…]+["”’)\]]*(?:\s+|$)/g;
  re.lastIndex = from;
  let start = from;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const end = m.index + m[0].length;
    if (ABBREV.test(text.slice(start, m.index + 1))) continue;
    push(start, end);
    start = end;
    if (end >= text.length) break;
  }
  if (start < text.length) push(start, text.length);
  return out;
}

/* The lit sentence, drawn with the CSS Custom Highlight API so the book's markup isn't touched. */

const HIGHLIGHT = 'narrate';
type Highlights = { set: (name: string, h: unknown) => void; delete: (name: string) => void };
const highlights = (globalThis.CSS as unknown as { highlights?: Highlights } | undefined)?.highlights;

export function light(range: Range | null) {
  if (!highlights) return;
  if (!range) { highlights.delete(HIGHLIGHT); return; }
  const H = (globalThis as unknown as { Highlight: new (...r: Range[]) => unknown }).Highlight;
  highlights.set(HIGHLIGHT, new H(range));
}

/* Voice and speed, kept on this device: every device has its own voices. */

export interface VoicePrefs {
  /** A voiceURI, or null for the device's default. */
  voice: string | null;
  rate: number;
}

const KEY = 'breader.voice.v1';
export const RATES = [0.8, 1, 1.25, 1.5, 2];

let prefs: VoicePrefs = { voice: null, rate: 1, ...readLocal<Partial<VoicePrefs>>(KEY, {}) };
const prefSubs = new Set<() => void>();
const subscribePrefs = (fn: () => void) => {
  prefSubs.add(fn);
  return () => { prefSubs.delete(fn); };
};

export function setVoicePrefs(patch: Partial<VoicePrefs>) {
  prefs = { ...prefs, ...patch };
  writeLocal(KEY, prefs);
  prefSubs.forEach((s) => s());
}

export const useVoicePrefs = () => useSyncExternalStore(subscribePrefs, () => prefs);

let voices: SpeechSynthesisVoice[] = canNarrate ? speechSynthesis.getVoices() : [];
const voiceSubs = new Set<() => void>();
if (canNarrate) {
  speechSynthesis.addEventListener?.('voiceschanged', () => {
    voices = speechSynthesis.getVoices();
    voiceSubs.forEach((s) => s());
  });
}
const subscribeVoices = (fn: () => void) => {
  voiceSubs.add(fn);
  return () => { voiceSubs.delete(fn); };
};
/** The device's voices; some browsers only list them a moment after the page loads. */
export const useVoices = () => useSyncExternalStore(subscribeVoices, () => voices);

/* Speaking */

type Said = 'done' | 'cut' | 'failed';

/** Kept here as well as in the queue: Chrome can drop an utterance's events once it's collected. */
let speaking: SpeechSynthesisUtterance | null = null;

function say(text: string, onWord: (at: number) => void): Promise<Said> {
  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(text);
    const voice = prefs.voice ? voices.find((v) => v.voiceURI === prefs.voice) : undefined;
    if (voice) { u.voice = voice; u.lang = voice.lang; }
    u.rate = prefs.rate;
    let settled = false;
    const end = (how: Said) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(guard);
      if (speaking === u) speaking = null;
      resolve(how);
    };
    // Some engines never say they've finished; don't wait on them forever.
    const guard = window.setTimeout(() => end('done'), 8_000 + (text.length * 150) / prefs.rate);
    u.onend = () => end('done');
    u.onerror = (e) => end(e.error === 'interrupted' || e.error === 'canceled' ? 'cut' : 'failed');
    u.onboundary = (e) => { if (e.name === 'word') onWord(e.charIndex); };
    speaking = u;
    speechSynthesis.speak(u);
  });
}

const pause = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

/**
 * Reads the book on screen aloud. `loc` is the reader's place, so a page turned or a chapter picked
 * by hand while it reads moves the voice there too.
 */
export function useNarration(view: RefObject<ViewHandle | null>, active: boolean, loc: Loc | null) {
  const [playing, setPlaying] = useState(false);
  const run = useRef(0);
  /** The sentence being said and how far in, for following the reader's own turns. */
  const spot = useRef<{ s: Sentence; at: number } | null>(null);
  /** The last sentence said, to carry on from after a pause when it's still on screen. */
  const last = useRef<Sentence | null>(null);
  /** Why speech was cut short: the reader moved, or changed the voice or speed. */
  const cutFor = useRef<'moved' | 'prefs' | null>(null);

  const listen = () => view.current?.listen;

  const stop = useCallback(() => {
    run.current++;
    spot.current = null;
    if (canNarrate) speechSynthesis.cancel();
    view.current?.listen?.clear();
    setPlaying(false);
  }, [view]);

  const loop = async (gen: number) => {
    const live = () => run.current === gen;
    const fresh = async () => {
      const list = (await listen()?.from()) ?? [];
      // After a pause, pick up at the sentence it stopped in if that's still on the page.
      const r = last.current;
      const i = r ? list.findIndex((s) => s.section === r.section && s.block === r.block && s.start <= r.start && r.start < s.end) : -1;
      last.current = null;
      return { list, i: Math.max(0, i) };
    };
    let { list, i } = await fresh();
    let placed = true;
    let failures = 0;
    while (live()) {
      const l = listen();
      if (!l) break;
      if (i >= list.length) {
        const was = l.at();
        if (!l.next()) break;
        // The next chapter lands after its turn; wait for it.
        let waited = 0;
        while (live() && listen()?.at() === was && waited < 4_000) { await pause(50); waited += 50; }
        if (!live()) return;
        ({ list, i } = await fresh());
        placed = true;
        continue;
      }
      const s = list[i];
      if (!l.show(s, 0) && !placed) {
        ({ list, i } = await fresh());
        placed = true;
        continue;
      }
      placed = false;
      spot.current = { s, at: 0 };
      cutFor.current = null;
      const how = await say(s.text, (at) => {
        spot.current = { s, at };
        listen()?.show(s, at);
      });
      spot.current = null;
      if (!live()) return;
      if (how === 'cut') {
        await pause(80);
        if (cutFor.current === 'moved') {
          ({ list, i } = await fresh());
          placed = true;
        }
        // Otherwise the voice or speed changed: say this one again with it.
        continue;
      }
      if (how === 'failed' && ++failures >= 3) break;
      if (how === 'done') failures = 0;
      last.current = s;
      i++;
    }
    if (live()) stop();
  };

  const play = () => {
    if (!canNarrate || !listen()) return;
    const gen = ++run.current;
    if (speechSynthesis.speaking || speechSynthesis.pending) speechSynthesis.cancel();
    speechSynthesis.resume();
    // Safari lets a page speak only from a tap; an empty line inside this one opens the way.
    speechSynthesis.speak(new SpeechSynthesisUtterance(''));
    setPlaying(true);
    void loop(gen);
  };

  const toggle = () => {
    if (!playing) { play(); return; }
    const s = spot.current;
    stop();
    if (s) last.current = s.s;
  };

  // A page turned or chapter picked by hand: carry on from the top of it.
  useEffect(() => {
    const sp = spot.current;
    const l = listen();
    if (!playing || !sp || !l || l.onScreen(sp.s, sp.at)) return;
    cutFor.current = 'moved';
    speechSynthesis.cancel();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loc]);

  // A new voice or speed takes over mid-sentence.
  const current = useVoicePrefs();
  useEffect(() => {
    if (!playing || !spot.current) return;
    cutFor.current = 'prefs';
    speechSynthesis.cancel();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  useEffect(() => {
    if (!active) stop();
    return stop;
  }, [active, stop]);

  const playingRef = useRef(playing);
  playingRef.current = playing;
  const busy = useCallback(() => playingRef.current, []);

  return { playing, toggle, busy };
}
