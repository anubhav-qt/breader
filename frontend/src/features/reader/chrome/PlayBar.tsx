import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { springs } from '../../../lib/springs';
import { readLocal, writeLocal } from '../../../lib/store';
import type { PlayDesign } from '../../design/round';
import { unlockMusic } from '../music';
import { setVoicePrefs, useVoicePrefs } from '../voice/prefs';
import { useLoadState } from '../voice/speaker';
import { BACK, CROSS, LIGHT, ON, PAUSE, PLAY, UP, VOICES } from './icons';
import { DotIcon, Typed } from './parts';
import { HeadTips } from './Tip';
import type { ChromeProps, PanelName } from './types';
import { NotYet } from './VoiceSheet';
import './play.css';

/*
 * The play row, over the bottom line: play and pause, back and on a sentence, the voices, and
 * Immersive in sight rather than in the voice sheet. Each design of this round (design/round.ts):
 *
 *   A Deck    Read, Listen or Immersive on the left, back, play and on in the middle, the voices on the right
 *   B Split   two pills, Listen and Immersive, each starting its own way of reading
 *   C Nudge   one play button; a note, once, says Immersive is there, and the voices wear a dot
 *   D Modes   Read, Listen and Immersive as one switch, with the player beside it
 *   E Peek    a slim strip that opens a tray with all of it
 *
 * While Immersive asks something (where to begin, how fast), the question takes the row. In A and
 * D, picking a way never starts it: play does. Picking Immersive asks, just above the switch,
 * whether to read or listen, with the music there too.
 */

type Props = Pick<ChromeProps, 'book' | 'narration' | 'immersion' | 'transport' | 'panel' | 'body' | 'music' | 'letAi'> & {
  design: PlayDesign;
  toggle: (p: PanelName) => void;
  /** Immersive's question, asked on the row in place of the player: where to begin, or the pace. */
  ask: ReactNode;
  /** A voice speaking now, for the character voices' speaker chip (design round). */
  speaker?: ReactNode;
};

/** What Listen and Immersive start, once the mode they need has come in. */
type Want = 'listen' | 'light' | null;
/** How the book is read: just the page, a voice reading it, or the words lighting up. */
type Way = 'read' | 'listen' | 'immersive';

const SEEN_VOICES = 'breader.play.voices-seen.v1';
const NUDGED = 'breader.play.nudged.v1';
/** Read or Listen, as last picked, outside Immersive. */
const WAY = 'breader.play.way.v1';

