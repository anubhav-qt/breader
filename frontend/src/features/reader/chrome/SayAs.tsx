import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { SAY_AS } from '@breader/shared/limits';
import { springs } from '../../../lib/springs';
import { voiceFor, voicePrefs } from '../voice/prefs';
import { sayAsFor, setSayAs } from '../voice/sayas';
import { play, synth, unlock, type Playing } from '../voice/speaker';
import { PLAY, STOP } from './icons';
import { CloseDots, DotIcon } from './parts';

/*
 * Saying a word the reader's way. Tap a word while a voice reads, or select a few: it pauses, and
 * a small card by them asks how they should sound. Preview says the new spelling in the voice that
 * was reading; Save keeps it (voice/sayas.ts). Either way the voice carries on from its sentence.
 */

interface Props {
  narration: { playing: boolean; start: () => void; stop: () => void };
  /** The reader's positioned area, which the card is placed in. */
  body: RefObject<HTMLDivElement | null>;
}

interface Picked {
  text: string;
  /** The selection's centre and edges, in the reader's area. */
  x: number;
  top: number;
  bottom: number;
  /** Selected with a mouse: the field takes the keyboard straight away. */
  mouse: boolean;
  /** A tapped word, lit while the card asks about it (a selection shows itself). */
  word?: Range;
}

const ENDS = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;
const LETTER = /[\p{L}\p{N}]/u;
const IN_WORD = /[\p{L}\p{N}'\u2019-]/u;

/** Some of the book's text to ask about, if it's a word or a few within one paragraph. */
function asking(range: Range, area: HTMLElement, mouse: boolean): Picked | null {
  const node = range.commonAncestorContainer;
  const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  if (!el?.closest('.fv-flow')) return null;
  const raw = range.toString().trim();
  if (/\n/.test(raw)) return null;
  const text = raw.replace(ENDS, '').replace(/\s+/g, ' ');
  if (!text || text.length > SAY_AS.textChars || !/\p{L}/u.test(text)) return null;
  const box = range.getBoundingClientRect();
  const a = area.getBoundingClientRect();
  return { text, x: box.left + box.width / 2 - a.left, top: box.top - a.top, bottom: box.bottom - a.top, mouse };
}

/** The selection, if it's something to ask about. */
function picked(area: HTMLElement, mouse: boolean): Picked | null {
  const sel = document.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  return asking(sel.getRangeAt(0), area, mouse);
}

/** The word at a point on the page, if the point is on it. */
function wordAt(x: number, y: number): Range | null {
  const p = 'caretPositionFromPoint' in document ? document.caretPositionFromPoint(x, y) : null;
  const r = !p && 'caretRangeFromPoint' in document ? document.caretRangeFromPoint(x, y) : null;
  const node = p ? p.offsetNode : r?.startContainer;
  if (!node || node.nodeType !== Node.TEXT_NODE) return null;
  const text = node.textContent ?? '';
  let a = p ? p.offset : r!.startOffset;
  let b = a;
  while (a > 0 && IN_WORD.test(text[a - 1])) a--;
  while (b < text.length && IN_WORD.test(text[b])) b++;
  // Apostrophes and hyphens only count inside a word.
  while (a < b && !LETTER.test(text[a])) a++;
  while (b > a && !LETTER.test(text[b - 1])) b--;
  if (a === b) return null;
  const word = document.createRange();
  word.setStart(node, a);
  word.setEnd(node, b);
  // The caret finds the nearest letter even from the blank end of a line: only the word itself counts.
  const on = Array.from(word.getClientRects()).some((q) => x >= q.left - 3 && x <= q.right + 3 && y >= q.top - 3 && y <= q.bottom + 3);
  return on ? word : null;
}

type Highlights = { set: (name: string, h: unknown) => void; delete: (name: string) => void };
const highlights = (globalThis.CSS as unknown as { highlights?: Highlights } | undefined)?.highlights;

/** Lights the word being asked about, or nothing. */
function mark(word: Range | undefined) {
  if (!highlights) return;
  if (!word) { highlights.delete('say-as'); return; }
  const H = (globalThis as unknown as { Highlight: new (...r: Range[]) => unknown }).Highlight;
  highlights.set('say-as', new H(word));
}

export function SayAs({ narration, body }: Props) {
  const [open, setOpen] = useState<Picked | null>(null);
  const { playing } = narration;
  const actions = useRef(narration);
  actions.current = narration;

  // While a voice reads, a tap on a word, or a selection that settles (the mouse let go, or
  // handles left alone on a touch screen), pauses it and asks.
  useEffect(() => {
    const area = body.current;
    if (!playing || !area) return;
    let timer = 0;
    let down = false;
    let mouse = false;
    const ask = (p: Picked) => {
      window.clearTimeout(timer);
      actions.current.stop();
      setOpen(p);
    };
    const check = () => {
      const p = !down ? picked(area, mouse) : null;
      if (p) ask(p);
    };
    const later = (ms: number) => { window.clearTimeout(timer); timer = window.setTimeout(check, ms); };
    const onChange = () => later(600);
    const onDown = (e: PointerEvent) => { mouse = e.pointerType === 'mouse'; down = mouse; };
    const onUp = (e: PointerEvent) => { if (e.pointerType === 'mouse') { down = false; later(80); } };
    // After the reader's own capture (a swipe's click never gets here), before its tap that wakes
    // the controls, which this one takes.
    const onTap = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0) return;
      const t = e.target as Element;
      if (!t.closest('.fv-flow') || t.closest('a, button, input, select, textarea')) return;
      // Letting go of a selection clicks too: that's the selection's to ask about.
      if (document.getSelection()?.isCollapsed === false) return;
      const word = wordAt(e.clientX, e.clientY);
      const p = word && asking(word, area, mouse);
      if (!p) return;
      e.preventDefault();
      ask({ ...p, word });
    };
    document.addEventListener('selectionchange', onChange);
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('pointerup', onUp, true);
    area.addEventListener('click', onTap);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('selectionchange', onChange);
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('pointerup', onUp, true);
      area.removeEventListener('click', onTap);
    };
  }, [playing, body]);

  useEffect(() => {
    mark(open?.word);
    return () => mark(undefined);
  }, [open]);

  // Play pressed while it asks: the question goes.
  useEffect(() => { if (playing) setOpen(null); }, [playing]);

  const done = (say: string | null) => {
    if (open && say !== null) setSayAs(open.text, say);
    setOpen(null);
    document.getSelection()?.removeAllRanges();
    actions.current.start();
  };

  return (
    <AnimatePresence>
      {open && <motion.div key="scrim" className="i3-scrim" onClick={() => done(null)} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} />}
      {open && <Card key={`${open.text}@${open.top}`} at={open} area={body} onDone={done} />}
    </AnimatePresence>
  );
}

