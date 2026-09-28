import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useIsPresent, type HTMLMotionProps } from 'motion/react';
import { minutesFor } from '../../../lib/format';
import { springs } from '../../../lib/springs';
import { chapterAtFraction, chapterName, pad2, type Chapter } from '../chapters';
import { canFullscreen, useFullscreen } from '../fullscreen';
import { paceLevel } from '../pacing';
import { AppearancePanel, ContentsPanel } from '../Panels';
import { PACE, setVoicePrefs, stepPace, useVoicePrefs } from '../voice/prefs';
import { level, useLoadState } from '../voice/speaker';
import type { Paragraph } from '../narration';
import { CHECK, CROSS, FOCUS, GROW, MINUS, PAUSE, PLAY, PLUS, SHRINK, VOICES } from './icons';
import { ChapterLabel, CloseDots, Digits, DotIcon, Typed } from './parts';
import { SayAs } from './SayAs';
import { VoiceSheet } from './VoiceSheet';
import type { ChromeProps, PanelName } from './types';

const DROP_CLOSED = 'inset(-12% -24% 100% -24%)';
const DROP_OPEN = 'inset(-12% -24% -40% -24%)';

/**
 * The reader's controls. Doto leads: the page's margins are readouts. The line above the text names the
 * chapter and turns into controls under the pointer; the line below is a dot-matrix of the whole
 * book. Pages change with a hard wipe.
 */
