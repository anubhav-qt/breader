import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { hasKey } from '../../../data/sync';
import { api } from '../../../lib/api';
import { springs } from '../../../lib/springs';
import { Segmented } from '../Panels';
import { BUILT_IN, checkGpu, fromListed, useGpu, type Engine, type Mode, type SamplePart, type VoiceInfo } from '../voice/catalog';
import { putVoice, refreshVoices, removeVoice, useListedVoices } from '../voice/list';
import { hung, PACE, RATES, setVoicePrefs, stepPace, useVoicePrefs, voiceFor } from '../voice/prefs';
import { missing, playSample, stopSample, useLoadState } from '../voice/speaker';
import { AddVoice } from './AddVoice';
import { CROSS, PAUSE, PLAY, PLUS, STOP } from './icons';
import { CloseDots, DotIcon } from './parts';

/*
 * The voice sheet, from the button beside play: Normal or Immersive, the voice, and the speed.
 * Immersive lights the words at a pace set here, and play adds a voice that keeps to it, the Normal
 * ones first, then the heavy ones, which are for computers. Each voice has lines to hear before
 * anything downloads: a greeting, a bit of a story and a question, one at a time.
 */

const ABOUT: Record<Mode, string> = {
  normal: 'Voices that run on this device’s processor, fine on any phone or laptop. Each one downloads once, about 66 MB, and then reads offline.',
  immersive: 'The page dims. Begin on the bottom line, pick where to start, and the words light up at your pace; any tap stops them. Play reads them aloud instead at the same pace, from where you pick, until Immersive is off: any Normal voice, or on a computer, one of the richer heavy ones below.',
};
const HEAVY = 'Richer, and much heavier: one download of about 330 MB for all five, run on the graphics chip. Use them on a computer. On a phone they can hang the browser.';
const FALLBACK = 'The page dims. Begin on the bottom line, pick where to start, and the words light up at your pace; any tap stops them. Play reads them aloud instead at the same pace, with a Normal voice, each about 66 MB. The heavy ones need a newer computer with a recent Chrome, Edge or Safari.';
/** A browser that can't run any voice still has Immersive. */
const NO_VOICES: Record<Mode, string> = {
  normal: 'This browser can’t run voices. Immersive still works without one.',
  immersive: 'The page dims. Begin on the bottom line, pick where to start, and the words light up at your pace; any tap stops them. This browser can’t run voices, so it stays quiet.',
};
const HUNG = 'A heavy voice stopped this browser last time, so Immersive reads with a Normal voice now. The heavy ones are best on a computer.';

/*
 * Two voices, a woman's and a man's, need the book read through first to know who says each line
 * (ai/procedure.md). No book has that yet, so 2 looks off and a tap on it says why, warmly.
 */
const COUNTS = [
  { v: 1, label: '1 voice' },
  { v: 2, label: '2 voices', muted: true },
];

const PARTS: Array<{ v: SamplePart; label: string }> = [
  { v: 'greeting', label: 'Greeting' },
  { v: 'narration', label: 'Story' },
  { v: 'question', label: 'Question' },
];
/** The part last listened to, for the next time the sheet opens. */
let lastPart: SamplePart = 'greeting';

const mb = (n: number) => `${n > 0 && n < 500_000 ? '<1' : Math.round(n / 1e6)} MB`;

interface Props {
  playing: boolean;
  /** Absent where the browser can't run a voice. */
  onStart?: () => void;
  onStop?: () => void;
  /** The book's words can light up without a voice (not a PDF's). */
  canPace: boolean;
}

