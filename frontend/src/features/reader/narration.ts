import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { Loc, ViewHandle } from './FlowView';
import { lookAt, lookFor, stopLook } from './look';
import { checkGpu, type Mode, type VoiceInfo } from './voice/catalog';
import { heardWords } from './voice/list';
import { askFirst, onServer, pairFor, rateOf, useVoicePrefs, voiceFor, voicePrefs } from './voice/prefs';
import type { SleepWatch } from './sleep';
import { respell, type Swap } from './voice/sayas';
import { useSpeech } from './voice/server';
import { failed, hold, letGoKeys, missing, play, prepare, release, retry, synth, unlock, type Clip, type Playing } from './voice/speaker';
import { inTwo, type Marks, type Two } from './voice/two';

/*
 * Reading aloud with voices that run on this device (voice/), or on Breader's own computer for the
 * accounts it's open to (voice/server.ts): from the top of the page on screen,
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
  /** 2 voices: hers or his (voice/two.ts). */
  g?: Two;
  /**
   * A picture, the chapter's how-manyth, with nothing to say: Immersive stops on it (look.ts).
   * `block` is the one it's in or follows, and `start` and `end` are 0.
   */
  pic?: number;
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
  /** The chapter's paragraphs, numbered from 1 as the page shows them while choosing where to begin. */
  paragraphs?: () => Paragraph[];
  /** A sentence's words on the page, when its chapter is the one on screen: to point at them. */
  range?: (s: Sentence) => Range | null;
  /** A chapter's fingerprint (shared printOf), to tell it's the text 2 voices' marks were made from. */
  print?: (i: number) => Promise<string | null>;
  /**
   * Once a picture stop is drawn and on screen: whether it's big enough to stop at, and not a
   * flourish between scenes.
   */
  picture?: (s: Sentence) => Promise<boolean>;
}