const GAP = 10;
const EDGE = 12;

function Card({ at, area, onDone }: { at: Picked; area: RefObject<HTMLDivElement | null>; onDone: (say: string | null) => void }) {
  const [say, setSay] = useState(() => sayAsFor(at.text) ?? at.text);
  const [hearing, setHearing] = useState<'making' | 'playing' | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number; above: boolean } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  /** The preview being made or said; a new one (or none) bumps gen. */
  const sound = useRef<{ gen: number; player: Playing | null }>({ gen: 0, player: null });

  // Under the selection, or over it when there's no room below; never past the reader's edges.
  useLayoutEffect(() => {
    const el = ref.current;
    const a = area.current;
    if (!el || !a) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const above = at.bottom + GAP + h > a.clientHeight - EDGE && at.top - GAP - h >= EDGE;
    setPos({
      left: Math.max(EDGE, Math.min(a.clientWidth - w - EDGE, at.x - w / 2)),
      top: above ? at.top - GAP - h : Math.min(at.bottom + GAP, a.clientHeight - h - EDGE),
      above,
    });
  }, [at, area]);

  // Once placed (a hidden field can't take the focus). A touch screen's keyboard waits for a tap in it.
  const placed = !!pos;
  useEffect(() => { if (placed && at.mouse) input.current?.select(); }, [placed, at.mouse]);
  useEffect(() => {
    const s = sound.current;
    return () => { s.gen++; s.player?.stop(); };
  }, []);

  const hush = () => {
    const s = sound.current;
    s.gen++;
    s.player?.stop();
    s.player = null;
    setHearing(null);
  };

  const preview = async () => {
    if (hearing) { hush(); return; }
    const words = say.trim();
    if (!words) return;
    // Sound can only start in the tap itself.
    unlock();
    const s = sound.current;
    const g = ++s.gen;
    setHearing('making');
    try {
      const p = voicePrefs();
      const clip = await synth(voiceFor(p.mode), words, p.rate);
      if (g !== s.gen) return;
      const now = play(clip);
      s.player = now;
      setHearing('playing');
      await now.done;
    } catch (e) {
      console.warn('The preview couldn’t be said:', e);
    }
    if (g === s.gen) { s.player = null; setHearing(null); }
  };

  const save = () => { hush(); onDone(say); };
  const cancel = () => { hush(); onDone(null); };

  // Escape, wherever the focus is, closes the card rather than the book (Reader goes back to the
  // library on it).
  const esc = useRef(cancel);
  esc.current = cancel;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      esc.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  return (
    <motion.div
      ref={ref}
      className="sa"
      data-panel
      role="dialog"
      aria-label={`How to say ${at.text}`}
      style={pos ? { left: pos.left, top: pos.top } : { visibility: 'hidden' }}
      initial={{ opacity: 0, y: pos?.above ? 6 : -6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: pos?.above ? 6 : -6 }}
      transition={springs.snappy}
    >
      <CloseDots onClick={cancel} />
      <p className="sa-q">What should it be pronounced as?</p>
      <p className="sa-word">{at.text}</p>
      <div className="sa-say">
        <input
          ref={input}
          className="vs-input"
          value={say}
          maxLength={SAY_AS.sayChars}
          onChange={(e) => { setSay(e.target.value); if (hearing) hush(); }}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } }}
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          aria-label="Say it as"
        />
        <button type="button" className={`sa-hear${hearing ? ` is-${hearing}` : ''}`} onClick={() => void preview()} disabled={!say.trim()} aria-pressed={!!hearing}>
          <DotIcon rows={hearing === 'playing' ? STOP : PLAY} />
          Preview
        </button>
      </div>
      <div className="sa-go">
        <button type="button" className="vs-go is-quiet" onClick={cancel}>Cancel</button>
        <button type="button" className="vs-go" onClick={save}>Save</button>
      </div>
    </motion.div>
  );
}
