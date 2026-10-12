import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { AI_LABEL } from '../../../books/ai';
import { api } from '../../../lib/api';
import { springs } from '../../../lib/springs';
import { Segmented } from '../Panels';
import { BUILT_IN, checkGpu, useGpu, type Engine, type Mode, type VoiceInfo } from '../voice/catalog';
import { refreshVoices } from '../voice/list';
import { unlockMusic } from '../music';
import { hung, MUSIC_VOLUME, PACE, pairFor, pickSide, RATES, setVoicePrefs, sideOf, stepMusic, stepPace, useVoicePrefs, voiceFor } from '../voice/prefs';
import { refreshSpeech, serverHas, useSpeech } from '../voice/server';
import { missingAll, playSample, stopSample, useLoadState } from '../voice/speaker';
import { SheetAi } from '../../ai/AiStatus';
import type { AiProgress } from '../../ai/progress';
import { useRound } from '../../design/round';
import { castVoices, setCastOn, useCast } from '../voice/cast';
import { CastSection, OneVoice, TwoVoices, VoiceFaces } from './Cast';
import { PAUSE, PLAY } from './icons';
import { CloseDots, DotIcon } from './parts';

/*
 * The voice sheet, from the button beside play: Normal or Immersive, the voice, and the speed.
 * Immersive lights the words at a pace set here, and play adds a voice that keeps to it. The voices
 * come from two models, thirty each: Piper's, which run on any device, and Kokoro's, richer and
 * heavier, which read in Immersive on a computer. Each one has a greeting to hear before anything
 * downloads, a tap on its face. For the accounts
 * it's open to, the server can read instead (voice/server.ts). A book with background music
 * (music.ts) has it on or off here, and how loud; until its music is made, the switch looks off
 * and a tap says why, as 2 voices does.
 */

const ABOUT: Record<Mode, string> = {
  normal: 'Voices that run on this device’s processor, fine on any phone or laptop. Each one downloads once, about 66 MB, and then reads offline.',
  immersive: 'The page dims. Begin on the bottom line, pick where to start, and the words light up at your pace; any tap stops them. Play reads them aloud instead at the same pace, from where you pick, until Immersive is off: any Piper voice, or on a computer, one of Kokoro’s richer ones below.',
};
const HEAVY = 'Richer, and much heavier: one download of about 330 MB for all thirty, run on the graphics chip. Use them on a computer. On a phone they can hang the browser.';
/** The heavy voices, read on the server. */
const SERVER_HEAVY = 'Richer voices, read on Breader’s own computer, so nothing downloads and any phone can have them. Each sentence takes it a little longer than a Normal voice.';
const FALLBACK = 'The page dims. Begin on the bottom line, pick where to start, and the words light up at your pace; any tap stops them. Play reads them aloud instead at the same pace, with a Piper voice, each about 66 MB. Kokoro’s need a newer computer with a recent Chrome, Edge or Safari.';
/** Why Kokoro can't be picked: Normal reads only with Piper, and this browser can't run Kokoro. */
const NO_KOKORO = {
  normal: 'Kokoro’s voices read in Immersive. Switch Mode to Immersive to pick one.',
  fallback: 'Kokoro’s voices need a newer computer with a recent Chrome, Edge or Safari.',
};
/** A browser that can't run any voice still has Immersive. */
const NO_VOICES: Record<Mode, string> = {
  normal: 'This browser can’t run voices. Immersive still works without one.',
  immersive: 'The page dims. Begin on the bottom line, pick where to start, and the words light up at your pace; any tap stops them. This browser can’t run voices, so it stays quiet.',
};
const HUNG = 'A Kokoro voice stopped this browser last time, so Immersive reads with a Piper voice now. Kokoro’s are best on a computer.';
/** Read on the server: what each mode does then. */
const SERVER: Record<Mode, string> = {
  normal: 'Breader’s own computer reads aloud and sends the sound here, for a phone that’s slow with voices of its own. Nothing downloads, but it needs a connection.',
  immersive: 'The page dims. Begin on the bottom line, pick where to start, and the words light up at your pace; any tap stops them. Play reads them aloud instead at the same pace, from where you pick, until Immersive is off, with a voice from Breader’s own computer: a Piper one, or one of Kokoro’s richer ones below.',
};

