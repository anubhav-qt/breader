import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type PointerEvent, type TouchEvent } from 'react';
import type { BookRecord, LoadedBook, ReadMark, ReadState, TocItem } from '../../books/types';
import { markTracker, screenWords } from '../../books/mark';
import { Toast, type ToastMessage } from '../../components/Toast';
import { paintBars } from '../../lib/bars';
import { chapterAt, chapterName, chaptersOf } from './chapters';
import { InstrumentChrome } from './chrome/Instrument';
import type { ChromeProps, PanelName } from './chrome/types';
import { FlowView, type Loc, type Start, type ViewHandle } from './FlowView';
import { useFocusMode, useWake } from './focus';
import { useFullscreenReading } from './fullscreen';
import { canNarrate, useNarration, type Paragraph, type Sentence } from './narration';
import { overlaps, usePacing } from './pacing';
import { PdfView } from './PdfView';
import { refreshVoices } from './voice/list';
import { useVoicePrefs } from './voice/prefs';
import { useLoadState } from './voice/speaker';
import { useReaderSettings, type ThemeName } from './settings';
import { flash, readBook, type Found } from './search';
import { useSleepWatch } from './sleep';
import { useReadingClock } from './useReadingClock';
import './reader.css';
import './instrument.css';

interface Props {
  record: BookRecord;
  /** The reader's own name for the book, if they renamed it. */
  title?: string;
  /** The book's palette colour (data/colors.ts). */
  color: string;
  book: LoadedBook;
  initial?: ReadState;
  /** On its way back into the library; the page no longer responds. */
  closing?: boolean;
  onBack: () => void;
  onSave: (read: ReadState) => void;
  /** Seconds spent reading, counted while the book is on screen and being read. */
  onReadTime?: (seconds: number) => void;
  onRemove?: () => void;
}

