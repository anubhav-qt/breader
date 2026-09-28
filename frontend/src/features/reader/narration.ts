import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { Loc, ViewHandle } from './FlowView';
import { checkGpu, type VoiceInfo } from './voice/catalog';
import { heardWords } from './voice/list';
import { askFirst, useVoicePrefs, voiceFor, voicePrefs } from './voice/prefs';
import { respell, type Swap } from './voice/sayas';
import { failed, missing, play, prepare, release, retry, synth, unlock, type Clip, type Playing } from './voice/speaker';

/*
 * Reading aloud with voices that run on this device (voice/): from the top of the page on screen,
 * a sentence at a time, with sound made up to a minute ahead. The sentence being read is lit in
 * the book's colour, and pages and chapters turn as the voice reaches them. Turn the page or jump
 * to a chapter while it reads, and it carries on from there.
 *
 * The voice keeps its own place in the book. It reads on in another tab or with the phone locked,
 * lighting nothing while the page can't be seen, and the page catches up to it when it's back.
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
   * Keeps a sentence on screen as it's read, `at` characters in: lights it (up to `at` as said),
   * and turns the page (or scrolls) when the voice reaches the next one. `centre` keeps a scrolled
   * page's sentence near the middle of the screen. False when the reader has gone somewhere else.
   */
  show: (s: Sentence, at: number, centre?: boolean) => boolean;
  /** Whether that spot is on the page on screen. */
  onScreen: (s: Sentence, at: number) => boolean;
  clear: () => void;
  /** All of a chapter's sentences (a PDF: a page's), without showing it; null past the end. */
  section: (i: number) => Promise<Sentence[] | null>;
  /** Takes the page to that spot: the voice read on while the page was out of sight. */
  reach: (s: Sentence, at: number) => void;
  /** The sentence at a point on screen, for Immersive's tap to begin there (pacing.ts). */
  pick?: (x: number, y: number) => Sentence | null;
}

export const canNarrate = typeof window !== 'undefined' && typeof Audio !== 'undefined' && typeof Worker !== 'undefined' && typeof WebAssembly !== 'undefined';

/* Sentences */

/** Long sentences wait longer for their sound, and Kokoro reads at most 510 sounds at once. */
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

/*
 * The lit sentence, drawn with the CSS Custom Highlight API so the book's markup isn't touched: the
 * sentence, and the part of it already said (Immersive colours them apart).
 */

const HIGHLIGHT = 'narrate';
const SAID = 'narrate-said';
type Highlights = { set: (name: string, h: unknown) => void; delete: (name: string) => void };
const highlights = (globalThis.CSS as unknown as { highlights?: Highlights } | undefined)?.highlights;

export function light(range: Range | null, said: Range | null = null) {
  if (!highlights) return;
  if (!range) { highlights.delete(HIGHLIGHT); highlights.delete(SAID); return; }
  const H = (globalThis as unknown as { Highlight: new (...r: Range[]) => { priority: number } }).Highlight;
  highlights.set(HIGHLIGHT, new H(range));
  if (!said) { highlights.delete(SAID); return; }
  const h = new H(said);
  h.priority = 1;
  highlights.set(SAID, h);
}

/* Timing */

const WORDY = /[\p{L}\p{N}]/u;

/**
 * Where each word ends in a sentence, and how far through its sound the voice starts it. The
 * engines don't say, so it's guessed from the letters: a space is quicker than a letter, and
 * commas and full stops are pauses. Words the reader respelled take as long as their new spelling.
 */