/** A paragraph by its number in the chapter, and its first sentence. */
export interface Paragraph {
  n: number;
  s: Sentence;
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
/** 2 voices lights her lines and his in their own colours: `narrate-her`, `narrate-said-his`… */
const TONES = { F: '-her', M: '-his' } as const;
let tone: Two | null = null;
/** Whose voice the sentence lit next is in, for its colour; null for one voice. */
export const setTone = (g: Two | null) => { tone = g; };
type Highlights = { set: (name: string, h: unknown) => void; delete: (name: string) => void };
const highlights = (globalThis.CSS as unknown as { highlights?: Highlights } | undefined)?.highlights;

/*
 * Safari on a phone draws the page in tiles and doesn't draw one again when only a highlight on it
 * changed: each tile keeps whatever was lit when something else last made it draw, so old words
 * stay lit and new ones never light. So each change also gives the paragraphs it left and reached a
 * change Safari has to draw (an outline colour nobody sees, reader.css), once a frame, since two
 * in one frame would cancel out.
 */
let litIn: Element[] = [];
const toRepaint = new Set<Element>();
let repaintFrame = 0;
const holder = (r: Range) => {
  const n = r.commonAncestorContainer;
  return n instanceof Element ? n : n.parentElement;
};
function repaint(els: Element[]) {
  for (const el of els) toRepaint.add(el);
  if (repaintFrame) return;
  repaintFrame = requestAnimationFrame(() => {
    repaintFrame = 0;
    for (const el of toRepaint) el.classList.toggle('hl-paint');
    toRepaint.clear();
  });
}

export function light(range: Range | null, said: Range | null = null) {
  if (!highlights) return;
  const was = litIn;
  litIn = range ? [holder(range)].filter((el): el is Element => !!el) : [];
  repaint([...was, ...litIn]);
  for (const sfx of ['', ...Object.values(TONES)]) {
    highlights.delete(HIGHLIGHT + sfx);
    highlights.delete(SAID + sfx);
  }
  if (!range) return;
  const sfx = tone ? TONES[tone] : '';
  const H = (globalThis as unknown as { Highlight: new (...r: Range[]) => { priority: number } }).Highlight;
  highlights.set(HIGHLIGHT + sfx, new H(range));
  if (!said) return;
  const h = new H(said);
  h.priority = 1;
  highlights.set(SAID + sfx, h);
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

/** 2 voices' pair, hers first. */
const both = (m: Mode) => {
  const p = pairFor(m);
  return [p.F, p.M];
};

const keyOf = (s: Sentence) => `${s.section}.${s.block}.${s.start}`;
const holds = (r: Sentence) => (s: Sentence) => s.section === r.section && (r.pic !== undefined ? s.pic === r.pic : s.block === r.block && s.start <= r.start && r.start < s.end);

/**
 * Reads the book on screen aloud. `loc` is the reader's place, so a page turned or a chapter picked
 * by hand while it reads moves the voice there too. `openSheet` shows the voice sheet: for a
 * download to agree to, or something gone wrong. `about` names the book for the lock screen.
 * `sleep` watches for a reader who fell asleep to it (sleep.ts). `here` is where a press from
 * outside the page carries on from (Immersive's light). `two` is the book's 2 voices marks, when
 * it has them (voice/two.ts).
 */
export function useNarration(view: RefObject<ViewHandle | null>, active: boolean, loc: Loc | null, openSheet: () => void, about: { title: string; author?: string }, sleep?: RefObject<SleepWatch>, here?: () => Sentence | undefined, two: Marks | null = null) {
  const [playing, setPlaying] = useState(false);
  const playingRef = useRef(playing);
  playingRef.current = playing;
  const marks = useRef(two);
  marks.current = two;
  const run = useRef(0);
  /** The sentence being said and how far in, for following the reader's own turns. */
  const spot = useRef<{ s: Sentence; at: number } | null>(null);
  /** The last sentence said, to carry on from after a pause. */
  const last = useRef<Sentence | null>(null);
  /** `last` is where to start, wherever it is: Immersive's light was there. */
  const jumped = useRef(false);
  const player = useRef<Playing | null>(null);
  /** Stops the sentence being said or waited for, so the loop looks again. */
  const cut = useRef<((why: 'moved' | 'prefs' | 'jump') => void) | null>(null);
  /**
   * The page is behind the voice: it read on while the page was hidden (another tab, a locked
   * phone), or into the next chapter. The page catches up the next time it's seen.
   */
  const behind = useRef(false);

  const listen = () => view.current?.listen;

  /** Goes quiet. A pause (`keep`) leaves the sentence it stopped in lit, to carry on from. */
  const end = useCallback((keep: boolean) => {
    run.current++;
    spot.current = null;
    player.current?.stop();
    player.current = null;
    cut.current = null;
    stopLook();
    if (!keep) view.current?.listen?.clear();
    setTone(null);
    hold(false);
    setPlaying(false);
  }, [view]);
  const stop = useCallback(() => end(false), [end]);

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

    /*
     * 2 voices, when the book has marks and the reader picked it: sentences are cut where lines
     * start and end (voice/two.ts). `shape` says how the list is cut, so a change re-cuts it.
     * A chapter parsed differently from the text the marks were made from reads in one voice.
     */
    let pairFailed = false;
    const shapeNow = () => {
      const p = voicePrefs();
      const m = marks.current;
      return m && !pairFailed && p.count[p.mode] === 2 ? `2:${p.noPov}:${m.made}` : '1';
    };
    let shape = shapeNow();
    const same = new Map<number, boolean>();
    const shaped = async (raw: Sentence[]) => {
      const m = marks.current;
      if (shape === '1' || !m) return raw;
      for (const sec of new Set(raw.map((s) => s.section))) {
        if (same.has(sec)) continue;
        const print = await listen()?.print?.(sec);
        same.set(sec, !!print && print === m.prints[sec]);
      }
      return inTwo(raw, m, voicePrefs().noPov, (sec) => same.get(sec) ?? false);
    };

    const fresh = async () => {
      const l = listen()!;
      const r = last.current;
      const jump = jumped.current;
      last.current = null;
      jumped.current = false;
      // Behind the voice, the page on screen isn't where to carry on from.
      const list = await shaped((r && (behind.current || jump) ? await l.section(r.section) : await l.from()) ?? []);
      const i = r ? list.findIndex(holds(r)) : -1;
      return { list, i: Math.max(0, i) };
    };

    /** The voices reading: one, or 2 voices' hers and his. */
    let voices: VoiceInfo[] = [];
    /** Where they read: on the server, or here. */
    let where = '';
    const keys = () => voices.map((v) => v.key);
    const voiceOf = (s: Sentence) => (voices.length > 1 && s.g === 'M' ? voices[1] : voices[0]);
    let rate = 1;
    /** Sound for sentences made ahead, by where they start, until they're said. */
    let clips = new Map<string, Promise<Clip>>();
    const clipOf = (s: Sentence) => {
      const k = keyOf(s);
      let c = clips.get(k);
      if (!c) {
        c = synth(voiceOf(s), respell(s.text).said, rate, keys());
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
            if (more.length) { target.push(...(await shaped(more))); return live(); }
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
        if (list[j].pic !== undefined || clips.has(keyOf(list[j]))) continue;
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
    let toldPair = false;
    while (live()) {
      // A new voice or speed reads from here on.
      const p = voicePrefs();
      // Immersive reads with Normal's voices where the GPU can't run its own.
      if (p.mode === 'immersive') await checkGpu();
      if (!live()) return;
      // 1 voice or 2, or a new pick for no point of view: cut again from the sentence it's on.
      const now = shapeNow();
      if (now !== shape) {
        shape = now;
        const s = list[i] ?? last.current;
        if (s) { last.current = s; jumped.current = true; }
        ({ list, i } = await fresh());
        clips = new Map();
        if (!live()) return;
      }
      const want = shape === '1' ? [voiceFor(p.mode)] : both(p.mode);
      const wantKeys = want.map((v) => v.key).join('|');
      const wantWhere = onServer() ? 'server' : 'here';
      if (wantKeys !== keys().join('|') || wantWhere !== where || rateOf(p) !== rate) {
        clips = new Map();
        rate = rateOf(p);
        if (wantKeys !== keys().join('|') || wantWhere !== where) {
          where = wantWhere;
          const first = !voices.length;
          voices = [];
          let bytes = 0;
          for (const v of want) bytes += (await missing(v)).bytes;
          if (!first && bytes > 0 && askFirst()) { openSheet(); break; }
          try {
            for (const v of want) await prepare(v, want.map((w) => w.key));
          } catch {
            if (!live()) return;
            // Two wouldn't start (a phone short of memory, most likely): one voice, and the sheet says so.
            if (want.length > 1) { pairFailed = true; continue; }
            openSheet();
            break;
          }
          if (!live()) return;
          voices = want;
          if (pairFailed && !toldPair) {
            toldPair = true;
            failed('2 voices couldn’t start on this device just now, so this reads in one voice.');
          }
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
      const pic = s.pic !== undefined;
      spot.current = { s, at: 0 };
      setTone(voices.length > 1 ? s.g ?? null : null);
      // Into the next chapter: the page follows as soon as it's seen.
      if (s.section !== l.at()) behind.current = true;
      ahead();

      let why: 'moved' | 'prefs' | 'jump' | null = null;
      const interrupted = new Promise<null>((resolve) => {
        cut.current = (w) => {
          why = w;
          player.current?.stop();
          resolve(null);
        };
      });
      let cutOff = false;
      void interrupted.then(() => { cutOff = true; });
      let clip: Clip | null = null;
      if (pic) {
        // A picture: Immersive turns to it and waits on it a moment. Normal reads on past it, and
        // so does a voice nobody can see the page of.
        if (centred() && !document.hidden) {
          await catchUp(s, 0);
          if (live() && !cutOff && (await listen()?.picture?.(s)) && live() && !cutOff) {
            const seen = lookAt(s, lookFor(p.pace));
            await Promise.race([seen.done, interrupted]);
            seen.end();
          }
        }
      } else {
        try {
          clip = await Promise.race([clipOf(s), interrupted]);
        } catch (e) {
          console.warn('A sentence couldn’t be read aloud:', e);
          lastError = e instanceof Error ? e.message : String(e);
        }
      }
      if (!live()) return;
      let how: Awaited<Playing['done']> | null = null;
      let refusal: string | null = null;
      if (clip) {
        // An hour nobody touched anything: it fades out over a few sentences, and stops.
        const volume = sleep?.current.before(s) ?? 1;
        if (volume <= 0) {
          last.current = s;
          end(true);
          return;
        }
        const marks = wordMarks(s.text, respell(s.text).swaps);
        const now = play(clip, volume);
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
        } else if (why === 'jump') {
          // Back to a checkpoint (sleep.ts): from there, and the page follows.
          ({ list, i } = await fresh());
          clips = new Map();
        }
        // Otherwise the voice or speed changed: say this one again with it.
        continue;
      }
      if (how === 'paused') {
        // Paused from outside (a call, headphones out, the lock screen): carry on from here.
        last.current = s;
        end(true);
        return;
      }
      if (how === 'refused') {
        // The browser wouldn't play it: say so, rather than going quiet. Play tries again from here.
        last.current = s;
        end(true);
        failed(`This browser wouldn’t play the voice (${refusal}). Tap Read aloud to try again.`);
        openSheet();
        return;
      }
      if (pic) {
        // Looked at, or passed.
      } else if (!clip) {
        if (++failures >= 3) {
          failed(`The voice couldn’t read this part of the book${lastError ? ` (${lastError})` : ''}.`);
          openSheet();
          break;
        }
      } else {
        failures = 0;
        // Past a hundred words in someone else's voice, the reader keeps it.
        const said = voiceOf(s);
        if (said?.upload && !said.upload.mine) heardWords(said.upload.id, wordsIn(s.text));
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
   * nothing first. From `from` when given (Immersive's light, or the top of the page), or else
   * where it stopped or the top of the page.
   */
  const start = (from?: Sentence | 'top') => {
    if (!canNarrate || !listen() || playingRef.current) return;
    if (from === 'top') {
      last.current = null;
      jumped.current = false;
    } else if (from) {
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

  /** Pauses, to carry on from this sentence next time. It stays lit meanwhile. */
  const halt = () => {
    const s = spot.current;
    end(true);
    if (s) last.current = s.s;
  };

  /**
   * Reads from a tap: the voice sheet opens instead when there's a download to agree to first,
   * unless it was already `agreed`. True once it's reading.
   */
  const readFrom = async (from?: Sentence | 'top', agreed = false) => {
    const p = voicePrefs();
    // Sound can only start in the tap itself.
    unlock();
    if (p.mode === 'immersive') await checkGpu();
    let bytes = 0;
    for (const v of marks.current && p.count[p.mode] === 2 ? both(p.mode) : [voiceFor(p.mode)]) bytes += (await missing(v)).bytes;
    if (bytes > 0 && !agreed && askFirst()) { openSheet(); return false; }
    actions.current.start(from);
    return true;
  };

  /** The tap on play. */
  const toggle = (from?: Sentence) => {
    if (playing) halt();
    else void readFrom(from);
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

  // A new voice or speed takes over mid-sentence, and so does the server's voice or this device's.
  const prefs = useVoicePrefs();
  const speech = useSpeech();
  const server = prefs.server && speech.allowed;
  const picked = voiceFor(prefs.mode).key;
  const speed = rateOf(prefs);
  // 2 voices: on or off, the pair, and who reads with no point of view, as the loop sees them.
  const twoOn = !!two && prefs.count[prefs.mode] === 2;
  const pair = twoOn ? both(prefs.mode).map((v) => v.key).join('|') : '';
  useEffect(() => {
    if (playing) cut.current?.('prefs');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefs.mode, picked, speed, twoOn, pair, twoOn && prefs.noPov, two?.made, server]);
  // Paused, the lit sentence goes out with a change of mode, which lights its own way.
  const modeAt = useRef(prefs.mode);
  useEffect(() => {
    if (modeAt.current !== prefs.mode && !playingRef.current) listen()?.clear();
    modeAt.current = prefs.mode;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefs.mode]);

  // Play and pause from outside the page: the lock screen, a headset's button, a keyboard's media
  // keys. Some browsers send a key both as a key press (Reader.tsx) and to the media session, so a
  // second one straight after the first is the same press.
  const actions = useRef({ start, halt, toggle });
  actions.current = { start, halt, toggle };
  const pressed = useRef(-Infinity);
  const hereRef = useRef(here);
  hereRef.current = here;
  const media = useCallback((what: 'play' | 'pause' | 'toggle') => {
    const now = performance.now();
    if (now - pressed.current < 400) return;
    pressed.current = now;
    sleep?.current.touched();
    if (what === 'play') actions.current.start(hereRef.current?.());
    else if (what === 'pause') actions.current.halt();
    else if (playingRef.current) actions.current.halt();
    else actions.current.toggle(hereRef.current?.());
  }, [sleep]);
  useEffect(() => {
    const ms = typeof navigator !== 'undefined' ? navigator.mediaSession : undefined;
    if (!ms || !active) return;
    ms.setActionHandler('play', () => media('play'));
    ms.setActionHandler('pause', () => media('pause'));
    ms.setActionHandler('stop', () => media('pause'));
    return () => {
      for (const a of ['play', 'pause', 'stop'] as const) ms.setActionHandler(a, null);
      ms.metadata = null;
      ms.playbackState = 'none';
    };
  }, [active, media]);
  useEffect(() => {
    const ms = typeof navigator !== 'undefined' ? navigator.mediaSession : undefined;
    if (!ms || !active) return;
    ms.playbackState = playing ? 'playing' : 'paused';
    if (playing) ms.metadata = new MediaMetadata({ title: about.title, artist: about.author ?? '', album: 'Breader' });
  }, [active, playing, about.title, about.author]);

  // Leaving the book, the voice's engine goes too, and what it holds.
  useEffect(() => {
    const leave = () => { stop(); release(); letGoKeys(); };
    if (!active) leave();
    return leave;
  }, [active, stop]);

  const busy = useCallback(() => playingRef.current, []);
  /** Where it stopped, or null. */
  const where = useCallback(() => last.current, []);
  /** The sentence being said, or where it stopped. */
  const current = useCallback(() => spot.current?.s ?? last.current, []);

  /** Goes back to a sentence: reading on from there if it's reading, or waiting there for play. */
  const jump = useCallback((s: Sentence) => {
    last.current = s;
    jumped.current = true;
    if (playingRef.current) {
      behind.current = true;
      cut.current?.('jump');
    } else {
      view.current?.listen.reach(s, 0);
    }
  }, [view]);

  return { playing, toggle, start, readFrom, stop: halt, busy, where, media, current, jump };
}