export function VoiceSheet({ playing, onStart, onStop, canPace }: Props) {
  const prefs = useVoicePrefs();
  const listed = useListedVoices();
  const load = useLoadState();
  const mode = prefs.mode;
  // Immersive where the GPU can't run the heavy voices offers only the Normal ones (prefs.ts, voiceFor).
  const gpu = useGpu();
  const fallback = mode === 'immersive' && gpu === false;
  const voices: Mode = fallback ? 'normal' : mode;
  const engines: Engine[] = voices === 'immersive' ? ['piper', 'kokoro'] : ['piper'];
  const current = voiceFor(mode);
  const [bytes, setBytes] = useState<number | null>(null);
  const [hearing, setHearing] = useState<string | null>(null);
  const [part, setPart] = useState(lastPart);
  const heard = useRef<VoiceInfo | null>(null);
  const [adding, setAdding] = useState(false);
  // The note about two voices sits in the middle of the reader, outside the drop, which clips.
  const [page, setPage] = useState<HTMLElement | null>(null);
  const onRoot = useCallback((el: HTMLDivElement | null) => { if (el) setPage(el.closest<HTMLElement>('.rd')); }, []);
  const [waiting, setWaiting] = useState(false);

  useEffect(() => { void refreshVoices(); }, []);
  // Whether Immersive can run here, asked before it offers a download.
  useEffect(() => { if (mode === 'immersive') void checkGpu(); }, [mode]);
  useEffect(() => stopSample, []);
  // What the picked voice still has to download; again once a download ends.
  useEffect(() => {
    let on = true;
    void missing(current).then((m) => { if (on) setBytes(m.bytes); });
    return () => { on = false; };
  }, [current, load.key]);

  const pick = (key: string) => setVoicePrefs({ voice: { ...prefs.voice, [voices]: key } });
  const setMode = (m: Mode) => setVoicePrefs({ mode: m });

  const toggleHear = (v: VoiceInfo) => {
    if (hearing === v.key) { stopSample(); setHearing(null); return; }
    void hear(v);
  };
  // Another part while one is playing plays that voice saying it.
  const pickPart = (p: SamplePart) => {
    setPart(p);
    lastPart = p;
    if (hearing && heard.current?.key === hearing) void hear(heard.current, p);
  };

  const hear = async (v: VoiceInfo, p = part) => {
    if (!v.sample) return;
    heard.current = v;
    setHearing(v.key);
    try {
      // An uploaded voice has one sample, all three parts in a row.
      const url = 'parts' in v.sample ? v.sample.parts[p] : (await api.get<{ url: string }>(`/v1/voices/files/${encodeURIComponent(v.sample.fileId)}/link`)).url;
      const audio = playSample(url);
      audio.onended = audio.onerror = () => setHearing((k) => (k === v.key ? null : k));
    } catch {
      setHearing(null);
    }
  };

  const pace = mode === 'immersive' && <Pace />;

  if (!onStart || !onStop) {
    return (
      <div className="pnl vs">
        <div className="pnl-h">Read aloud</div>
        <Segmented label="Mode" value={mode} onChange={setMode} options={[{ v: 'normal', label: 'Normal' }, { v: 'immersive', label: 'Immersive' }]} />
        <p className="p-note vs-about">{NO_VOICES[mode]}</p>
        {canPace && pace}
      </div>
    );
  }

  if (adding) {
    return (
      <AddVoice
        mode={voices}
        onBusy={() => { if (playing) onStop(); }}
        onDone={(added) => {
          setAdding(false);
          if (!added) return;
          // Immersive reads with either kind; Normal only with its own.
          const into = voices === 'immersive' ? 'immersive' : added.mode;
          setVoicePrefs({ voice: { ...prefs.voice, [into]: added.key } });
          if (into !== voices) setMode(into);
        }}
      />
    );
  }

  // Normal's first, then the heavy ones.
  const uploads = (mine: boolean) => engines.flatMap((e) => listed.filter((v) => v.engine === e && v.mine === mine)).map(fromListed);
  const others = uploads(false);
  const yours = uploads(true);
  const row = (v: VoiceInfo, extra?: React.ReactNode) => (
    <Row
      key={v.key}
      v={v}
      heavy={engines.length > 1 && v.engine === 'kokoro' && !!v.upload}
      on={current.key === v.key}
      hearing={hearing === v.key}
      onPick={() => pick(v.key)}
      onHear={() => toggleHear(v)}
      extra={extra}
    />
  );
  const loading = load.key !== null;

  return (
    <div className="pnl vs" ref={onRoot}>
      <div className="pnl-h">Read aloud</div>
      <Segmented label="Mode" value={mode} onChange={setMode} options={[{ v: 'normal', label: 'Normal' }, { v: 'immersive', label: 'Immersive' }]} />
      <p className="p-note vs-about">{fallback ? FALLBACK : ABOUT[mode]}</p>
      {hung && mode === 'immersive' && <p className="p-note vs-about vs-err">{HUNG}</p>}
      {pace}
      <Segmented label="Voices" value={1} onChange={(n) => { if (n === 2) setWaiting(true); }} options={COUNTS} />
      <Segmented label="Hear them say" value={part} onChange={pickPart} options={PARTS} />
      <div className="vs-lists" role="radiogroup" aria-label="Voice">
        <div className="vs-list">{BUILT_IN.normal.map((v) => row(v))}</div>
        {engines.includes('kokoro') && (
          <>
            <div className="clbl vs-sub">Heavy voices</div>
            <p className="p-note vs-heavy">{HEAVY}</p>
            <div className="vs-list">{BUILT_IN.immersive.map((v) => row(v))}</div>
          </>
        )}
        {others.length > 0 && (
          <>
            <div className="clbl vs-sub">Shared by readers</div>
            <div className="vs-list">{others.map((v) => row(v))}</div>
          </>
        )}
        <div className="clbl vs-sub">Yours</div>
        <div className="vs-list">
          {yours.map((v) => row(v, <Own v={v} />))}
          {hasKey() ? (
            <button type="button" className="vs-add" onClick={() => { stopSample(); setAdding(true); }}>
              <DotIcon rows={PLUS} />
              <span>Add a voice</span>
            </button>
          ) : (
            <p className="p-note vs-sub-note">Once this library has a key, you can add voices of your own.</p>
          )}
        </div>
      </div>
      {mode === 'normal' && <Segmented label="Speed" value={prefs.rate} onChange={(r) => setVoicePrefs({ rate: r })} options={RATES.map((r) => ({ v: r, label: `${r}×` }))} />}
      <div className="vs-foot">
        {loading ? (
          <Progress loaded={load.loaded} total={load.total} />
        ) : load.error && !(fallback && load.gpu) ? (
          <p className="p-note vs-err" role="alert">{load.error}</p>
        ) : null}
        <button type="button" className="vs-go" onClick={playing ? onStop : onStart}>
          <DotIcon rows={playing ? PAUSE : PLAY} />
          <span>{playing ? (loading ? 'Cancel' : 'Stop') : bytes ? `Download ${mb(bytes)} and read` : 'Read aloud'}</span>
        </button>
      </div>
      {page && createPortal(<AnimatePresence>{waiting && <TwoVoicesSoon onClose={() => setWaiting(false)} />}</AnimatePresence>, page)}
    </div>
  );
}

