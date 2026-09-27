import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { Loc, ViewHandle } from './FlowView';
import { hasGpu, type VoiceInfo } from './voice/catalog';
import { heardWords } from './voice/list';
import { askFirst, setVoicePrefs, useVoicePrefs, voiceFor, voicePrefs } from './voice/prefs';
import { failed, missing, play, prepare, synth, unlock, type Clip, type Playing } from './voice/speaker';

/*
 * Reading aloud with voices that run on this device (voice/): from the top of the page on screen,
 * a sentence at a time, the next two made while one plays. The sentence being read is lit in the
 * book's colour, and pages and chapters turn as the voice reaches them. Turn the page or jump to a
 * chapter while it reads, and it carries on from there.
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
  /** On to the next chapter (a PDF: page); false at the end of the book. */
  next: () => boolean;
}

export const canNarrate = typeof window !== 'undefined' && 'AudioContext' in window && typeof Worker !== 'undefined' && typeof WebAssembly !== 'undefined';

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
 * commas and full stops are pauses.
 */
function wordMarks(text: string) {
  const marks: Array<{ at: number; f: number }> = [];
  let total = 0;
  let open: { start: number; f: number } | null = null;
  for (let i = 0; i <= text.length; i++) {
    const c = text[i] ?? ' ';
    const word = WORDY.test(c) || (!!open && /['\u2019-]/.test(c) && WORDY.test(text[i + 1] ?? ''));
    if (word && !open) open = { start: i, f: total };
    if (!word && open) { marks.push({ at: i, f: open.f }); open = null; }
    total += word ? 1 : /\s/.test(c) ? 0.6 : /[,;:]/.test(c) ? 4 : /[.!?\u2026]/.test(c) ? 6 : /[\u2013\u2014]/.test(c) ? 3 : 0.3;
  }
  for (const m of marks) m.f /= total || 1;
  return marks;
}

const wordsIn = (text: string) => text.match(/[\p{L}\p{N}]+/gu)?.length ?? 0;

const pause = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

/**
 * Reads the book on screen aloud. `loc` is the reader's place, so a page turned or a chapter picked
 * by hand while it reads moves the voice there too. `openSheet` shows the voice sheet: for a first
 * go at Immersive, a download to agree to, or something gone wrong.
 */
export function useNarration(view: RefObject<ViewHandle | null>, active: boolean, loc: Loc | null, openSheet: () => void) {
  const [playing, setPlaying] = useState(false);
  const run = useRef(0);
  /** The sentence being said and how far in, for following the reader's own turns. */
  const spot = useRef<{ s: Sentence; at: number } | null>(null);
  /** The last sentence said, to carry on from after a pause when it's still on screen. */
  const last = useRef<Sentence | null>(null);
  const player = useRef<Playing | null>(null);
  /** Stops the sentence being said or waited for, so the loop looks again. */
  const cut = useRef<((why: 'moved' | 'prefs') => void) | null>(null);

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

  const loop = async (gen: number) => {
    const live = () => run.current === gen;
    const centre = () => voicePrefs().mode === 'immersive';
    const fresh = async () => {
      const list = (await listen()?.from()) ?? [];
      // After a pause, pick up at the sentence it stopped in if that's still on the page.
      const r = last.current;
      const i = r ? list.findIndex((s) => s.section === r.section && s.block === r.block && s.start <= r.start && r.start < s.end) : -1;
      last.current = null;
      return { list, i: Math.max(0, i) };
    };

    // Cast, or TypeScript reads it as always null inside the loop.
    let voice = null as VoiceInfo | null;
    let rate = 1;
    /** Sound for sentences, made ahead, by where they start. */
    let clips = new Map<string, Promise<Clip>>();
    const clipOf = (s: Sentence) => {
      const k = `${s.section}.${s.block}.${s.start}`;
      let c = clips.get(k);
      if (!c) {
        c = synth(voice!, s.text, rate);
        c.catch(() => {});
        clips.set(k, c);
      }
      return c;
    };

    let { list, i } = await fresh();
    let placed = true;
    let failures = 0;
    while (live()) {
      // A new voice or speed reads from here on.
      const p = voicePrefs();
      const want = voiceFor(p.mode);
      if (want.key !== voice?.key || p.rate !== rate) {
        clips = new Map();
        rate = p.rate;
        if (want.key !== voice?.key) {
          const first = !voice;
          voice = null;
          if (want.engine === 'kokoro' && !hasGpu()) { openSheet(); break; }
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
        const was = l.at();
        if (!l.next()) break;
        // The next chapter lands after its turn; wait for it.
        let waited = 0;
        while (live() && listen()?.at() === was && waited < 4_000) { await pause(50); waited += 50; }
        if (!live()) return;
        ({ list, i } = await fresh());
        clips = new Map();
        placed = true;
        continue;
      }
      const s = list[i];
      if (!l.show(s, 0, centre()) && !placed) {
        ({ list, i } = await fresh());
        placed = true;
        continue;
      }
      placed = false;
      spot.current = { s, at: 0 };
      for (const n of list.slice(i + 1, i + 3)) clipOf(n);

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
      }
      if (!live()) return;
      if (clip) {
        const marks = wordMarks(s.text);
        let k = -1;
        const now = play(clip, (f) => {
          if (!live()) return;
          let j = k;
          while (j + 1 < marks.length && marks[j + 1].f <= f) j++;
          if (j === k) return;
          k = j;
          spot.current = { s, at: marks[j].at };
          listen()?.show(s, marks[j].at, centre());
        });
        player.current = now;
        await Promise.race([now.done, interrupted]);
        if (player.current === now) player.current = null;
      }
      cut.current = null;
      if (!live()) return;
      if (why) {
        await pause(80);
        if (why === 'moved') {
          ({ list, i } = await fresh());
          clips = new Map();
          placed = true;
        }
        // Otherwise the voice or speed changed: say this one again with it.
        continue;
      }
      if (!clip) {
        if (++failures >= 3) {
          failed('The voice couldn’t read this part of the book.');
          openSheet();
          break;
        }
      } else {
        failures = 0;
        // Past a hundred words in someone else's voice, the reader keeps it.
        if (voice?.upload && !voice.upload.mine) heardWords(voice.upload.id, wordsIn(s.text));
      }
      last.current = s;
      i++;
    }
    if (live()) stop();
  };

  /** Starts reading: from the voice sheet's button, or a tap on play that needs nothing first. */
  const start = () => {
    if (!canNarrate || !listen()) return;
    unlock();
    if (voicePrefs().introduce) setVoicePrefs({ introduce: false });
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
  const toggle = () => {
    if (playing) { halt(); return; }
    const p = voicePrefs();
    if (p.mode === 'immersive' && (p.introduce || !hasGpu())) {
      if (p.introduce) setVoicePrefs({ introduce: false });
      openSheet();
      return;
    }
    // Sound can only start in the tap itself.
    unlock();
    const v = voiceFor(p.mode);
    void missing(v).then((m) => {
      if (m.bytes > 0 && askFirst()) openSheet();
      else start();
    });
  };

  // A page turned or chapter picked by hand: carry on from the top of it.
  useEffect(() => {
    const sp = spot.current;
    const l = listen();
    if (!playing || !sp || !l || l.onScreen(sp.s, sp.at)) return;
    cut.current?.('moved');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loc]);

  // A new voice or speed takes over mid-sentence.
  const prefs = useVoicePrefs();
  const picked = prefs.voice[prefs.mode];
  useEffect(() => {
    if (playing) cut.current?.('prefs');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefs.mode, picked, prefs.rate]);

  useEffect(() => {
    if (!active) stop();
    return stop;
  }, [active, stop]);

  const playingRef = useRef(playing);
  playingRef.current = playing;
  const busy = useCallback(() => playingRef.current, []);

  return { playing, toggle, start, stop: halt, busy };
}
