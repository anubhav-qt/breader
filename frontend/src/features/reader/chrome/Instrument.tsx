import { useLayoutEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { minutesFor } from '../../../lib/format';
import { springs } from '../../../lib/springs';
import { chapterAtFraction, chapterName, type Chapter } from '../chapters';
import { AppearancePanel, ContentsPanel } from '../Panels';
import { ChapterLabel, Digits, Typed } from './parts';
import type { ChromeProps, PanelName } from './types';

const DROP_CLOSED = 'inset(-12% -24% 100% -24%)';
const DROP_OPEN = 'inset(-12% -24% -40% -24%)';

/**
 * The reader's controls. Doto leads: the page's margins are readouts. The line above the text names the
 * chapter and turns into controls under the pointer; the line below is a dot-matrix of the whole
 * book. Pages change with a hard wipe.
 */
export function InstrumentChrome({ book, title, loc, chapters, current, settings, update, isPdf, panel, openPanel, canRemove, onBack, onRemove, onGo, onPick }: ChromeProps) {
  const [head, setHead] = useState(false);
  const [foot, setFoot] = useState(false);
  const progress = loc?.progress ?? 0;
  const label = chapters.length > 1 ? chapterName(chapters, current) : title || book.title;
  const toggle = (k: PanelName) => openPanel(panel === k ? null : k);

  return (
    <>
      <div className={`i3-head${head || panel ? ' is-on' : ''}`} onPointerEnter={() => setHead(true)} onPointerLeave={() => setHead(false)}>
        <button type="button" className="i3-side" onClick={onBack} aria-label="Back to library">‹ Library</button>
        <button type="button" className={`i3-mid${panel === 'toc' ? ' is-open' : ''}`} onClick={() => toggle('toc')} aria-label={`Contents. ${label}`} aria-expanded={panel === 'toc'}>
          <Typed text={label} />
          <span className="i3-caret" aria-hidden="true">▾</span>
        </button>
        <button type="button" className={`i3-side${panel === 'look' ? ' is-open' : ''}`} onClick={() => toggle('look')} aria-label="Appearance" aria-expanded={panel === 'look'}>Aa</button>
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

  const grouped = chapters.length >= 3 && chapters.length <= 40;
  const n = Math.max(12, Math.min(120, Math.floor((w - (grouped ? (chapters.length - 1) * SPLIT : 0)) / PITCH)));
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