/*
 * Two voices, a woman's and a man's, need the book read through first to know who says each line
 * (ai/procedure.md), and its background music to know each scene. Until this book has been, 2 and
 * the music look off and a tap on them says why, warmly, with the book's AI switch right there
 * when it's off.
 */
export type Soon = 'two' | 'music' | 'cast';
/** What the card says of each: its name, what it will be, why the book is read first, and what turns on. */
const SOON: Record<Soon, { title: string; promise: string; asked: string; told: string; name: string }> = {
  two: {
    title: 'Two voices',
    promise: 'Soon a book can be read by two voices, a woman’s and a man’s, so every conversation sounds like people talking.',
    asked: 'To get each line right, an AI reads the whole book first, noting who says what.',
    told: 'To get each line right, the whole book is read first, noting who says what.',
    name: '2 voices',
  },
  music: {
    title: 'Background music',
    promise: 'Soon a book can have music of its own, scored the way an anime is: a track or a silence under every scene while it reads aloud or lights up.',
    asked: 'To choose each scene’s music, an AI reads the whole book first.',
    told: 'To choose each scene’s music, the whole book is read first.',
    name: 'background music',
  },
  cast: {
    title: 'Character voices',
    promise: 'Soon every person in a book can have a voice of their own, picked from thirty, so you know who’s talking before the line says.',
    asked: 'To know who says each line, an AI reads the whole book first and lists who’s in it.',
    told: 'To know who says each line, the whole book is read first and everyone in it listed.',
    name: 'character voices',
  },
};
/** 1 voice, 2 (hers and his), or a voice for each character. */
type Count = 1 | 2 | 'cast';
const counts = (ready: boolean, castReady: boolean): Array<{ v: Count; label: string; muted?: boolean }> => [
  { v: 1, label: '1 voice' },
  { v: 2, label: '2 voices', muted: !ready },
  { v: 'cast', label: 'Characters', muted: !castReady },
];
const SIDES = [
  { v: 'F' as const, label: 'Her' },
  { v: 'M' as const, label: 'His' },
];
const modelsOf = (kokoro: boolean): Array<{ v: Engine; label: string; muted?: boolean }> => [
  { v: 'piper', label: 'Piper' },
  { v: 'kokoro', label: 'Kokoro', muted: !kokoro },
];

const mb = (n: number) => `${n > 0 && n < 500_000 ? '<1' : Math.round(n / 1e6)} MB`;

interface Props {
  playing: boolean;
  /** Absent where the browser can't run a voice. */
  onStart?: () => void;
  onStop?: () => void;
  /** The book's words can light up without a voice (not a PDF's). */
  canPace: boolean;
  /** 2 voices for this book: ready, soon (an AI will read it), or off (its AI switch is off). */
  two: 'ready' | 'soon' | 'off';
  /** Background music for this book: ready, soon (an AI will score it), or off (its AI switch is off). */
  music: 'ready' | 'soon' | 'off';
  /** Turns the book's AI switch on or off. */
  onAi?: (on: boolean) => void;
  /** Someone else turned the switch on first. */
  aiElsewhere: boolean;
  /** How far the AI has got with this book (features/ai/progress.ts). */
  ai: AiProgress;
  bookId: string;
  /** Who's in the book is known, and who says each line: character voices can be had. */
  castReady: boolean;
}

