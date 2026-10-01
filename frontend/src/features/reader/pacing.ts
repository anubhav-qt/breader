import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { Loc, ViewHandle } from './FlowView';
import { lookAt, lookFor, stopLook } from './look';
import { wordMarks, wordsIn, type Sentence } from './narration';
import { voicePrefs } from './voice/prefs';

/*
 * Immersive without a voice. The page dims, and from the sentence the reader taps, the words light
 * up one after another at their pace, in words a minute (voice/prefs.ts). Pages turn and chapters
 * follow as it gets to them, as they do for a voice. For phones that can't run a voice, and for
 * anyone who'd rather read than listen. Play adds a voice, which carries on from the light. It
 * stops on each picture a moment, as a voice does (look.ts).
 */

export interface Spot {
  s: Sentence;
  /** Characters into it lit so far. */
  at: number;
}

/** The same words: a sentence, or the part of it a voice started from. Or the same picture. */
export const overlaps = (a: Sentence, b: Sentence) =>
  a.section === b.section && (a.pic !== undefined || b.pic !== undefined ? a.pic === b.pic : a.block === b.block && a.start < b.end && b.start < a.end);

/** A sentence's time at a pace: its words, and a breath after. */
const msFor = (words: number, wpm: number) => (60_000 * (words + 0.5)) / wpm;

const pause = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

/** When the last word lit, for the dot row's meter. */
let beat = -Infinity;

/** A pulse at each word that fades, 0 to 1, as the voice's level() is for sound. */
export function paceLevel() {
  const t = performance.now() - beat;
  return t < 320 ? 0.45 * (1 - t / 320) : 0;
}

export function usePacing(view: RefObject<ViewHandle | null>, active: boolean, loc: Loc | null) {
  const [running, setRunning] = useState(false);
  /** Something is lit: where it's got to, or where it stopped. */
  const [lit, setLit] = useState(false);
  const runningRef = useRef(running);
  runningRef.current = running;
  const run = useRef(0);
  const here = useRef<Spot | null>(null);
  /** On the way to the next chapter, which the page takes a moment to show. */
  const turning = useRef(false);

  const listen = () => view.current?.listen;

  /** The page follows into the next chapter, then lights where it's got to. */
  const follow = async (s: Sentence, at: number) => {
    turning.current = true;
    listen()?.reach(s, at);
    for (let waited = 0; listen()?.at() !== s.section && waited < 4_000; waited += 50) await pause(50);
    listen()?.show(s, at, true);
    turning.current = false;
  };

  /** Lights a sentence word by word from `from` characters in. False when it was stopped or moved. */
  const light = (gen: number, s: Sentence, from: number) => new Promise<boolean>((resolve) => {
    const marks = wordMarks(s.text);
    const words = Math.max(1, wordsIn(s.text));
    let f = from > 0 ? (marks.find((m) => m.at >= from)?.f ?? 0) : 0;
    let then = performance.now();
    let shown = -2;
    const tick = (now: number) => {
      const l = listen();
      if (run.current !== gen || !l) { resolve(false); return; }
      // A frame late (a hidden tab, a busy phone) doesn't jump ahead.
      const dt = Math.min(now - then, 100);
      then = now;
      if (turning.current) { requestAnimationFrame(tick); return; }
      // Read every frame, so a new pace takes over mid-sentence.
      f += dt / msFor(words, voicePrefs().pace);
      let j = shown < 0 ? -1 : shown;
      while (j + 1 < marks.length && marks[j + 1].f <= f) j++;
      if (j !== shown) {
        shown = j;
        const at = j >= 0 ? marks[j].at : 0;
        here.current = { s, at };
        beat = now;
        if (!l.show(s, at, true) && s.section !== l.at()) void follow(s, at);
      }
      if (f >= 1) resolve(true);
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  /** Turns to a picture and waits on it (look.ts). False when it was stopped or moved. */
  const look = async (gen: number, s: Sentence) => {
    const live = () => run.current === gen;
    here.current = { s, at: 0 };
    const l = listen();
    if (!l) return false;
    if (!l.show(s, 0, true)) await follow(s, 0);
    if (live() && (await listen()?.picture?.(s)) && live()) await lookAt(s, lookFor(voicePrefs().pace)).done;
    return live();
  };

  const halt = useCallback(() => {
    run.current++;
    turning.current = false;
    stopLook();
    setRunning(false);
  }, []);

  /** One sentence after another from `from`, into the chapters after it, to the end of the book. */
  const go = async (gen: number, from: Spot) => {
    const live = () => run.current === gen;
    let list = (await listen()?.section(from.s.section)) ?? [];
    let i = list.findIndex((s) => overlaps(s, from.s));
    // From exactly there: a voice may have stopped partway into a sentence.
    if (i < 0) { list = [from.s]; i = 0; } else list[i] = from.s;
    let at = from.at;
    while (live()) {
      if (i >= list.length) {
        let more: Sentence[] | null = null;
        for (let sec = list[list.length - 1].section + 1; ; sec++) {
          more = (await listen()?.section(sec)) ?? null;
          if (!more || more.length) break;
        }
        if (!live()) return;
        if (!more) break;
        list = more;
        i = 0;
      }
      if (!(await (list[i].pic !== undefined ? look(gen, list[i]) : light(gen, list[i], at)))) return;
      at = 0;
      i++;
    }
    // The end of the book: the last sentence stays lit.
    if (live()) halt();
  };

  /** Lights from this sentence on (`at` characters in, to carry on partway). */
  const begin = (s: Sentence, at = 0) => {
    const gen = ++run.current;
    turning.current = false;
    here.current = { s, at };
    setLit(true);
    setRunning(true);
    void go(gen, { s, at });
  };

  /** Stops where it is, still lit, to carry on from there. */
  const pauseHere = halt;

  /** Lights a sentence without moving on: where a voice stopped. */
  const hold = (s: Sentence) => {
    halt();
    here.current = { s, at: 0 };
    setLit(true);
    listen()?.show(s, 0);
  };

  /** Lets go without putting the light out: a voice is taking over from here. */
  const release = useCallback(() => {
    halt();
    here.current = null;
    setLit(false);
  }, [halt]);

  const stop = useCallback(() => {
    if (here.current) view.current?.listen.clear();
    release();
  }, [view, release]);

  // The reader turned the page or went to a chapter while it ran: it carries on from the top of there.
  useEffect(() => {
    const h = here.current;
    const l = listen();
    if (!runningRef.current || !h || !l || turning.current || l.onScreen(h.s, h.at)) return;
    const gen = run.current;
    void l.from().then((list) => { if (list[0] && run.current === gen) begin(list[0]); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loc]);

  // Nobody reads a hidden page: it waits where it got to.
  useEffect(() => {
    const away = () => { if (document.hidden && runningRef.current) halt(); };
    document.addEventListener('visibilitychange', away);
    return () => document.removeEventListener('visibilitychange', away);
  }, [halt]);

  useEffect(() => {
    if (!active) stop();
    return stop;
  }, [active, stop]);

  const busy = useCallback(() => runningRef.current, []);
  const current = useCallback(() => here.current, []);

  return { running, lit, begin, pause: pauseHere, hold, release, stop, busy, current };
}