export function InstrumentChrome({ book, title, loc, chapters, current, settings, update, isPdf, panel, openPanel, canRemove, onBack, onRemove, onGo, onPick, body, narration, immersion, focus }: ChromeProps) {
  const [head, setHead] = useState(false);
  const [full, toggleFull] = useFullscreen();
  const [foot, setFoot] = useState(false);
  const progress = loc?.progress ?? 0;
  const label = chapters.length > 1 ? chapterName(chapters, current) : title || book.title;
  const toggle = (k: PanelName) => openPanel(panel === k ? null : k);

  // Play reads aloud and pauses; the button beside it opens the voices and modes.
  const load = useLoadState();
  const loading = !!narration?.playing && load.key !== null;

  // Listening, the dot for where you are becomes a level meter: up to seven dots tall, like a Doto
  // letter, with its neighbours a step behind. Without a voice, it beats at each word lit.
  const footRef = useRef<HTMLDivElement>(null);
  const listening = !!narration?.listening;
  const meter = listening ? 'voice' : immersion?.running ? 'pace' : null;
  useEffect(() => {
    const el = footRef.current;
    if (!meter || !el || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const source = meter === 'voice' ? level : paceLevel;
    let raf = 0;
    let lv = 0;
    let step = -1;
    const tick = () => {
      // Up at once, down gently, so it doesn't flicker between words.
      const now = source();
      lv = now > lv ? now : lv * 0.88 + now * 0.12;
      const s = lv < 0.1 ? 0 : lv < 0.3 ? 1 : lv < 0.55 ? 2 : 3;
      if (s !== step) { step = s; el.dataset.lv = String(s); }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(raf); delete el.dataset.lv; };
  }, [meter]);

  // Immersive without a voice asks its pace on the bottom line, until one is kept; then it's in the
  // voice sheet, and the line says so for a moment.
  const { paceKept } = useVoicePrefs();
  const setting = !!immersion?.running && !paceKept;
  const [kept, setKept] = useState(false);
  useEffect(() => {
    if (!kept) return;
    const t = window.setTimeout(() => setKept(false), 2600);
    return () => window.clearTimeout(t);
  }, [kept]);
  const keep = () => { setVoicePrefs({ paceKept: true }); setKept(true); };
  const tap = typeof matchMedia === 'function' && matchMedia('(hover: none)').matches ? 'Tap' : 'Click';
  const choosing = !!immersion?.choosing;

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
              className={`i3-side i3-listen${narration.playing ? ' is-playing' : ''}`}
              onClick={narration.toggle}
              aria-label={narration.playing ? 'Pause reading aloud' : 'Read aloud'}
              aria-pressed={narration.playing}
            >
              <DotIcon rows={narration.playing && !loading ? PAUSE : PLAY} lit={loading ? load.loaded / Math.max(1, load.total) : undefined} />
            </button>
          )}
          {(narration || immersion) && (
            <button
              type="button"
              className={`i3-side i3-icon i3-voices${panel === 'voice' ? ' is-open' : ''}`}
              onClick={() => toggle('voice')}
              aria-label="Voices and modes"
              aria-expanded={panel === 'voice'}
              aria-haspopup="dialog"
            >
              <DotIcon rows={VOICES} />
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

      <div ref={footRef} className={`i3-foot${foot ? ' is-on' : ''}${setting ? ' is-setting' : ''}${immersion?.waiting ? ' is-waiting' : ''}${choosing ? ' is-choosing' : ''}`} onPointerEnter={() => setFoot(true)} onPointerLeave={() => setFoot(false)}>
        {setting ? (
          <PaceSetter onKeep={keep} />
        ) : immersion && choosing ? (
          // Begin, pressed: from the top of the page, or a paragraph by its number.
          <div className="i3-start" role="group" aria-label="Where to begin">
            <button type="button" className="i3-begin" onClick={immersion.fromTop}>
              <DotIcon rows={PLAY} />
              From the top
            </button>
            <button type="button" className={`i3-para${panel === 'paras' ? ' is-open' : ''}`} onClick={() => toggle('paras')} aria-label="Pick a paragraph" aria-expanded={panel === 'paras'} aria-haspopup="dialog">
              ¶ {immersion.nowAt ? pad2(immersion.nowAt) : '--'}
              <span className="i3-caret" aria-hidden="true">▾</span>
            </button>
            <button type="button" className="i3-pace-b" onClick={immersion.cancel} aria-label="Not now">
              <DotIcon rows={CROSS} />
            </button>
          </div>
        ) : (
          <>
            <span className="i3-read"><Digits value={progress * 100} width={3} /><small>%</small></span>
            {immersion?.waiting ? (
              // Immersive, nothing lit yet: Begin numbers the paragraphs, to pick where.
              <span className="i3-say">
                <button type="button" className="i3-begin" onClick={immersion.choose}>
                  <DotIcon rows={PLAY} />
                  Begin
                </button>
              </span>
            ) : kept ? (
              <span className="i3-say" role="status"><Typed text="Kept. Change it in" /><DotIcon rows={VOICES} /></span>
            ) : (
              <Dots chapters={chapters} progress={progress} onPick={onPick} />
            )}
            <span className="i3-read is-right">
              {loc && <><Digits value={minutesFor(loc.sectionWordsLeft)} width={2} /><small>min</small></>}
            </span>
          </>
        )}
      </div>

      {choosing && !panel && (
        <div className="i3-hint" role="status"><Typed text={`${tap} a paragraph, or type its number`} /></div>
      )}

      {/* Clear, so nothing to fade: it goes with the tap that closes the drop, never left over the page. */}
      {panel && <div className="i3-scrim" onClick={() => openPanel(null)} />}
      <AnimatePresence>
        {panel && (
          <Drop
            key={panel}
            className={`i3-drop is-${panel}`}
            data-panel
            initial={{ clipPath: DROP_CLOSED, y: -6 }}
            animate={{ clipPath: DROP_OPEN, y: 0 }}
            exit={{ clipPath: DROP_CLOSED, y: -6 }}
            transition={springs.snappy}
          >
            {/* The drop keeps its close button in place; what's in it scrolls. */}
            <div className="i3-drop-in">
              {panel === 'toc' ? (
                <ContentsPanel book={book} title={title} loc={loc} canRemove={canRemove} onGo={(it) => { openPanel(null); onGo(it); }} onRemove={onRemove} />
              ) : panel === 'voice' && (narration || immersion) ? (
                <VoiceSheet playing={!!narration?.playing} onStart={narration?.start} onStop={narration?.stop} canPace={!!immersion} />
              ) : panel === 'paras' && immersion ? (
                <ParagraphsPanel list={immersion.paragraphs} now={immersion.nowAt} onPick={(p) => { openPanel(null); immersion.pick(p); }} tap={tap} />
              ) : (
                <AppearancePanel settings={settings} isPdf={isPdf} update={update} />
              )}
            </div>
            <CloseDots onClick={() => openPanel(null)} />
          </Drop>
        )}
      </AnimatePresence>

      {narration && <SayAs narration={narration} body={body} />}
    </>
  );
}