export function VoiceSheet({ playing, onStart, onStop, canPace, two, music, onAi, aiElsewhere, ai, bookId, castReady }: Props) {
  const prefs = useVoicePrefs();
  const round = useRound();
  const cast = useCast();
  const characters = castReady && cast.on;
  const load = useLoadState();
  const mode = prefs.mode;
  const speech = useSpeech();
  const server = speech.allowed && prefs.server;
  // Immersive where the GPU can't run Kokoro offers only Piper (prefs.ts, voiceFor).
  const gpu = useGpu();
  const fallback = mode === 'immersive' && gpu === false && !server;
  const voices: Mode = fallback ? 'normal' : mode;
  const current = voiceFor(mode);
  // 2 voices: her pick and his lit in their colours.
  const paired = two === 'ready' && prefs.count[mode] === 2;
  const pair = pairFor(mode);
  const [bytes, setBytes] = useState<number | null>(null);
  const [hearing, setHearing] = useState<string | null>(null);
  // Kokoro tapped where it can't read: says why.
  const [noKokoro, setNoKokoro] = useState(false);
  // The note about two voices sits in the middle of the reader, outside the drop, which clips.
  const [page, setPage] = useState<HTMLElement | null>(null);
  const onRoot = useCallback((el: HTMLDivElement | null) => { if (el) setPage(el.closest<HTMLElement>('.rd')); }, []);
  // What the card in the middle says isn't ready yet.
  const [waiting, setWaiting] = useState<Soon | null>(null);

  useEffect(() => { void refreshVoices(); void refreshSpeech(); }, []);
  // Whether Immersive can run here, asked before it offers a download.
  useEffect(() => { if (mode === 'immersive') void checkGpu(); }, [mode]);
  useEffect(() => stopSample, []);
  // What the picked voices still have to download, character voices' too; again once a download ends.
  useEffect(() => {
    let on = true;
    let want = [current];
    if (paired) want = [pair.F, pair.M];
    if (paired && characters) want = [...want, ...castVoices(bookId, pair.F.engine, null).values()];
    void missingAll(want).then((n) => { if (on) setBytes(n); });
    return () => { on = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current.key, paired, pair.F.key, pair.M.key, load.key, server, characters, cast]);

  // The model the voices come from: the voice reading's, or hers in 2 voices. The server has its own.
  let model: Engine = current.engine;
  if (paired) model = pair.F.engine;
  const voicesOf = (e: Engine) => {
    let all = BUILT_IN.normal;
    if (e === 'kokoro') all = BUILT_IN.immersive;
    if (server) return all.filter(serverHas);
    return all;
  };
  const grid = voicesOf(model);
  const pick = (v: VoiceInfo) => {
    if (paired) pickSide(voices, v);
    else setVoicePrefs({ voice: { ...prefs.voice, [voices]: v.key } });
  };
  // Another model starts on its first voice, or its first woman's for her side, and his follows.
  const setModel = (e: Engine) => {
    if (e === 'kokoro' && voices !== 'immersive') {
      setNoKokoro(true);
      return;
    }
    setNoKokoro(false);
    if (e === model) return;
    const all = voicesOf(e);
    const first = paired ? all.find((v) => sideOf(v) === 'F') : all[0];
    if (first) pick(first);
  };
  // Another go, as the cast has: one of the model's voices, or a pair of them.
  const anyOf = (list: VoiceInfo[]) => list[Math.floor(Math.random() * list.length)];
  const anotherVoice = () => {
    const others = grid.filter((v) => v.key !== current.key);
    if (others.length) pick(anyOf(others));
  };
  const anotherPair = () => {
    const hers = grid.filter((v) => sideOf(v) === 'F' && v.key !== pair.F.key);
    if (hers.length) pickSide(voices, anyOf(hers));
    const his = grid.filter((v) => sideOf(v) === 'M' && v.key !== pair.M.key);
    if (his.length) pickSide(voices, anyOf(his));
  };
  // Character voices read as 2 voices does, with each line in its speaker's own voice: hers and his for anyone without one.
  const setCount = (n: Count) => {
    if (n === 'cast') {
      if (!castReady) { setWaiting('cast'); return; }
      setCastOn(true);
      if (two === 'ready') setVoicePrefs({ count: { ...prefs.count, [mode]: 2 } });
      return;
    }
    if (n === 2 && two !== 'ready') { setWaiting('two'); return; }
    setCastOn(false);
    setVoicePrefs({ count: { ...prefs.count, [mode]: n } });
  };
  let count: Count = 1;
  if (two === 'ready') count = prefs.count[mode];
  if (characters) count = 'cast';
  const setMode = (m: Mode) => {
    setNoKokoro(false);
    setVoicePrefs({ mode: m });
  };

  const toggleHear = (v: VoiceInfo) => {
    if (hearing === v.key) { stopSample(); setHearing(null); return; }
    void hear(v);
  };

  const hear = async (v: VoiceInfo) => {
    if (!v.sample) return;
    setHearing(v.key);
    try {
      // An uploaded voice has one sample, all three parts in a row.
      const url = 'parts' in v.sample ? v.sample.parts.greeting : (await api.get<{ url: string }>(`/v1/voices/files/${encodeURIComponent(v.sample.fileId)}/link`)).url;
      const audio = playSample(url);
      audio.onended = audio.onerror = () => setHearing((k) => (k === v.key ? null : k));
    } catch {
      setHearing(null);
    }
  };

  const pace = mode === 'immersive' && <Pace />;
  // Until the book's music is made, its switch says why instead.
  let musicLocked: (() => void) | undefined;
  if (music !== 'ready') musicLocked = () => setWaiting('music');
  let soonOff = two === 'off';
  if (waiting === 'music') soonOff = music === 'off';
  if (waiting === 'cast') soonOff = ai.stage === 'off';

  if (!onStart || !onStop) {
    return (
      <div className="pnl vs">
        <div className="pnl-h">Read aloud</div>
        <Segmented label="Mode" value={mode} onChange={setMode} options={[{ v: 'normal', label: 'Normal' }, { v: 'immersive', label: 'Immersive' }]} />
        <p className="p-note vs-about">{NO_VOICES[mode]}</p>
        {canPace && pace}
        {canPace && music === 'ready' && <Music />}
      </div>
    );
  }

  // The model toggle, and what it says when Kokoro is picked or can't be.
  let modelNote: string | null = null;
  if (noKokoro && fallback) modelNote = NO_KOKORO.fallback;
  else if (noKokoro) modelNote = NO_KOKORO.normal;
  else if (model === 'kokoro' && server) modelNote = SERVER_HEAVY;
  else if (model === 'kokoro') modelNote = HEAVY;
  const models = (
    <>
      <Segmented label="Model" value={model} onChange={setModel} options={modelsOf(voices === 'immersive')} />
      {modelNote && <p className="p-note vs-heavy">{modelNote}</p>}
    </>
  );
  // A tap on a face picks that voice and plays it.
  const pickAndHear = (v: VoiceInfo) => {
    pick(v);
    toggleHear(v);
  };
  let lit = (v: VoiceInfo) => v.key === current.key;
  if (paired) lit = (v: VoiceInfo) => v.key === pair.F.key || v.key === pair.M.key;
  const faces = <VoiceFaces voices={grid} lit={lit} onPick={pickAndHear} />;
  const loading = load.key !== null;

  return (
    <div className="pnl vs" ref={onRoot}>
      <div className="pnl-h">Read aloud</div>
      <SheetAi p={ai} book={bookId} elsewhere={aiElsewhere} onAi={onAi} />
      <Segmented label="Mode" value={mode} onChange={setMode} options={[{ v: 'normal', label: 'Normal' }, { v: 'immersive', label: 'Immersive' }]} />
      {speech.allowed && (
        <div className="ctl tgrow">
          <span className="clbl">Read on the server</span>
          <button type="button" className="tg" role="switch" aria-checked={prefs.server} aria-label="Read aloud on Breader’s own computer" onClick={() => setVoicePrefs({ server: !prefs.server })} />
        </div>
      )}
      <p className="p-note vs-about">{server ? SERVER[mode] : fallback ? FALLBACK : ABOUT[mode]}</p>
      {hung && mode === 'immersive' && !server && <p className="p-note vs-about vs-err">{HUNG}</p>}
      {pace}
      <Music onLocked={musicLocked} />
      <Segmented label="Voices" value={count} onChange={setCount} options={counts(two === 'ready', castReady)} />
      {count === 1 && (
        <OneVoice v={current} hearing={hearing === current.key} onHear={() => toggleHear(current)} onAgain={anotherVoice}>
          {models}
          {faces}
        </OneVoice>
      )}
      {count === 2 && (
        <TwoVoices her={pair.F} his={pair.M} hearing={hearing} onHear={toggleHear} onAgain={anotherPair}>
          {models}
          {faces}
        </TwoVoices>
      )}
      {characters && (
        <CastSection book={bookId} design={round.cast} playing={playing} engine={model}>
          {models}
        </CastSection>
      )}
      {paired && <Segmented label="No point of view" value={prefs.noPov} onChange={(g) => setVoicePrefs({ noPov: g })} options={SIDES} />}
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
      {page && createPortal(<AnimatePresence>{waiting && <NotYet what={waiting} off={soonOff} onAi={onAi} onClose={() => setWaiting(null)} />}</AnimatePresence>, page)}
    </div>
  );
}

/**
 * Why 2 voices or the music can't be had yet: a small card in the middle, over the sheet. `off`:
 * the book's AI switch is, and the card has it, to turn on there and then.
 */
export function NotYet({ what, off, onAi, onClose }: { what: Soon; off: boolean; onAi?: (on: boolean) => void; onClose: () => void }) {
  const say = SOON[what];
  // Asked while the switch was off: it stays on the card, on or off, until the card closes.
  const [asked] = useState(off && !!onAi);
  const first = useRef<HTMLButtonElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    first.current?.focus();
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
        <div className="pnl-h">{say.title}</div>
        <p className="vs-soon-t" id="vs-soon-t">Not quite yet</p>
        <p className="p-note">{say.promise}</p>
        {asked ? (
          <>
            <p className="p-note">{say.asked} Let one read along with this book, and it joins the queue.</p>
            <div className="ctl tgrow vs-soon-ai">
              <span className="clbl" id="vs-soon-ai">{AI_LABEL}</span>
              <button type="button" className="tg" role="switch" aria-checked={!off} aria-labelledby="vs-soon-ai" ref={first} disabled={!off} onClick={() => onAi!(true)} />
            </div>
            <p className="p-note" aria-live="polite">{off ? 'It never keeps your book or learns from it. Once on, it stays on, for everyone who has this book.' : `It’s in the queue. Once it’s ready, ${say.name} turns on here by itself. Thank you for bearing with us.`}</p>
          </>
        ) : (
          <>
            <p className="p-note">{say.told} That takes a while, and this book isn’t ready yet. Sorry for the wait, and thank you for bearing with us.</p>
            {off && <p className="p-note">This book hasn’t let an AI read along yet. Turn that on from its ⋯ in your library, and it joins the queue.</p>}
            <p className="p-note">Once it’s ready, {say.name} turns on here by itself.</p>
          </>
        )}
        <button type="button" className="vs-go" ref={asked ? undefined : first} onClick={onClose}>{asked && off ? 'Not now' : 'I’ll wait'}</button>
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

/**
 * Background music: on or off, and how loud, apart from the voice. A book whose music isn't made
 * yet has the switch looking off, and a tap on it says why (onLocked), as 2 voices does.
 */
function Music({ onLocked }: { onLocked?: () => void }) {
  const { music, musicVolume } = useVoicePrefs();
  const toggle = () => {
    setVoicePrefs({ music: !music });
    // Turned on while it reads, the music starts from this tap.
    if (!music) unlockMusic();
  };
  if (onLocked) {
    return (
      <div className="ctl tgrow">
        <span className="clbl">Background music</span>
        <button type="button" className="tg is-muted" role="switch" aria-checked={false} aria-label="Background music while it reads aloud or lights up" onClick={onLocked} />
      </div>
    );
  }
  return (
    <>
      <div className="ctl tgrow">
        <span className="clbl">Background music</span>
        <button type="button" className="tg" role="switch" aria-checked={music} aria-label="Background music while it reads aloud or lights up" onClick={toggle} />
      </div>
      <div className="ctl">
        <div className="clbl">Music volume</div>
        <div className="stp">
          <button type="button" aria-label="Quieter" disabled={musicVolume <= MUSIC_VOLUME.min} onClick={() => stepMusic(-1)}>−</button>
          <span className="stp-v" aria-live="polite">{Math.round(musicVolume * 100)}%</span>
          <button type="button" aria-label="Louder" disabled={musicVolume >= MUSIC_VOLUME.max} onClick={() => stepMusic(1)}>+</button>
        </div>
      </div>
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