export function PlayBar({ book, narration, immersion, transport, panel, body, music, letAi, design, toggle, ask, speaker }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const { mode } = useVoicePrefs();
  const canImmerse = book.kind === 'flow';
  const load = useLoadState();
  const loading = !!narration?.playing && load.key !== null;
  const going = !!narration?.playing || !!immersion?.running;

  // A switch of mode lands on the next render, and only then can its way of reading start.
  const [want, setWant] = useState<Want>(null);
  useEffect(() => {
    if (want === 'light' && immersion) {
      setWant(null);
      immersion.choose();
    }
    if (want === 'listen' && mode === 'normal' && narration) {
      setWant(null);
      narration.read();
    }
  }, [want, immersion, narration, mode]);

  /** Whatever is going stops, and the mode changes. */
  const switchTo = (m: 'normal' | 'immersive', then: Want) => {
    if (narration?.playing) narration.stop();
    if (immersion?.running) immersion.pause();
    if (m !== mode) setVoicePrefs({ mode: m });
    setWant(then);
  };
  const listen = () => {
    if (mode === 'normal' && narration) {
      narration.toggle();
      return;
    }
    switchTo('normal', 'listen');
  };
  const light = () => {
    if (immersion) {
      if (narration?.playing) narration.toggle();
      else if (immersion.running) immersion.pause();
      else immersion.choose();
      return;
    }
    switchTo('immersive', 'light');
  };

  // The voices button wears a dot until its sheet has been opened once (C).
  const [seen, setSeen] = useState(() => readLocal<boolean>(SEEN_VOICES, false));
  useEffect(() => {
    if (panel !== 'voice' || seen) return;
    setSeen(true);
    writeLocal(SEEN_VOICES, true);
  }, [panel, seen]);

  const main = mainAction(narration, immersion);
  const bits: Bits = { main, loading, lit: load.loaded / Math.max(1, load.total), transport, going };
  const voices = (
    <VoicesButton open={panel === 'voice'} dot={design === 'C' && !seen} onClick={() => toggle('voice')} />
  );
  // In Immersive, play lights the words; a voice reading them is a button of its own.
  const aloud = immersion && narration && !narration.playing && !immersion.running && (
    <button type="button" className="pl-chip" onClick={narration.toggle} data-tip="Read aloud, from where you pick">
      <DotIcon rows={PLAY} />
      <span>Voice</span>
    </button>
  );

  // A and D: how it's read now, and a pick of another. Read or Listen is kept as picked, and a voice
  // started any other way (play in Read, a media key, the voice sheet) makes it Listen.
  const [chosen, setChosen] = useState<Way>(() => readLocal<Way>(WAY, 'read'));
  const keepWay = (v: Way) => {
    setChosen(v);
    writeLocal(WAY, v);
  };
  const normalVoice = mode === 'normal' && !!narration?.playing;
  useEffect(() => {
    if (normalVoice && chosen !== 'listen') keepWay('listen');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [normalVoice]);
  let now: Way = chosen;
  if (now === 'listen' && !narration) now = 'read';
  if (immersion) now = 'immersive';
  else if (normalVoice) now = 'listen';

  // Immersive's question, just above the switch: read or listen, and the music.
  const [card, setCard] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  const asking = !!ask;
  useEffect(() => {
    if (panel || asking) setCard(false);
  }, [panel, asking]);
  const pick = (v: Way) => {
    if (v === 'immersive') {
      if (now === 'immersive') {
        setCard(!card);
        return;
      }
      switchTo('immersive', null);
      setCard(true);
      return;
    }
    setCard(false);
    keepWay(v);
    if (v === now) return;
    switchTo('normal', null);
  };
  const modes = (
    <span className="pl-mw" ref={wrap}>
      <Modes now={now} canListen={!!narration} canImmerse={canImmerse} onPick={pick} />
      <AnimatePresence>
        {card && immersion && (
          <ImmersiveCard
            key="card"
            wrap={wrap}
            voice={immersion.voice}
            canListen={!!narration}
            music={music}
            onAi={letAi}
            onPick={(voice) => {
              setCard(false);
              if (voice !== immersion.voice) immersion.by(voice);
            }}
            onClose={() => setCard(false)}
          />
        )}
      </AnimatePresence>
    </span>
  );

  let row: ReactNode;
  if (ask) {
    row = <div className="pl-ask">{ask}</div>;
  } else if (design === 'A') {
    row = (
      <>
        <span className="pl-l">{modes}</span>
        <Transport {...bits} />
        <span className="pl-r">{voices}</span>
      </>
    );
  } else if (design === 'B') {
    row = (
      <>
        <span className="pl-l">{going && <Skips transport={transport} />}</span>
        <Split mode={mode} canImmerse={canImmerse} narration={narration} immersion={immersion} loading={loading} onListen={listen} onLight={light} onLeave={() => switchTo('normal', null)} />
        <span className="pl-r">{voices}</span>
      </>
    );
  } else if (design === 'C') {
    row = (
      <>
        <span className="pl-l">
          {immersion && <LeaveTag onLeave={() => switchTo('normal', null)} />}
          {speaker}
        </span>
        <Transport {...bits} />
        <span className="pl-r">{aloud}{voices}</span>
        {canImmerse && !immersion && <Nudge going={going} onTry={() => switchTo('immersive', 'light')} />}
      </>
    );
  } else if (design === 'D') {
    row = (
      <>
        {modes}
        <span className="pl-r">
          {speaker}
          <Transport {...bits} small />
          {voices}
        </span>
      </>
    );
  } else {
    row = <Peek bits={bits} mode={mode} canImmerse={canImmerse} narration={narration} immersion={immersion} panel={panel} aloud={aloud} voices={voices} onListen={listen} onLight={light} onMode={(m) => switchTo(m, null)} />;
  }

  return (
    <div ref={ref} className={`i3-play pl-${design}${ask ? ' is-asking' : ''}${going ? ' is-going' : ''}`} role="group" aria-label="Play">
      {row}
      <HeadTips bar={ref} area={body} />
    </div>
  );
}

interface Main {
  icon: string[];
  label: string;
  /** Said under play where there's room: what it does now. */
  word: string;
  act: () => void;
}

/** Play's job now: pause what's going, or start the voice (Normal) or the light (Immersive). */
function mainAction(narration: Props['narration'], immersion: Props['immersion']): Main | null {
  if (narration?.playing) return { icon: PAUSE, label: 'Pause the voice', word: 'Pause', act: narration.toggle };
  if (immersion?.running) return { icon: PAUSE, label: 'Pause the light', word: 'Pause', act: immersion.pause };
  if (immersion) {
    const word = immersion.begun ? 'Continue' : 'Begin';
    let label = `${word}: light the words at your pace`;
    if (immersion.voice) label = `${word}: a voice reads as the words light up`;
    return { icon: PLAY, label, word, act: immersion.choose };
  }
  if (narration) return { icon: PLAY, label: 'Read aloud from here', word: 'Listen', act: narration.toggle };
  return null;
}

interface Bits {
  main: Main | null;
  loading: boolean;
  lit: number;
  transport: Props['transport'];
  going: boolean;
}

/** Back a sentence, play or pause, on a sentence. */
function Transport({ main, loading, lit, transport, small = false }: Bits & { small?: boolean }) {
  if (!main) return null;
  let icon = main.icon;
  if (loading) icon = PLAY;
  return (
    <span className={`pl-deck${small ? ' is-small' : ''}`}>
      <Skip dir={-1} transport={transport} />
      <button type="button" className="pl-icon pl-main" onClick={main.act} aria-label={main.label} data-tip={main.label}>
        <DotIcon rows={icon} lit={loading ? lit : undefined} />
      </button>
      <Skip dir={1} transport={transport} />
    </span>
  );
}

function Skip({ dir, transport }: { dir: -1 | 1; transport: Props['transport'] }) {
  const label = dir < 0 ? 'The sentence before' : 'The next sentence';
  return (
    <button type="button" className="pl-skip" onClick={() => transport.step(dir)} aria-label={label} data-tip={label}>
      <DotIcon rows={dir < 0 ? BACK : ON} />
    </button>
  );
}

function Skips({ transport }: { transport: Props['transport'] }) {
  return (
    <span className="pl-skips">
      <Skip dir={-1} transport={transport} />
      <Skip dir={1} transport={transport} />
    </span>
  );
}

function VoicesButton({ open, dot, onClick }: { open: boolean; dot: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className={`pl-icon pl-voices${open ? ' is-open' : ''}${dot ? ' has-dot' : ''}`}
      onClick={onClick}
      aria-label="Voices and modes"
      aria-expanded={open}
      aria-haspopup="dialog"
      data-tip="Voices, speed and Immersive"
    >
      <DotIcon rows={VOICES} />
    </button>
  );
}

/** E's tray: Normal or Immersive, as a small switch. */
function ModeSwitch({ mode, onPick }: { mode: 'normal' | 'immersive'; onPick: (m: 'normal' | 'immersive') => void }) {
  return (
    <span className="pl-seg" role="radiogroup" aria-label="Mode">
      <button type="button" role="radio" aria-checked={mode === 'normal'} className={mode === 'normal' ? 'is-on' : ''} onClick={() => onPick('normal')} data-tip="The page as it is, the voice reading along">
        Normal
      </button>
      <button type="button" role="radio" aria-checked={mode === 'immersive'} className={mode === 'immersive' ? 'is-on' : ''} onClick={() => onPick('immersive')} data-tip="The page dims, and the words light up as you read">
        <DotIcon rows={LIGHT} />
        Immersive
      </button>
    </span>
  );
}

/** B: Listen and Immersive, side by side, each its own way in. */
function Split({ mode, canImmerse, narration, immersion, loading, onListen, onLight, onLeave }: {
  mode: 'normal' | 'immersive';
  canImmerse: boolean;
  narration: Props['narration'];
  immersion: Props['immersion'];
  loading: boolean;
  onListen: () => void;
  onLight: () => void;
  onLeave: () => void;
}) {
  const listening = mode === 'normal' && !!narration?.playing;
  let listenIcon = PLAY;
  let listenWord = 'Listen';
  if (listening && !loading) {
    listenIcon = PAUSE;
    listenWord = 'Pause';
  }
  let lightWord = 'Immersive';
  let lightIcon = LIGHT;
  if (immersion) {
    if (immersion.running || narration?.playing) {
      lightWord = 'Pause';
      lightIcon = PAUSE;
    } else {
      lightWord = immersion.begun ? 'Continue' : 'Begin';
      lightIcon = PLAY;
    }
  }
  return (
    <span className="pl-split">
      {narration && (
        <button type="button" className={`pl-pill${listening ? ' is-on' : ''}`} onClick={onListen} data-tip="The voice reads the page as it is">
          <DotIcon rows={listenIcon} />
          {listenWord}
        </button>
      )}
      {canImmerse && (
        <span className={`pl-pill-wrap${immersion ? ' is-on' : ''}`}>
          <button type="button" className={`pl-pill is-light${immersion ? ' is-on' : ''}`} onClick={onLight} data-tip="The page dims, and the words light up as you read">
            <DotIcon rows={lightIcon} />
            {lightWord}
          </button>
          {immersion && (
            <button type="button" className="pl-pill-x" onClick={onLeave} aria-label="Leave Immersive" data-tip="Back to the page as it is">
              <DotIcon rows={CROSS} />
            </button>
          )}
        </span>
      )}
    </span>
  );
}

/** C, in Immersive: where you are, and the way out. */
function LeaveTag({ onLeave }: { onLeave: () => void }) {
  return (
    <span className="pl-tag">
      <DotIcon rows={LIGHT} />
      <span>Immersive</span>
      <button type="button" className="pl-tag-x" onClick={onLeave} aria-label="Leave Immersive" data-tip="Back to the page as it is">
        <DotIcon rows={CROSS} />
      </button>
    </span>
  );
}

/** C: once, a while after the book opens, a note that Immersive is there. Gone for good once tried or put away. */
function Nudge({ going, onTry }: { going: boolean; onTry: () => void }) {
  const [done, setDone] = useState(() => readLocal<boolean>(NUDGED, false));
  const [due, setDue] = useState(false);
  useEffect(() => {
    if (done) return;
    const t = window.setTimeout(() => setDue(true), 4000);
    return () => window.clearTimeout(t);
  }, [done]);
  const finish = () => {
    setDone(true);
    writeLocal(NUDGED, true);
  };
  const shown = due && !done && !going;
  return (
    <AnimatePresence>
      {shown && (
        <motion.div
          key="nudge"
          className="pl-nudge"
          role="status"
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 6 }}
          transition={springs.snappy}
        >
          <DotIcon rows={LIGHT} />
          <Typed text="Try Immersive: the page dims and the words light up as you read." />
          <button type="button" className="i3-begin" onClick={() => { finish(); onTry(); }}>Try it</button>
          <button type="button" className="pl-nudge-x" onClick={finish} aria-label="Not now">
            <DotIcon rows={CROSS} />
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/**
 * A and D: Immersive's question as it comes on, just above the switch: the words lit at the pace
 * alone, or a voice reading them, and the book's music on or off. Picking only picks; play starts
 * it. A tap anywhere else, or Escape, puts it away. Music the book doesn't have yet looks off, and
 * a tap on it says why, as in the voice sheet.
 */
function ImmersiveCard({ wrap, voice, canListen, music, onAi, onPick, onClose }: {
  wrap: RefObject<HTMLSpanElement | null>;
  voice: boolean;
  canListen: boolean;
  music: Props['music'];
  onAi: Props['letAi'];
  onPick: (voice: boolean) => void;
  onClose: () => void;
}) {
  const { music: musicOn } = useVoicePrefs();
  const [why, setWhy] = useState(false);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (why) return;
    const onDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) close.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      close.current();
    };
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [why, wrap]);

  const ready = music === 'ready';
  const toggleMusic = () => {
    if (!ready) {
      setWhy(true);
      return;
    }
    setVoicePrefs({ music: !musicOn });
    if (!musicOn) unlockMusic();
  };
  const [page, setPage] = useState<HTMLElement | null>(null);
  const onRoot = useCallback((el: HTMLDivElement | null) => {
    if (el) setPage(el.closest<HTMLElement>('.rd'));
  }, []);
  return (
    <motion.div
      ref={onRoot}
      className="pl-card"
      role="dialog"
      aria-label="Immersive"
      initial={{ opacity: 0, y: 6, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 6, scale: 0.98, transition: { duration: 0.14 } }}
      transition={springs.snappy}
    >
      <div className="pl-card-ways" role="radiogroup" aria-label="Read or listen">
        <button type="button" role="radio" aria-checked={!voice} className={voice ? '' : 'is-on'} onClick={() => onPick(false)}>
          <DotIcon rows={LIGHT} />
          <b>Read</b>
          <span>The words light up at your pace</span>
        </button>
        {canListen && (
          <button type="button" role="radio" aria-checked={voice} className={voice ? 'is-on' : ''} onClick={() => onPick(true)}>
            <DotIcon rows={PLAY} />
            <b>Listen</b>
            <span>A voice reads them as they light up</span>
          </button>
        )}
      </div>
      <div className="pl-card-music">
        <span id="pl-card-music">Music</span>
        <button type="button" className={`tg${ready ? '' : ' is-muted'}`} role="switch" aria-checked={ready && musicOn} aria-labelledby="pl-card-music" onClick={toggleMusic} />
      </div>
      {page && createPortal(
        <AnimatePresence>{why && <NotYet what="music" off={music === 'off'} onAi={onAi} onClose={() => setWhy(false)} />}</AnimatePresence>,
        page,
      )}
    </motion.div>
  );
}

