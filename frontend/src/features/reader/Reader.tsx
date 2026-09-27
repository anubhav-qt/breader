import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type PointerEvent, type TouchEvent } from 'react';
import type { BookRecord, LoadedBook, ReadState, TocItem } from '../../books/types';
import { paintBars } from '../../lib/bars';
import { chapterAt, chaptersOf } from './chapters';
import { InstrumentChrome } from './chrome/Instrument';
import type { ChromeProps, PanelName } from './chrome/types';
import { FlowView, type Loc, type Start, type ViewHandle } from './FlowView';
import { useFocusMode, useWake } from './focus';
import { useFullscreenReading } from './fullscreen';
import { canNarrate, useNarration } from './narration';
import { PdfView } from './PdfView';
import { refreshVoices } from './voice/list';
import { useReaderSettings, type ThemeName } from './settings';
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

  const narration = useNarration(view, !closing, loc, () => openPanel('voice'));
  // Voices readers uploaded, so the one picked last time is known.
  useEffect(() => { if (canNarrate) void refreshVoices(); }, []);
  useReadingClock(!closing, onReadTime, narration.busy);
  useFullscreenReading(!closing);
  const [focus, toggleFocus] = useFocusMode();
  const { awake, still, wake, sleep } = useWake(!closing);
  // Opening in focus mode shows where the controls are before they go.
  useEffect(() => { if (focus) wake(1800); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const [start] = useState<Start>(() => {
    if (initial?.pos) return { kind: 'pos', pos: initial.pos };
    const p = initial?.progress ?? record.progress;
    return { kind: 'fraction', value: p >= 1 ? 0 : p, line: initial?.line || record.line };
  });

  // Words read: each page turned or scrolled forward counts; jumps through the contents don't.
  const wordsRead = useRef(initial?.wordsRead ?? 0);
  const lastAt = useRef<number | null>(null);
  const onLocation = useCallback((l: Loc) => {
    setLoc(l);
    const moved = lastAt.current === null ? 0 : (l.progress - lastAt.current) * book.words;
    lastAt.current = l.progress;
    if (moved > 0 && moved <= 1500) wordsRead.current += Math.round(moved);
    onSave({ pos: { section: l.section, block: l.block, offset: l.offset }, progress: l.progress, line: l.line, lastOpened: Date.now(), words: book.words, wordsRead: wordsRead.current });
  }, [onSave, book.words]);

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
  // The tap zones under a swipe mustn't turn the page a second time.
  const onClickCapture = (e: MouseEvent) => {
    if (e.timeStamp - swipedAt.current < 500) { e.stopPropagation(); e.preventDefault(); }
  };
  // Touch screens have no mouse to wake the controls: in focus mode a tap mid-page does, and hides them again.
  const touched = useRef(false);
  const onPointerDown = (e: PointerEvent) => { touched.current = e.pointerType === 'touch'; };
  const onClick = (e: MouseEvent) => {
    if (!focus || !touched.current || e.defaultPrevented || closing) return;
    if ((e.target as HTMLElement).closest('a, button, input, select, textarea')) return;
    if (window.getSelection()?.toString()) return;
    if (awake) sleep();
    else wake(3500);
  };

  useEffect(() => {
    if (closing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { if (panel) openPanel(null); else onBack(); return; }
      const target = e.target as HTMLElement;
      if (target.closest('[data-panel], .rpanel, input, textarea, [role="dialog"]')) return;
      const scroll = (book.kind === 'pdf' ? settings.pdfLayout : settings[settings.style].layout) === 'scroll';
      if (e.key === 'ArrowRight' || e.key === 'PageDown' || (e.key === ' ' && !e.shiftKey && !scroll)) { view.current?.turn(1); e.preventDefault(); }
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp' || (e.key === ' ' && e.shiftKey && !scroll)) { view.current?.turn(-1); e.preventDefault(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [panel, settings, book.kind, onBack, openPanel, closing]);

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
    narration: canNarrate ? { playing: narration.playing, toggle: narration.toggle, start: narration.start, stop: narration.stop } : null,
    focus: { on: focus, toggle: toggleFocus },
  };
  const vars = {
    '--book': `var(--bc-${color})`,
    '--book-ink': `var(--bc-${color}-ink)`,
    '--pw': `${pageW}px`,
  } as CSSProperties;

  return (
    <div className={`rd t-${settings.theme} st-${style}${lowContrast ? ' bk-low' : ''}${focus ? ' is-focus' : ''}${awake || panel ? ' is-awake' : ''}${still && !panel ? ' is-still' : ''}`} style={vars}>
      <div className="rd-body" ref={body}>
        <main className="rd-stage" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd} onClickCapture={onClickCapture} onPointerDown={onPointerDown} onClick={onClick}>
          {book.kind === 'flow' ? (
            <FlowView ref={view} book={book} style={settings.style} s={settings[settings.style]} start={start} turnStyle="wipe" onLocation={onLocation} onWidth={setPageW} />
          ) : (
            <PdfView ref={view} book={book} layout={settings.pdfLayout} start={start} turnStyle="wipe" onLocation={onLocation} onWidth={setPageW} />
          )}
        </main>
        <div className="rd-chrome">
          <InstrumentChrome {...chromeProps} />
        </div>
      </div>
    </div>
  );
}