/** A drop on its way out takes no taps, so one that never quite leaves can't sit over the page. */
function Drop(props: HTMLMotionProps<'div'>) {
  const present = useIsPresent();
  return <motion.div {...props} style={present ? props.style : { ...props.style, pointerEvents: 'none' }} />;
}

/**
 * Where the light begins: a paragraph's number, typed (Enter or Go), or picked from the chapter's
 * list, which opens on the first paragraph on screen.
 */
function ParagraphsPanel({ list, now, onPick, tap }: { list: Paragraph[]; now?: number; onPick: (p: Paragraph) => void; tap: string }) {
  const [typed, setTyped] = useState('');
  const hit = typed ? list.find((p) => p.n === Number(typed)) : undefined;
  const input = useRef<HTMLInputElement>(null);
  const rows = useRef<HTMLDivElement>(null);
  // A mouse types straight away; a touch screen's keyboard waits for a tap in the field.
  useEffect(() => { if (!matchMedia('(hover: none)').matches) input.current?.focus(); }, []);
  // The typed one, or the first on screen, in the middle of the list under the field. By hand, not
  // scrollIntoView, which would move the page behind too.
  const head = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const row = rows.current?.querySelector<HTMLElement>(`[data-n="${hit?.n ?? now}"]`);
    const box = row?.closest<HTMLElement>('.i3-drop-in');
    if (!row || !box) return;
    const top = head.current?.offsetHeight ?? 0;
    box.scrollTop = row.offsetTop - top - (box.clientHeight - top) / 2 + row.offsetHeight / 2;
  }, [hit, now]);
  const go = () => { if (hit) onPick(hit); };
  return (
    <div className="pnl pp">
      <div className="pp-head" ref={head}>
        <div className="pnl-h">Begin from</div>
        <p className="p-note pp-about">{tap} a paragraph on the page, or type its number.</p>
        <div className="sa-say">
          <input
            ref={input}
            className="vs-input"
            value={typed}
            onChange={(e) => setTyped(e.target.value.replace(/\D/g, '').slice(0, 4))}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } }}
            inputMode="numeric"
            pattern="[0-9]*"
            enterKeyHint="go"
            placeholder={now ? pad2(now) : ''}
            autoComplete="off"
            aria-label="Paragraph number"
          />
          <button type="button" className="sa-hear" onClick={go} disabled={!hit}>
            <DotIcon rows={PLAY} />
            Go
          </button>
        </div>
      </div>
      <div className="p-list pp-list" ref={rows}>
        {list.map((p) => (
          <button key={p.n} type="button" data-n={p.n} className={`p-item pp-item${p.n === now ? ' is-now' : ''}${p.n === hit?.n ? ' is-hit' : ''}`} onClick={() => onPick(p)}>
            <span className="pp-n">{pad2(p.n)}</span>
            <span className="p-item-t">{p.s.text.trim()}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** Immersive's pace, asked on the bottom line the first time the light moves on its own. */
function PaceSetter({ onKeep }: { onKeep: () => void }) {
  const { pace } = useVoicePrefs();
  return (
    <div className="i3-pace" role="group" aria-label="Pace">
      <button type="button" className="i3-pace-b" onClick={() => stepPace(-1)} disabled={pace <= PACE.min} aria-label="Slower">
        <DotIcon rows={MINUS} />
      </button>
      <span className="i3-read"><Digits value={pace} width={3} /><small>wpm</small></span>
      <button type="button" className="i3-pace-b" onClick={() => stepPace(1)} disabled={pace >= PACE.max} aria-label="Faster">
        <DotIcon rows={PLUS} />
      </button>
      <button type="button" className="i3-pace-keep" onClick={onKeep}>
        <DotIcon rows={CHECK} />
        Keep
      </button>
    </div>
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