/** Why 2 voices can't be picked yet: a small card in the middle, over the sheet. */
function TwoVoicesSoon({ onClose }: { onClose: () => void }) {
  const ok = useRef<HTMLButtonElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    ok.current?.focus();
    // Escape closes the card, not the sheet under it (or the book).
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      close.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      before?.focus?.();
    };
  }, []);
  return (
    <>
      <motion.div className="vs-soon-scrim" onClick={onClose} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }} />
      <motion.div
        className="vs-soon"
        data-panel
        role="dialog"
        aria-modal="true"
        aria-labelledby="vs-soon-t"
        initial={{ opacity: 0, scale: 0.96, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.97, y: 4, transition: { duration: 0.15 } }}
        transition={springs.snappy}
      >
        <CloseDots onClick={onClose} />
        <div className="pnl-h">Two voices</div>
        <p className="vs-soon-t" id="vs-soon-t">Not quite yet</p>
        <p className="p-note">Soon a book can be read by two voices, a woman’s and a man’s, so every conversation sounds like people talking.</p>
        <p className="p-note">To get each line right, the whole book is read first, noting who says what. That takes a while, and this book isn’t ready yet. Sorry for the wait, and thank you for bearing with us.</p>
        <p className="p-note">Once it’s ready, 2 voices turns on here by itself.</p>
        <button type="button" className="vs-go" ref={ok} onClick={onClose}>I’ll wait</button>
      </motion.div>
    </>
  );
}