/** A and D: how to read this, as one switch. Only Read, where nothing else can be had. */
function Modes({ now, canListen, canImmerse, onPick }: {
  now: Way;
  canListen: boolean;
  canImmerse: boolean;
  onPick: (v: Way) => void;
}) {
  const options: Array<{ v: Way; label: string; tip: string }> = [{ v: 'read', label: 'Read', tip: 'Just the page' }];
  if (canListen) options.push({ v: 'listen', label: 'Listen', tip: 'The voice reads the page as it is' });
  if (canImmerse) options.push({ v: 'immersive', label: 'Immersive', tip: 'The page dims, and the words light up as you read' });
  if (options.length < 2) return null;
  return (
    <span className="pl-seg pl-modes" role="radiogroup" aria-label="How to read">
      {options.map((o) => (
        <button key={o.v} type="button" role="radio" aria-checked={now === o.v} className={now === o.v ? 'is-on' : ''} onClick={() => onPick(o.v)} data-tip={o.tip}>
          {o.v === 'immersive' && <DotIcon rows={LIGHT} />}
          {o.label}
        </button>
      ))}
    </span>
  );
}

/** E: a slim strip saying what can play, with a tray above for the rest. */
function Peek({ bits, mode, canImmerse, narration, immersion, panel, aloud, voices, onListen, onLight, onMode }: {
  bits: Bits;
  mode: 'normal' | 'immersive';
  canImmerse: boolean;
  narration: Props['narration'];
  immersion: Props['immersion'];
  panel: PanelName | null;
  aloud: ReactNode;
  voices: ReactNode;
  onListen: () => void;
  onLight: () => void;
  onMode: (m: 'normal' | 'immersive') => void;
}) {
  const [open, setOpen] = useState(false);
  // A drop opened from the tray, or anywhere, puts the tray away.
  useEffect(() => {
    if (panel) setOpen(false);
  }, [panel]);
  let strip: ReactNode;
  if (bits.going && bits.main) {
    let word = 'Reading aloud';
    if (immersion?.running) word = 'Lighting the words';
    strip = (
      <>
        <button type="button" className="pl-word" onClick={bits.main.act} aria-label={bits.main.label}>
          <DotIcon rows={PAUSE} />
          {word}
        </button>
        <Skips transport={bits.transport} />
      </>
    );
  } else {
    let lightWord = 'Immersive';
    if (immersion) lightWord = immersion.begun ? 'Continue' : 'Begin';
    strip = (
      <>
        {narration && (
          <button type="button" className="pl-word" onClick={onListen} data-tip="The voice reads the page as it is">
            <DotIcon rows={PLAY} />
            Listen
          </button>
        )}
        {canImmerse && narration && <span className="pl-sep" aria-hidden="true">·</span>}
        {canImmerse && (
          <button type="button" className={`pl-word${immersion ? ' is-on' : ''}`} onClick={onLight} data-tip="The page dims, and the words light up as you read">
            <DotIcon rows={LIGHT} />
            {lightWord}
          </button>
        )}
      </>
    );
  }
  return (
    <>
      <span className="pl-strip">
        {strip}
        <button type="button" className={`pl-icon pl-up${open ? ' is-open' : ''}`} onClick={() => setOpen(!open)} aria-label="More" aria-expanded={open} data-tip="Play, the mode and the voices">
          <DotIcon rows={UP} />
        </button>
      </span>
      <AnimatePresence>
        {open && (
          <motion.div
            key="tray"
            className="pl-tray"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={springs.snappy}
          >
            {canImmerse && <ModeSwitch mode={mode} onPick={onMode} />}
            <Transport {...bits} />
            <span className="pl-r">{aloud}{voices}</span>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