export function wordMarks(text: string, swaps: Swap[] = []) {
  const marks: Array<{ at: number; f: number }> = [];
  let total = 0;
  let open: { start: number; f: number } | null = null;
  for (let i = 0; i <= text.length; i++) {
    const c = text[i] ?? ' ';
    const word = WORDY.test(c) || (!!open && /['\u2019-]/.test(c) && WORDY.test(text[i + 1] ?? ''));
    if (word && !open) open = { start: i, f: total };
    if (!word && open) { marks.push({ at: i, f: open.f }); open = null; }
    const sw = swaps.find((w) => w.start <= i && i < w.end);
    const k = sw ? sw.len / (sw.end - sw.start) : 1;
    total += k * (word ? 1 : /\s/.test(c) ? 0.6 : /[,;:]/.test(c) ? 4 : /[.!?\u2026]/.test(c) ? 6 : /[\u2013\u2014]/.test(c) ? 3 : 0.3);
  }
  for (const m of marks) m.f /= total || 1;
  return marks;
}

export const wordsIn = (text: string) => text.match(/[\p{L}\p{N}]+/gu)?.length ?? 0;

const pause = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

/** About a minute of reading: sound is made this far ahead, as a locked phone may make none. */
const AHEAD = 900;

/** Immersive keeps a scrolled page's sentence near the middle of the screen. */
const centred = () => voicePrefs().mode === 'immersive';

const keyOf = (s: Sentence) => `${s.section}.${s.block}.${s.start}`;
const holds = (r: Sentence) => (s: Sentence) => s.section === r.section && s.block === r.block && s.start <= r.start && r.start < s.end;

/**
 * Reads the book on screen aloud. `loc` is the reader's place, so a page turned or a chapter picked
 * by hand while it reads moves the voice there too. `openSheet` shows the voice sheet: for a
 * download to agree to, or something gone wrong. `about` names the book for the lock screen.
 */
export function useNarration(view: RefObject<ViewHandle | null>, active: boolean, loc: Loc | null, openSheet: () => void, about: { title: string; author?: string }) {
  const [playing, setPlaying] = useState(false);
  const playingRef = useRef(playing);
  playingRef.current = playing;
  const run = useRef(0);
  /** The sentence being said and how far in, for following the reader's own turns. */
  const spot = useRef<{ s: Sentence; at: number } | null>(null);
  /** The last sentence said, to carry on from after a pause. */
  const last = useRef<Sentence | null>(null);
  /** `last` is where to start, wherever it is: Immersive's light was there. */
  const jumped = useRef(false);
  const player = useRef<Playing | null>(null);
  /** Stops the sentence being said or waited for, so the loop looks again. */
  const cut = useRef<((why: 'moved' | 'prefs') => void) | null>(null);
  /**
   * The page is behind the voice: it read on while the page was hidden (another tab, a locked
   * phone), or into the next chapter. The page catches up the next time it's seen.
   */
  const behind = useRef(false);

  const listen = () => view.current?.listen;

  const stop = useCallback(() => {
    run.current++;
    spot.current = null;
    player.current?.stop();
    player.current = null;
    cut.current = null;
    view.current?.listen?.clear();
    setPlaying(false);
  }, [view]);

  /** Brings the page to the voice, and lights where it is. */
  const catchUp = async (s: Sentence, at: number) => {
    const l = listen();
    if (!l) return;
    if (!l.show(s, at, centred())) {
      l.reach(s, at);
      for (let waited = 0; listen()?.at() !== s.section && waited < 4_000; waited += 50) await pause(50);
      listen()?.show(s, at, centred());
    }
    behind.current = false;
  };

  const loop = async (gen: number) => {
    const live = () => run.current === gen;
    const fresh = async () => {
      const l = listen()!;
      const r = last.current;
      const jump = jumped.current;
      last.current = null;
      jumped.current = false;
      // Behind the voice, the page on screen isn't where to carry on from.
      const list = (r && (behind.current || jump) ? await l.section(r.section) : await l.from()) ?? [];
      const i = r ? list.findIndex(holds(r)) : -1;
      return { list, i: Math.max(0, i) };
    };

    let voice = null as VoiceInfo | null;
    let rate = 1;
    /** Sound for sentences made ahead, by where they start, until they're said. */
    let clips = new Map<string, Promise<Clip>>();
    const clipOf = (s: Sentence) => {
      const k = keyOf(s);
      let c = clips.get(k);
      if (!c) {
        c = synth(voice!, respell(s.text).said, rate);
        c.catch(() => {});
        clips.set(k, c);
      }
      return c;
    };

    let { list, i } = await fresh();

    /** Adds the next chapter with anything to say to the end of `target`; false at the end of the book. */
    const growing = new Map<Sentence[], Promise<boolean>>();
    const extend = (target: Sentence[]) => {
      let p = growing.get(target);
      if (!p) {
        p = (async () => {
          for (let sec = (target[target.length - 1]?.section ?? listen()?.at() ?? 0) + 1; ; sec++) {
            const more = await listen()?.section(sec);
            if (!more || !live()) return false;
            if (more.length) { target.push(...more); return true; }
          }
        })();
        growing.set(target, p);
        void p.finally(() => growing.delete(target));
      }
      return p;
    };

    /** Makes sound for what's coming, two sentences at a time, up to AHEAD characters on. */
    let making = 0;
    const ahead = () => {
      let chars = 0;
      for (let j = i + 1; chars < AHEAD; j++) {
        if (j >= list.length) {
          const target = list;
          void extend(target).then((more) => { if (more && live() && target === list) ahead(); });
          return;
        }
        chars += list[j].text.length;
        if (clips.has(keyOf(list[j]))) continue;
        if (making >= 2) return;
        making++;
        const mine = clips;
        void clipOf(list[j]).catch(() => {}).finally(() => {
          making--;
          if (live() && clips === mine) ahead();
        });
      }
    };

    let failures = 0;
    let lastError = '';
    while (live()) {
      // A new voice or speed reads from here on.
      const p = voicePrefs();
      // Immersive reads with Normal's voices where the GPU can't run its own.
      if (p.mode === 'immersive') await checkGpu();
      if (!live()) return;
      const want = voiceFor(p.mode);
      if (want.key !== voice?.key || p.rate !== rate) {
        clips = new Map();
        rate = p.rate;
        if (want.key !== voice?.key) {
          const first = !voice;
          voice = null;
          if (!first && (await missing(want)).bytes > 0 && askFirst()) { openSheet(); break; }
          try {
            await prepare(want);
          } catch {
            if (live()) openSheet();
            break;
          }
          if (!live()) return;
          voice = want;
        }
      }
      const l = listen();
      if (!l) break;
      if (i >= list.length) {
        if (!(await extend(list))) break;
        if (!live()) return;
        continue;
      }
      const s = list[i];
      spot.current = { s, at: 0 };
      // Into the next chapter: the page follows as soon as it's seen.
      if (s.section !== l.at()) behind.current = true;
      ahead();

      let why: 'moved' | 'prefs' | null = null;
      const interrupted = new Promise<null>((resolve) => {
        cut.current = (w) => {
          why = w;
          player.current?.stop();
          resolve(null);
        };
      });
      let clip: Clip | null = null;
      try {
        clip = await Promise.race([clipOf(s), interrupted]);
      } catch (e) {
        console.warn('A sentence couldn’t be read aloud:', e);
        lastError = e instanceof Error ? e.message : String(e);
      }
      if (!live()) return;
      let how: Awaited<Playing['done']> | null = null;
      let refusal: string | null = null;
      if (clip) {
        const marks = wordMarks(s.text, respell(s.text).swaps);
        const now = play(clip);
        player.current = now;
        let shown = -2;
        let catching = false;
        let raf = 0;
        // Frames only come while the page can be seen: nothing is lit in the background, and the
        // first frame back finds the word the voice is on.
        const tick = () => {
          raf = requestAnimationFrame(tick);
          if (document.hidden) return;
          let j = Math.max(shown, -1);
          const f = now.time();
          while (j + 1 < marks.length && marks[j + 1].f <= f) j++;
          const at = j >= 0 ? marks[j].at : 0;
          spot.current = { s, at };
          if (catching) return;
          if (behind.current) {
            catching = true;
            shown = j;
            void catchUp(s, at).finally(() => { catching = false; });
            return;
          }
          if (j === shown) return;
          shown = j;
          listen()?.show(s, at, centred());
        };
        raf = requestAnimationFrame(tick);
        how = await Promise.race([now.done, interrupted]);
        refusal = now.refusal;
        cancelAnimationFrame(raf);
        if (player.current === now) player.current = null;
      }
      cut.current = null;
      if (!live()) return;
      if (why) {
        await pause(80);
        if (why === 'moved') {
          // From the top of where the reader went, not again from the sentence before.
          last.current = null;
          ({ list, i } = await fresh());
          clips = new Map();
        }
        // Otherwise the voice or speed changed: say this one again with it.
        continue;
      }
      if (how === 'paused') {
        // Paused from outside (a call, headphones out, the lock screen): carry on from here.
        last.current = s;
        stop();
        return;
      }
      if (how === 'refused') {
        // The browser wouldn't play it: say so, rather than going quiet. Play tries again from here.
        last.current = s;
        stop();
        failed(`This browser wouldn’t play the voice (${refusal}). Tap Read aloud to try again.`);
        openSheet();
        return;
      }
      if (!clip) {
        if (++failures >= 3) {
          failed(`The voice couldn’t read this part of the book${lastError ? ` (${lastError})` : ''}.`);
          openSheet();
          break;
        }
      } else {
        failures = 0;
        // Past a hundred words in someone else's voice, the reader keeps it.
        if (voice?.upload && !voice.upload.mine) heardWords(voice.upload.id, wordsIn(s.text));
      }
      // Said: its sound goes, or an hour of listening keeps an hour of it, about 300 MB.
      clips.delete(keyOf(s));
      last.current = s;
      i++;
    }
    if (live()) stop();
  };

  /**
   * Starts reading: from the voice sheet's button, the lock screen, or a tap on play that needs
   * nothing first. From `from` when given (Immersive's light), or else where it stopped or the top
   * of the page.
   */
  const start = (from?: Sentence) => {
    if (!canNarrate || !listen() || playingRef.current) return;
    if (from) {
      last.current = from;
      jumped.current = true;
    }
    unlock();
    retry();
    const gen = ++run.current;
    player.current?.stop();
    setPlaying(true);
    void loop(gen);
  };

  /** Stops, to carry on from this sentence next time. */
  const halt = () => {
    const s = spot.current;
    stop();
    if (s) last.current = s.s;
  };

  /** The tap on play. */
  const toggle = (from?: Sentence) => {
    if (playing) { halt(); return; }
    const p = voicePrefs();
    // Sound can only start in the tap itself.
    unlock();
    void (async () => {
      if (p.mode === 'immersive') await checkGpu();
      const m = await missing(voiceFor(p.mode));
      if (m.bytes > 0 && askFirst()) openSheet();
      else start(from);
    })();
  };

  // A page turned or chapter picked by hand: carry on from the top of it. Not while the page is
  // behind the voice: that's the voice moving on, and the page follows it.
  useEffect(() => {
    const sp = spot.current;
    const l = listen();
    if (!playing || !sp || !l || behind.current || l.onScreen(sp.s, sp.at)) return;
    cut.current?.('moved');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loc]);

  // Out of sight while it reads, the page falls behind. Paused out of sight, it shows where the
  // voice stopped once it's back.
  useEffect(() => {
    const seen = () => {
      if (document.visibilityState === 'hidden') {
        if (playingRef.current) behind.current = true;
        return;
      }
      const s = last.current;
      if (playingRef.current || !behind.current || !s) return;
      listen()?.reach(s, 0);
      behind.current = false;
    };
    document.addEventListener('visibilitychange', seen);
    return () => document.removeEventListener('visibilitychange', seen);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A new voice or speed takes over mid-sentence.
  const prefs = useVoicePrefs();
  const picked = voiceFor(prefs.mode).key;
  useEffect(() => {
    if (playing) cut.current?.('prefs');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefs.mode, picked, prefs.rate]);

  // The lock screen's and headphones' play and pause.
  const actions = useRef({ start, halt });
  actions.current = { start, halt };
  useEffect(() => {
    const ms = typeof navigator !== 'undefined' ? navigator.mediaSession : undefined;
    if (!ms || !active) return;
    ms.setActionHandler('play', () => actions.current.start());
    ms.setActionHandler('pause', () => actions.current.halt());
    ms.setActionHandler('stop', () => actions.current.halt());
    return () => {
      for (const a of ['play', 'pause', 'stop'] as const) ms.setActionHandler(a, null);
      ms.metadata = null;
      ms.playbackState = 'none';
    };
  }, [active]);
  useEffect(() => {
    const ms = typeof navigator !== 'undefined' ? navigator.mediaSession : undefined;
    if (!ms || !active) return;
    ms.playbackState = playing ? 'playing' : 'paused';
    if (playing) ms.metadata = new MediaMetadata({ title: about.title, artist: about.author ?? '', album: 'Breader' });
  }, [active, playing, about.title, about.author]);

  // Leaving the book, the voice's engine goes too, and what it holds.
  useEffect(() => {
    const leave = () => { stop(); release(); };
    if (!active) leave();
    return leave;
  }, [active, stop]);

  const busy = useCallback(() => playingRef.current, []);
  /** Where it stopped, or null. */
  const where = useCallback(() => last.current, []);

  return { playing, toggle, start, stop: halt, busy, where };
}