/** Immersive's pace in words a minute: how fast the words light up, and how fast a voice reads them. */
function Pace() {
  const { pace } = useVoicePrefs();
  return (
    <div className="ctl">
      <div className="clbl">Pace</div>
      <div className="stp">
        <button type="button" aria-label="Slower" disabled={pace <= PACE.min} onClick={() => stepPace(-1)}>−</button>
        <span className="stp-v" aria-live="polite">{pace} wpm</span>
        <button type="button" aria-label="Faster" disabled={pace >= PACE.max} onClick={() => stepPace(1)}>+</button>
      </div>
    </div>
  );
}

function Row({ v, heavy, on, hearing, onPick, onHear, extra }: {
  v: VoiceInfo;
  /** A reader's heavy voice, among Normal ones. */
  heavy: boolean;
  on: boolean;
  hearing: boolean;
  onPick: () => void;
  onHear: () => void;
  extra?: React.ReactNode;
}) {
  return (
    <div className={`vs-row${on ? ' is-on' : ''}`}>
      <button type="button" role="radio" aria-checked={on} className="vs-pick" onClick={onPick}>
        <span className="vs-name">{v.name}</span>
        <span className="vs-tag">{heavy ? `${v.accent} · Heavy` : v.accent}</span>
      </button>
      {extra}
      {v.sample && (
        <button type="button" className={`vs-hear${hearing ? ' is-on' : ''}`} onClick={onHear} aria-label={hearing ? `Stop ${v.name}` : `Hear ${v.name}`}>
          <DotIcon rows={hearing ? STOP : PLAY} />
        </button>
      )}
    </div>
  );
}

/** One of this library's voices: whether others can hear it, and removing it (a second tap). */
function Own({ v }: { v: VoiceInfo }) {
  const u = v.upload!;
  const [sure, setSure] = useState(false);
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const remove = () => {
    if (!sure) {
      setSure(true);
      timer.current = window.setTimeout(() => setSure(false), 3000);
      return;
    }
    removeVoice(u.id);
  };
  return (
    <>
      <button
        type="button"
        className="tg vs-public"
        role="switch"
        aria-checked={u.public}
        aria-label={`Share ${v.name} with every reader`}
        title={u.public ? 'Shared with every reader' : 'Only you'}
        onClick={() => putVoice({ ...u, public: !u.public })}
      />
      <button type="button" className={`vs-remove${sure ? ' is-sure' : ''}`} onClick={remove} aria-label={sure ? `Remove ${v.name} for good` : `Remove ${v.name}`}>
        {sure ? 'Remove' : <DotIcon rows={CROSS} />}
      </button>
    </>
  );
}

const DOTS = 24;

/** A download as a row of square dots, like the book's progress below the page. */
export function Progress({ loaded, total }: { loaded: number; total: number }) {
  const f = total ? Math.min(1, loaded / total) : 0;
  return (
    <div className="vs-prog" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(f * 100)} aria-label="Downloading the voice">
      <span className="vs-prog-dots" aria-hidden="true">
        {Array.from({ length: DOTS }, (_, i) => <i key={i} className={(i + 1) / DOTS <= f ? 'is-read' : i / DOTS < f ? 'is-now' : undefined} />)}
      </span>
      <span className="vs-prog-n">{mb(loaded)} of {mb(total)}</span>
    </div>
  );
}