const hex = (v: string) => {
  const m = v.trim().match(/^#([0-9a-f]{6})$/i);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const luminance = (rgb: number[]) => {
  const [r, g, b] = rgb.map((c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

const noTime = () => {};

const MEDIA_KEYS: Record<string, 'play' | 'pause' | 'toggle'> = { MediaPlayPause: 'toggle', MediaPlay: 'play', MediaPause: 'pause', MediaStop: 'pause' };

export function Reader({ record, title, color, book, initial, closing = false, onBack, onSave, onReadTime = noTime, onRemove }: Props) {
  const [settings, update] = useReaderSettings();
  const [panel, setPanel] = useState<PanelName | null>(null);
  const [lastPanel, setLastPanel] = useState<PanelName>('toc');
  const [loc, setLoc] = useState<Loc | null>(null);
  const [pageW, setPageW] = useState(0);
  const [lowContrast, setLowContrast] = useState(false);
  const view = useRef<ViewHandle>(null);
  const body = useRef<HTMLDivElement>(null);
  const chapters = useMemo(() => chaptersOf(book), [book]);
  const current = chapterAt(chapters, loc);

  const openPanel = useCallback((p: PanelName | null) => {
    setPanel(p);
    if (p) setLastPanel(p);
  }, []);

  // Did you sleep? Checkpoints while the voice reads untouched, asked about on the way back (sleep.ts).
  const saying = useRef<() => Sentence | null>(() => null);
  const slept = useSleepWatch(record.id, !closing, () => saying.current());
  // A headset's press carries on from Immersive's light, which comes later.
  const lightAt = useRef<() => Sentence | undefined>(() => undefined);
  const narration = useNarration(view, !closing, loc, () => openPanel('voice'), { title: title || book.title, author: book.author }, slept.watch, () => lightAt.current());
  saying.current = narration.current;
  const { asked, done: sleptDone } = slept;
  useEffect(() => { if (asked) openPanel('sleep'); }, [asked, openPanel]);
  // Closed, it's been answered.
  const wasAsking = useRef(false);
  useEffect(() => {
    if (wasAsking.current && panel !== 'sleep') sleptDone();
    wasAsking.current = panel === 'sleep';
  }, [panel, sleptDone]);
  // Immersive: the page dims, and its words light up from a tap at the reader's pace, until play
  // adds a voice (pacing.ts). Only where there are words to light, not on a PDF's drawn pages.
  const voice = useVoicePrefs();
  const immersive = voice.mode === 'immersive' && book.kind === 'flow';
  const pacing = usePacing(view, immersive && !closing, loc);
  // Voices readers uploaded, so the one picked last time is known.
  useEffect(() => { if (canNarrate) void refreshVoices(); }, []);
  const { busy: speaking, media } = narration;
  const { busy: lighting } = pacing;
  const busy = useCallback(() => speaking() || lighting(), [speaking, lighting]);
  useReadingClock(!closing, onReadTime, busy);
  useFullscreenReading(!closing);
  const [focus, toggleFocus] = useFocusMode();
  const { awake, still, wake, sleep } = useWake(!closing);
  // Opening in focus mode shows where the controls are before they go.
  useEffect(() => { if (focus) wake(1800); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // An Immersive voice or the light gets the page to itself: the controls step away, as in focus
  // mode, until it stops.
  const load = useLoadState();
  const listening = canNarrate && narration.playing && voice.mode === 'immersive' && load.key === null;
  const hush = focus || listening || pacing.running;
  useEffect(() => { if (listening || pacing.running) wake(1800); }, [listening, pacing.running, wake]);

  // A voice takes over from the light, and leaves it lit where it stopped.
  const voiced = useRef(false);
  useEffect(() => {
    if (narration.playing) pacing.release();
    else if (voiced.current && immersive) {
      const s = narration.where();
      if (s) pacing.hold(s);
    }
    voiced.current = narration.playing;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [narration.playing]);
  /** In Immersive, a voice starts where the light is. */
  const fromLight = () => (immersive ? pacing.current()?.s : undefined);
  lightAt.current = fromLight;

  /*
   * Where Immersive begins. Begin numbers the paragraphs, and the reader picks: the top of the page,
   * a paragraph by its number, or a tap on one. After the first start, every pause offers the same
   * again, with Continue in place of the top. Play picks the voice for all of it, until Immersive is
   * switched off; before that, it's the light.
   */
  const [asking, setAsking] = useState(false);
  const [begun, setBegun] = useState(false);
  const [byVoice, setByVoice] = useState(false);
  const going = pacing.running || narration.playing;
  /** The voice waiting on a word's card (SayAs): not a pause that asks where to carry on. */
  const hushed = useRef(false);
  const wasGoing = useRef(false);
  useEffect(() => {
    if (!immersive) {
      setAsking(false);
      setBegun(false);
      setByVoice(false);
    } else if (going) {
      hushed.current = false;
      setBegun(true);
      setAsking(false);
      if (narration.playing) setByVoice(true);
    } else if (wasGoing.current && !hushed.current) setAsking(true);
    wasGoing.current = going;
  }, [immersive, going, narration.playing]);
  const choosing = immersive && asking && !going;
  const paragraphs = useMemo(() => (choosing ? view.current?.listen.paragraphs?.() ?? [] : []), [choosing, loc?.section]); // eslint-disable-line react-hooks/exhaustive-deps
  /** The first paragraph that starts on screen: the picker starts there. */
  const nowAt = loc ? (paragraphs.find((p) => p.s.block > loc.block || (p.s.block === loc.block && loc.offset === 0)) ?? paragraphs[paragraphs.length - 1])?.n : undefined;
  /** Lights from a sentence, taking the page to it first when it's off screen (a paragraph picked by number). */
  const lightFrom = (s: Sentence, at = 0) => {
    const l = view.current?.listen;
    if (!l) return;
    setAsking(false);
    if (l.onScreen(s, at)) { pacing.begin(s, at); return; }
    l.reach(s, at);
    void shown(s).then(() => pacing.begin(s, at));
  };
  /** Once the page has got to a sentence it was sent to, or a second on. */
  const shown = async (s: Sentence) => {
    for (let waited = 0; !view.current?.listen.onScreen(s, 0) && waited < 1000; waited += 50) await new Promise((r) => window.setTimeout(r, 50));
  };
  /**
   * The voice from a sentence or the top of the page. A download still to agree to opens the voice
   * sheet first, and its Read aloud starts from here.
   */
  const agreed = useRef(false);
  const waitingVoice = useRef<Sentence | 'top' | null>(null);
  const voiceFrom = (from: Sentence | 'top') => {
    setAsking(false);
    void narration.readFrom(from, agreed.current).then((started) => { waitingVoice.current = started ? null : from; });
  };
  useEffect(() => { if (panel !== 'voice') waitingVoice.current = null; }, [panel]);
  const beginAt = (s: Sentence, at = 0) => (byVoice ? voiceFrom(s) : lightFrom(s, at));
  /** From the top of the page on screen. */
  const fromTop = () => {
    if (byVoice) { voiceFrom('top'); return; }
    void view.current?.listen.from().then((list) => { if (list[0]) lightFrom(list[0]); });
  };
  /** From where it paused: the light's place, which a paused voice leaves lit too. */
  const carryOn = () => {
    const h = pacing.current();
    if (byVoice) voiceFrom(h?.s ?? narration.where() ?? 'top');
    else if (h) lightFrom(h.s, h.at);
    else fromTop();
  };
  /** A match found in the book: the page goes to it, and it's lit for a moment. */
  const goFound = (f: Found) => {
    const l = view.current?.listen;
    if (!l) return;
    if (!l.onScreen(f.s, 0)) l.reach(f.s, 0);
    void shown(f.s).then(() => flash(view.current?.listen.range?.(f.s) ?? null, body.current));
  };
  const readAll = useCallback((onRead?: (done: number, of: number) => void) => readBook(book, view.current!.listen, onRead), [book]);
  /** Back to a checkpoint: the voice reads on from there, or waits there (lit, in Immersive) for play. */
  const backTo = (s: Sentence) => {
    openPanel(null);
    const reading = narration.playing;
    narration.jump(s);
    if (immersive && !reading) void shown(s).then(() => pacing.hold(s));
  };
  /** A tap on the page: on what's lit, it carries on; elsewhere it starts there, or at the paragraph's start when nothing's lit yet. */
  const tapped = (s: Sentence) => {
    const h = pacing.lit ? pacing.current() : null;
    if (h && overlaps(h.s, s)) carryOn();
    else beginAt(h ? s : view.current?.listen.paragraphs?.().find((p) => p.s.block === s.block)?.s ?? s);
  };
  /** The light stops at a tap anywhere: it moves on too quickly to aim at. Controls hidden in focus mode come back. */
  const pauseLight = () => {
    pacing.pause();
    if (focus) wake(3500);
  };
  /** Enter stops the light, carries on where it paused, or starts at the top of the page. False when it's not Enter's to take. */
  const onEnter = useRef<() => boolean>(() => false);
  onEnter.current = () => {
    if (!immersive || narration.playing || closing) return false;
    if (pacing.running) pauseLight();
    else if (begun) carryOn();
    else fromTop();
    return true;
  };
  /** Play, up top. In Immersive it picks the voice and asks where from, with anything open put away. */
  const onPlay = () => {
    if (!immersive) { narration.toggle(); return; }
    if (narration.playing) { narration.stop(); return; }
    openPanel(null);
    setByVoice(true);
    if (pacing.running) pacing.pause();
    setAsking(true);
  };
  /**
   * The voice sheet's Read aloud. In Immersive: Begin, on the bottom line, as for the light. Or
   * straight on, when the sheet opened to ask for a download, or to say the voice failed.
   */
  const onRead = () => {
    if (!immersive) { narration.start(); return; }
    const from = waitingVoice.current;
    waitingVoice.current = null;
    agreed.current = true;
    openPanel(null);
    setByVoice(true);
    if (from) narration.start(from);
    else if (load.error) narration.start(fromLight());
    else setAsking(false);
  };
  /** Headset and keyboard play and pause: never asks, just pauses or carries on. */
  const mediaKey = useRef<(what: 'play' | 'pause' | 'toggle') => void>(() => {});
  mediaKey.current = (what) => {
    if (immersive && !byVoice) {
      if (pacing.running) { if (what !== 'play') pauseLight(); }
      else if (what !== 'pause') carryOn();
      return;
    }
    if (canNarrate) media(what);
  };

  const [start] = useState<Start>(() => {
    if (initial?.pos) return { kind: 'pos', pos: initial.pos };
    const p = initial?.progress ?? record.progress;
    return { kind: 'fraction', value: p >= 1 ? 0 : p, line: initial?.line || record.line };
  });

  // Words read: each page turned or scrolled forward counts; jumps through the contents don't.
  const wordsRead = useRef(initial?.wordsRead ?? 0);
  const lastAt = useRef<number | null>(null);
  // The mark: how far the reader has really read, wherever the book is open (mark.ts). A place saved
  // before there were marks is taken as one.
  const [marker] = useState(() =>
    markTracker(initial?.mark ?? (initial ? { pos: initial.pos ?? { section: 0, block: 0, offset: 0 }, progress: initial.progress, line: initial.line } : undefined), book.words),
  );
  /** Opened well past the mark: the way back to it, offered until taken, closed, or not needed. */
  const [away, setAway] = useState<ReadMark | null>(null);
  const onLocation = useCallback((l: Loc) => {
    setLoc(l);
    const first = lastAt.current === null;
    const moved = first ? 0 : (l.progress - lastAt.current!) * book.words;
    lastAt.current = l.progress;
    if (moved > 0 && moved <= 1500) wordsRead.current += Math.round(moved);
    const pos = { section: l.section, block: l.block, offset: l.offset };
    const before = marker.get();
    const mark = marker.step({ pos, progress: l.progress, line: l.line, screen: l.screen });
    onSave({ pos, progress: l.progress, line: l.line, lastOpened: Date.now(), words: book.words, wordsRead: wordsRead.current, mark });
    const screen = screenWords(l.screen);
    const ahead = (l.progress - mark.progress) * book.words;
    if (first && before && ahead > Math.max(500, screen * 2)) setAway(before);
    else if (ahead <= screen) setAway(null);
  }, [onSave, book.words, marker]);
  const goBack = useCallback(() => {
    if (away) view.current?.listen.reach({ section: away.pos.section, block: away.pos.block, start: away.pos.offset, end: away.pos.offset, text: '' }, 0);
    setAway(null);
  }, [away]);
  const awayToast = useMemo<ToastMessage | null>(() => {
    if (!away) return null;
    const i = chapterAt(chapters, { section: away.pos.section });
    const where = chapters.length > 1 ? `in ${chapterName(chapters, i)}` : book.kind === 'pdf' ? `on page ${away.pos.section + 1}` : 'further back';
    return { id: 1, text: `You were reading ${where} before you jumped here.`, stay: true, action: { label: 'Go back', run: goBack } };
  }, [away, chapters, book.kind, goBack]);

  /* A quick, mostly sideways swipe turns the page in the paged layouts. */
  const paged = (book.kind === 'pdf' ? settings.pdfLayout : settings[settings.style].layout) === 'pages';
  const swipe = useRef<{ x: number; y: number; t: number } | null>(null);
  const swipedAt = useRef(-Infinity);
  const onTouchStart = (e: TouchEvent) => {
    const t = e.touches[0];
    swipe.current = paged && e.touches.length === 1 ? { x: t.clientX, y: t.clientY, t: e.timeStamp } : null;
  };
  const onTouchEnd = (e: TouchEvent) => {
    const s = swipe.current;
    swipe.current = null;
    // A zoomed-in PDF is being moved around, not turned.
    if (!s || closing || e.touches.length || (window.visualViewport?.scale ?? 1) > 1.01) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - s.x;
    const dy = t.clientY - s.y;
    if (Math.abs(dx) < 40 || Math.abs(dx) < Math.abs(dy) * 1.4 || e.timeStamp - s.t > 800) return;
    if (window.getSelection()?.toString()) return;
    swipedAt.current = e.timeStamp;
    view.current?.turn(dx < 0 ? 1 : -1);
  };
  // Scrolled, a hand moving the page stops the light as a tap does, so it neither starts over from the
  // top of the screen nor pulls the page back to where it was: the page is the reader's, until
  // Continue or a tap on a sentence.
  const onHandScroll = () => { if (pacing.running && !paged && !closing) pauseLight(); };
  // The tap zones under a swipe mustn't turn the page a second time.
  const onClickCapture = (e: MouseEvent) => {
    if (e.timeStamp - swipedAt.current < 500) { e.stopPropagation(); e.preventDefault(); }
  };
  // In Immersive without a voice, a tap anywhere stops the light, and a tap on a sentence starts it
  // there. Otherwise touch screens, which have no mouse to wake the controls, wake them with a tap
  // mid-page in focus mode (or while it reads), and hide them again.
  const touched = useRef(false);
  const onPointerDown = (e: PointerEvent) => { touched.current = e.pointerType === 'touch'; };
  const onClick = (e: MouseEvent) => {
    if (e.defaultPrevented || closing) return;
    if ((e.target as HTMLElement).closest('a, button, input, select, textarea')) return;
    if (window.getSelection()?.toString()) return;
    if (pacing.running) { pauseLight(); return; }
    const s = immersive && !narration.playing ? view.current?.listen.pick?.(e.clientX, e.clientY) : null;
    if (s) { tapped(s); return; }
    if (!hush || !touched.current) return;
    if (awake) sleep();
    else wake(3500);
  };

  useEffect(() => {
    if (closing) return;
    // A button clicked keeps the focus, and the browser rings it at the next key: a page turned by
    // key lets go of it first. One reached with Tab keeps its ring.
    let clicked: Element | null = null;
    const onDown = (e: Event) => { clicked = (e.target as Element).closest?.('button') ?? null; };
    const letGo = () => {
      const a = document.activeElement;
      if (a instanceof HTMLElement && a === clicked) a.blur();
    };
    const onKey = (e: KeyboardEvent) => {
      // A keyboard's media keys, where the browser passes them on: play and pause the voice.
      const key = MEDIA_KEYS[e.key];
      if (key) { mediaKey.current(key); e.preventDefault(); return; }
      if (e.key === 'Escape') { if (panel) openPanel(null); else if (choosing) setAsking(false); else onBack(); return; }
      // The browser's own find sees only the chapter on screen: this one reads the whole book.
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'f') { e.preventDefault(); openPanel('find'); return; }
      const target = e.target as HTMLElement;
      if (target.closest('[data-panel], .rpanel, input, textarea, [role="dialog"]')) return;
      if (e.key === 'Enter' && !target.closest('a, button') && onEnter.current()) { e.preventDefault(); return; }
      const scroll = (book.kind === 'pdf' ? settings.pdfLayout : settings[settings.style].layout) === 'scroll';
      if (e.key === 'ArrowRight' || e.key === 'PageDown' || (e.key === ' ' && !e.shiftKey && !scroll)) { letGo(); view.current?.turn(1); e.preventDefault(); }
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp' || (e.key === ' ' && e.shiftKey && !scroll)) { letGo(); view.current?.turn(-1); e.preventDefault(); }
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [panel, choosing, settings, book.kind, onBack, openPanel, closing]);

  // Thin marks in a book colour close to the page (graphite on Night, sand on Day) lean toward the ink.
  const theme: ThemeName = settings.theme;
  useLayoutEffect(() => {
    const el = body.current;
    if (!el) return;
    const cs = getComputedStyle(el);
    const a = hex(cs.getPropertyValue('--book'));
    const b = hex(cs.getPropertyValue('--r-bg'));
    if (!a || !b) { setLowContrast(false); return; }
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    setLowContrast((hi + 0.05) / (lo + 0.05) < 1.8);
  }, [color, theme]);

  // The phone's status bar takes the page's colour while the book is open.
  useEffect(() => {
    const bg = body.current && getComputedStyle(body.current).getPropertyValue('--r-bg').trim();
    if (!bg || closing) return;
    return paintBars(bg);
  }, [theme, closing]);

  const onGo = useCallback((item: TocItem) => view.current?.goTo(item.section, item.anchor), []);
  const onPick = useCallback((f: number) => {
    if (chapters.length < 3) { view.current?.goToFraction(f); return; }
    let at = 0;
    chapters.forEach((c, i) => { if (c.start <= f) at = i; });
    const c = chapters[at];
    view.current?.goTo(c.section, c.anchor);
  }, [chapters]);

  const style = book.kind === 'pdf' ? 'modern' : settings.style;

  const chromeProps: ChromeProps = {
    book, title, loc, chapters, current, settings, update, isPdf: book.kind === 'pdf',
    panel, lastPanel, openPanel, pageW, canRemove: !!onRemove, onBack, onRemove: () => onRemove?.(),
    onGo, onPick, body, closing,
    narration: canNarrate ? {
      playing: narration.playing,
      listening,
      toggle: onPlay,
      read: onRead,
      stop: narration.stop,
      hush: () => { hushed.current = true; narration.stop(); },
      resume: () => narration.start(fromLight()),
    } : null,
    immersion: immersive ? {
      running: pacing.running,
      waiting: !going && !asking,
      choosing,
      begun,
      choose: () => setAsking(true),
      cancel: () => setAsking(false),
      fromTop,
      carryOn,
      paragraphs,
      nowAt,
      pick: (p: Paragraph) => beginAt(p.s),
    } : null,
    focus: { on: focus, toggle: toggleFocus },
    search: { read: readAll, go: goFound },
    sleep: asked ? {
      asked,
      back: backTo,
      // Awake: the voice carries on, from where it stopped if it faded out.
      awake: () => { openPanel(null); if (asked.stopped && !narration.playing && canNarrate) narration.start(); },
    } : null,
  };
  const vars = {
    '--book': `var(--bc-${color})`,
    '--book-ink': `var(--bc-${color}-ink)`,
    '--pw': `${pageW}px`,
  } as CSSProperties;

  return (
    <div className={`rd t-${settings.theme} st-${style}${lowContrast ? ' bk-low' : ''}${hush ? ' is-focus' : ''}${narration.playing ? ' is-aloud' : ''}${listening ? ' is-listening' : ''}${immersive ? ' is-immersed' : ''}${pacing.running ? ' is-pacing' : ''}${awake || panel ? ' is-awake' : ''}${still && !panel ? ' is-still' : ''}`} style={vars}>
      <div className="rd-body" ref={body}>
        <main className="rd-stage" onTouchStart={onTouchStart} onTouchMove={onHandScroll} onTouchEnd={onTouchEnd} onWheel={onHandScroll} onClickCapture={onClickCapture} onPointerDown={onPointerDown} onClick={onClick}>
          {book.kind === 'flow' ? (
            <FlowView ref={view} book={book} style={settings.style} s={settings[settings.style]} start={start} turnStyle="wipe" onLocation={onLocation} onWidth={setPageW} numbered={choosing} />
          ) : (
            <PdfView ref={view} book={book} layout={settings.pdfLayout} start={start} turnStyle="wipe" onLocation={onLocation} onWidth={setPageW} />
          )}
        </main>
        <div className="rd-chrome">
          <InstrumentChrome {...chromeProps} />
        </div>
      </div>
      <Toast className="rd-toast" toast={closing ? null : awayToast} onDone={() => setAway(null)} />
    </div>
  );
}
