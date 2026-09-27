import { useLayoutEffect, useRef, useState, type PointerEvent } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { minutesFor } from '../../../lib/format';
import { springs } from '../../../lib/springs';
import { chapterAtFraction, chapterName, type Chapter } from '../chapters';
import { canFullscreen, useFullscreen } from '../fullscreen';
import { AppearancePanel, ContentsPanel } from '../Panels';
import { useLoadState } from '../voice/speaker';
import { FOCUS, GROW, PAUSE, PLAY, SHRINK } from './icons';
import { ChapterLabel, Digits, DotIcon, Typed } from './parts';
import { VoiceSheet } from './VoiceSheet';
import type { ChromeProps, PanelName } from './types';

const DROP_CLOSED = 'inset(-12% -24% 100% -24%)';
const DROP_OPEN = 'inset(-12% -24% -40% -24%)';

/**
 * The reader's controls. Doto leads: the page's margins are readouts. The line above the text names the
 * chapter and turns into controls under the pointer; the line below is a dot-matrix of the whole
 * book. Pages change with a hard wipe.
 */
export function InstrumentChrome({ book, title, loc, chapters, current, settings, update, isPdf, panel, openPanel, canRemove, onBack, onRemove, onGo, onPick, narration, focus }: ChromeProps) {
  const [head, setHead] = useState(false);
  const [full, toggleFull] = useFullscreen();
  const [foot, setFoot] = useState(false);
  const progress = loc?.progress ?? 0;
  const label = chapters.length > 1 ? chapterName(chapters, current) : title || book.title;
  const toggle = (k: PanelName) => openPanel(panel === k ? null : k);

  // Play reads aloud; held down (or right-clicked) it opens the voice sheet instead.
  const load = useLoadState();
  const loading = !!narration?.playing && load.key !== null;
  const hold = useRef(0);
  const held = useRef(false);
  const press = (e: PointerEvent) => {
    if (e.button !== 0) return;
    held.current = false;
    window.clearTimeout(hold.current);
    hold.current = window.setTimeout(() => {
      held.current = true;
      navigator.vibrate?.(8);
      openPanel('voice');
    }, 450);
  };
  const letGo = () => window.clearTimeout(hold.current);
  const tapPlay = () => {
    if (held.current) { held.current = false; return; }
    narration?.toggle();
  };

  return (
    <>
      <div className={`i3-head${head || panel ? ' is-on' : ''}`} onPointerEnter={() => setHead(true)} onPointerLeave={() => setHead(false)}>
        <button type="button" className="i3-side" onClick={onBack} aria-label="Back to library">‹<span className="i3-back-word"> Library</span></button>
        <button type="button" className={`i3-mid${panel === 'toc' ? ' is-open' : ''}`} onClick={() => toggle('toc')} aria-label={`Contents. ${label}`} aria-expanded={panel === 'toc'}>
          <Typed text={label} />
          <span className="i3-caret" aria-hidden="true">▾</span>
        </button>
        <div className="i3-ends">
          {narration && (
            <button
              type="button"
              className={`i3-side i3-listen${narration.playing ? ' is-playing' : ''}${panel === 'voice' ? ' is-open' : ''}`}
              onClick={tapPlay}
              onPointerDown={press}
              onPointerUp={letGo}
              onPointerLeave={letGo}
              onPointerCancel={letGo}
              onContextMenu={(e) => { e.preventDefault(); letGo(); openPanel('voice'); }}
              aria-label={narration.playing ? 'Stop reading aloud' : 'Read aloud. Hold for voices'}
              aria-pressed={narration.playing}
              aria-haspopup="dialog"
            >
              <DotIcon rows={narration.playing && !loading ? PAUSE : PLAY} lit={loading ? load.loaded / Math.max(1, load.total) : undefined} />
            </button>
          )}
          <button type="button" className={`i3-side${panel === 'look' ? ' is-open' : ''}`} onClick={() => toggle('look')} aria-label="Appearance" aria-expanded={panel === 'look'}>Aa</button>
          <button type="button" className={`i3-side i3-icon${focus.on ? ' is-open' : ''}`} onClick={focus.toggle} aria-label="Focus" aria-pressed={focus.on}>
            <DotIcon rows={FOCUS} />
          </button>
          {canFullscreen() && (
            <button type="button" className={`i3-side i3-icon${full ? ' is-open' : ''}`} onClick={toggleFull} aria-label="Full screen" aria-pressed={full}>
              <DotIcon rows={full ? SHRINK : GROW} />
            </button>
          )}
        </div>
      </div>

      <div className={`i3-foot${foot ? ' is-on' : ''}`} onPointerEnter={() => setFoot(true)} onPointerLeave={() => setFoot(false)}>
        <span className="i3-read"><Digits value={progress * 100} width={3} /><small>%</small></span>
        <Dots chapters={chapters} progress={progress} onPick={onPick} />
        <span className="i3-read is-right">
          {loc && <><Digits value={minutesFor(loc.sectionWordsLeft)} width={2} /><small>min</small></>}
        </span>
      </div>

      <AnimatePresence>
        {panel && <motion.div key="scrim" className="i3-scrim" onClick={() => openPanel(null)} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} />}
        {panel && (
          <motion.div
            key={panel}
            className={`i3-drop is-${panel}`}
            data-panel
            initial={{ clipPath: DROP_CLOSED, y: -6 }}
            animate={{ clipPath: DROP_OPEN, y: 0 }}
            exit={{ clipPath: DROP_CLOSED, y: -6 }}
            transition={springs.snappy}
          >
            {panel === 'toc' ? (
              <ContentsPanel book={book} title={title} loc={loc} canRemove={canRemove} onGo={(it) => { openPanel(null); onGo(it); }} onRemove={onRemove} />
            ) : panel === 'voice' && narration ? (
              <VoiceSheet playing={narration.playing} onStart={narration.start} onStop={narration.stop} />
            ) : (
              <AppearancePanel settings={settings} isPdf={isPdf} update={update} />
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

const PITCH = 8;
const SPLIT = 5;

/** The whole book as a row of square dots: lit in the book's colour as you read, grouped by chapter. */
function Dots({ chapters, progress, onPick }: { chapters: Chapter[]; progress: number; onPick: (f: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  const [hover, setHover] = useState<{ k: number; x: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current!;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // The row always fits the width it's given (the column can shrink below it), so it follows the
  // bar when it narrows: switching to scroll, leaving a two-page spread, a smaller window.
  // Chapter gaps only when they leave room for a dozen dots.
  const splits = chapters.length - 1;
  const grouped = chapters.length >= 3 && chapters.length <= 40 && w - splits * SPLIT >= 12 * PITCH;
  const n = Math.max(1, Math.min(120, Math.floor((w - (grouped ? splits * SPLIT : 0)) / PITCH)));
  const dots = Array.from({ length: n }, (_, i) => {
    const f0 = i / n;
    const f1 = (i + 1) / n;
    return { f: (f0 + f1) / 2, ch: chapterAtFraction(chapters, (f0 + f1) / 2), state: f1 <= progress ? 'read' : f0 <= progress ? 'now' : 'next' };
  });
  const hoverCh = hover ? dots[hover.k]?.ch : null;

  return (
    <div
      ref={ref}
      className="i3-dots"
      role="group"
      aria-label="Progress through the book"
      onPointerLeave={() => setHover(null)}
      onClick={() => { if (hover && dots[hover.k]) onPick(dots[hover.k].f); }}
    >
      {w > 0 && dots.map((d, k) => (
        <span
          key={k}
          className={`i3-dot is-${d.state}${grouped && k > 0 && dots[k - 1].ch !== d.ch ? ' is-split' : ''}${hoverCh === d.ch ? ' is-hover' : ''}`}
          onPointerEnter={(e) => setHover({ k, x: e.currentTarget.offsetLeft })}
        />
      ))}
      {hover && dots[hover.k] && (
        <div className="i3-tip" style={{ left: Math.max(110, Math.min(w - 110, hover.x)) }}>
          <ChapterLabel chapters={chapters} i={dots[hover.k].ch} f={dots[hover.k].f} />
        </div>
      )}
    </div>
  );
}
