import { useEffect, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence } from 'motion/react';
import type { BookRecord } from '../../books/types';
import { saveFile } from '../../books/exportManga';
import { Modal } from '../../components/Modal';
import { Choice, Step } from '../../components/Steps';
import { Toast, type ToastMessage } from '../../components/Toast';
import { IconDownload, IconSpeaker } from '../../components/icons';
import { DotIcon } from '../reader/chrome/parts';
import { BACK, ON, PAUSE, PLAY } from '../reader/chrome/icons';
import { audiobookVoice, handheld, voiceByKey } from '../reader/voice/prefs';
import { measure, setMode, useSpeed, type Mode } from './speed';
import {
  chaptersMade, exportMp3, kokoroHere, lengthOf, listenable, megabytes, minutes, onListenable, pause, remove, sizeOf, start,
  timeToMake, useAudiobook, useStage, wake, type Engine, type Made,
} from './audiobooks';
import { canAudiobook } from './plan';
import { useAudiobookKeys } from './keys';
import * as player from './player';
import './audiobook.css';

/*
 * A book's audiobook: the button on its card, beside the edit button, and the dialog it opens.
 * Not made yet, the dialog asks which voice and how fast to make it on this device; while it's
 * made, how far it's got, and once its first chapter is made, it plays what's made while the rest is.
 */

const ENGINES: Engine[] = ['piper', 'kokoro'];
const NAME: Record<Engine, string> = { piper: 'Piper', kokoro: 'Kokoro' };
const QUALITY: Record<Engine, string> = { piper: 'Clear, quick to make', kokoro: 'Most natural, slow to make' };

type Book = BookRecord;

/* Which book's dialog is open */

let opened: { book: Book; listen?: Engine } | null = null;
/** The book the player has open, for the top bar's button to open its dialog again. */
let heard: Book | null = null;
const subs = new Set<() => void>();
function openAudiobook(book: Book, listen?: Engine) {
  opened = { book, listen };
  subs.forEach((f) => f());
}
/** Closed while it plays, it plays on, worked from the top bar (AudiobookNav); paused, it stops. */
const closeAudiobook = () => {
  opened = null;
  const p = player.now();
  if (!p.id || !(p.playing || p.waiting)) { player.close(); heard = null; }
  subs.forEach((f) => f());
};
const useOpened = () => useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, () => opened);

/**
 * Where the dialog shows, over everything, and the note that a book being made can be listened to
 * now (its first chapter is made) or is all made, wherever the reader is: mount once, in the app.
 */
export function AudiobookHost() {
  const o = useOpened();
  const [toast, setToast] = useState<ToastMessage | null>(null);
  useEffect(() => wake(), []);
  useEffect(() => onListenable((id, engine, m, whole) => {
    const book = m.book as Book | undefined;
    if (!book || opened?.book.id === id) return;
    const title = book.title || 'Your audiobook';
    setToast({
      id: Date.now(),
      text: whole ? `${title}: the audiobook is made.` : `${title}: chapter 1 is ready. The rest keeps coming.`,
      action: { label: 'Listen', run: () => openAudiobook(book, engine) },
      stay: true,
    });
  }), []);
  return createPortal(
    <>
      <AnimatePresence>{o && <AudiobookDialog key={o.book.id} book={o.book} listen={o.listen} onClose={closeAudiobook} />}</AnimatePresence>
      <Toast toast={toast} onDone={(id) => setToast((t) => (t?.id === id ? null : t))} className="ab-toast" />
    </>,
    document.body,
  );
}

/**
 * The top bar's play and pause, left of Select, while an audiobook plays with its dialog closed:
 * and beside it, the way back to the dialog. Live reading's keys work it too.
 */
export function AudiobookNav() {
  const p = player.usePlayer();
  const o = useOpened();
  const book = heard;
  const on = !o && !!p.id && !!p.engine && !!book && book.id === p.id;
  useAudiobookKeys(on);
  if (!on) return null;
  const playing = p.playing;
  return (
    <div className="hdr-ab" role="group" aria-label={`Audiobook: ${book.title}`}>
      <button
        type="button"
        className="btn btn-ghost hdr-icon"
        disabled={p.waiting}
        aria-label={playing ? 'Pause the audiobook' : p.waiting ? 'Waiting for the next paragraph' : 'Play the audiobook'}
        title={playing ? 'Pause (Space)' : p.waiting ? 'Waiting…' : 'Play (Space)'}
        onClick={() => void player.toggle()}
      >
        <DotIcon rows={playing ? PAUSE : PLAY} />
      </button>
      <button
        type="button"
        className="btn btn-ghost hdr-icon"
        aria-label={`Open the audiobook of ${book.title}`}
        aria-haspopup="dialog"
        title={book.title}
        onClick={() => openAudiobook(book, p.engine!)}
      >
        <IconSpeaker />
      </button>
    </div>
  );
}

/** Removes it in one click; it's red as a warning from the start. */
function RemoveButton({ id, engine }: { id: string; engine: Engine }) {
  const [going, setGoing] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-danger"
      disabled={going}
      onClick={() => {
        setGoing(true);
        const p = player.now();
        if (p.id === id && p.engine === engine) { player.close(); heard = null; }
        void remove(id, engine).finally(() => setGoing(false));
      }}
    >
      {going ? 'Removing…' : 'Remove'}
    </button>
  );
}

/* The card's button */

export function AudiobookButton({ book }: { book: Book }) {
  const ab = useAudiobook(book.id);
  if (!canAudiobook(book)) return null;
  const all = ENGINES.map((e) => ab?.[e]).filter((m): m is Made => !!m);
  const hear = all.some(listenable);
  const busy = all.find((m) => m.state !== 'ready');
  const making = all.some((m) => m.state === 'making');
  const p = busy ? busy.done / busy.total : 0;
  const pct = `${Math.round(p * 100)}%`;
  const label = hear ? `Listen to ${book.title}` : busy ? `Audiobook of ${book.title}: ${pct} made` : `Download ${book.title} as an audiobook`;
  return (
    <button
      type="button"
      className={`tile-ab${hear || busy ? ' is-on' : ''}${making ? ' is-making' : ''}`}
      aria-label={label}
      aria-haspopup="dialog"
      title={hear ? (busy ? `Audiobook · ${pct} made` : 'Audiobook') : busy ? `Audiobook · ${pct}` : 'Download as audiobook'}
      onClick={() => openAudiobook(book)}
    >
      {hear ? <IconSpeaker /> : <IconDownload />}
      {busy && <Ring p={p} />}
    </button>
  );
}

function Ring({ p }: { p: number }) {
  return (
    <svg className="tile-ab-ring" viewBox="0 0 32 32" aria-hidden="true">
      <circle cx="16" cy="16" r="15" pathLength={100} strokeDasharray={`${Math.max(2, p * 100)} 100`} />
    </svg>
  );
}

/* The dialog */

type View = { kind: 'make'; engine?: Engine } | { kind: 'progress'; engine: Engine } | { kind: 'player'; engine: Engine };

function AudiobookDialog({ book, listen: listenIn, onClose }: { book: Book; listen?: Engine; onClose: () => void }) {
  const ab = useAudiobook(book.id);
  // Picked once, as it opens: it never moves on by itself while it's open.
  const [asked, setView] = useState<View | null>(() => (listenIn ? { kind: 'player', engine: listenIn } : null));

  // Those that can be listened to, made ones first; and those still on their first chapter.
  const hear = ENGINES.filter((e) => listenable(ab?.[e])).sort((a, b) => Number(ab![b]!.state === 'ready') - Number(ab![a]!.state === 'ready'));
  const busy = ENGINES.filter((e) => ab?.[e] && !listenable(ab[e]));
  const listen = (): View => (hear.length ? { kind: 'player', engine: hear[0] } : busy.length ? { kind: 'progress', engine: busy[0] } : { kind: 'make' });
  const [first] = useState(listen);
  let view: View = asked ?? first;
  // Removed: what's left.
  if (view.kind !== 'make' && !ab?.[view.engine]) view = listen();
  if (view.kind === 'player' && !listenable(ab?.[view.engine])) view = { kind: 'progress', engine: view.engine };
  const back = hear.length ? () => setView({ kind: 'player', engine: hear[0] }) : undefined;
  const carryOn = (engine: Engine) => () => setView({ kind: 'make', engine });

  return (
    <Modal title="Audiobook" onClose={onClose} width={520} className="ab is-centered">
      <p className="ab-book">{book.title}{book.author ? <span> · {book.author}</span> : null}</p>
      {view.kind === 'make' && (
        <MakeView book={book} fixed={view.engine} ab={ab} onStarted={(engine) => setView({ kind: 'progress', engine })} onBack={back} />
      )}
      {view.kind === 'progress' && (
        <div className="ab-progress">
          <p className="ab-now"><b>{NAME[view.engine]}</b> · {voiceByKey(ab![view.engine]!.voice)?.name ?? 'its voice'}</p>
          <Making
            book={book}
            engine={view.engine}
            m={ab![view.engine]!}
            first
            onCarryOn={carryOn(view.engine)}
            lead={listenable(ab![view.engine]) && <button type="button" className="btn btn-primary is-wide" onClick={() => setView({ kind: 'player', engine: (view as { engine: Engine }).engine })}>{ab![view.engine]!.state === 'ready' ? 'Listen' : 'Play what’s made'}</button>}
          >
            {!listenable(ab![view.engine]) && back && <button type="button" className="btn btn-ghost" onClick={back}>Back</button>}
          </Making>
        </div>
      )}
      {view.kind === 'player' && (
        <PlayerView
          book={book}
          engine={view.engine}
          ab={ab!}
          hear={hear}
          onEngine={(engine) => setView({ kind: 'player', engine })}
          onOther={(engine) => setView(ab?.[engine] ? { kind: 'progress', engine } : { kind: 'make', engine })}
          onCarryOn={carryOn(view.engine)}
        />
      )}
    </Modal>
  );
}

function MakeView({ book, fixed, ab, onStarted, onBack }: {
  book: Book;
  /** Carrying on with this one, or making the other one. */
  fixed?: Engine;
  ab: Partial<Record<Engine, Made>> | undefined;
  onStarted: (e: Engine) => void;
  onBack?: () => void;
}) {
  const free = ENGINES.filter((e) => !ab?.[e]);
  const [engine, setEngine] = useState<Engine>(fixed ?? free[0] ?? 'piper');
  const [kokoro, setKokoro] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const stage = useStage(book.id, engine);
  const { mode } = useSpeed();
  useEffect(() => { void kokoroHere().then(setKokoro); void measure(); }, []);
  // Kokoro can't run here: Piper is picked instead, unless it's made already or being carried on.
  useEffect(() => {
    if (kokoro === false && engine === 'kokoro' && !fixed && !ab?.piper) setEngine('piper');
  }, [kokoro, engine, fixed, ab]);

  const m = ab?.[engine];
  const words = m?.words ?? book.words ?? 0;
  const left = m ? 1 - m.done / m.total : 1;
  const voice = m ? voiceByKey(m.voice) : audiobookVoice(engine);
  const cant = (e: Engine) => e === 'kokoro' && kokoro === false;
  const est = (md: Mode) => `~${minutes(timeToMake(words * left, engine, md))}`;
  const phone = handheld();

  const go = async () => {
    if (cant(engine)) return;
    setStarting(true);
    setError(null);
    try {
      await start(book, engine);
      onStarted(engine);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="ab-make">
      {m ? (
        <p className="ab-now"><b>{NAME[engine]}</b> · {voice?.name} · carries on from {Math.round((1 - left) * 100)}%</p>
      ) : (
        <Step n={1} title="Voice">
          {ENGINES.map((e) => (
            <Choice
              key={e}
              on={engine === e && !cant(e)}
              off={!!ab?.[e] || cant(e)}
              name={NAME[e]}
              aside={ab?.[e] ? 'Made' : audiobookVoice(e).name}
              line={cant(e) && !ab?.[e] ? 'Needs a computer with a graphics chip' : `${QUALITY[e]} · ${megabytes(sizeOf(words))}`}
              onPick={() => setEngine(e)}
            />
          ))}
        </Step>
      )}
      {cant(engine) ? (
        <p className="ab-error" role="alert">This device can’t run Kokoro. Remove it and make it with Piper.</p>
      ) : (
        <Step n={m ? 1 : 2} title="Speed">
          <Choice on={mode === 'max'} name="Maximum" line={`${est('max')} · uses the whole ${phone ? 'phone' : 'computer'}`} onPick={() => setMode('max')} />
          <Choice on={mode === 'min'} name="Minimal" line={`${est('min')} · leaves room for other apps`} onPick={() => setMode('min')} />
        </Step>
      )}
      {error && <p className="ab-error" role="alert">{error}</p>}
      <div className="ab-actions">
        <button type="button" className="btn btn-primary ab-go is-wide" disabled={cant(engine) || starting} onClick={() => void go()}>
          {starting ? (stage ?? 'Starting…') : m ? 'Carry on' : 'Download as audiobook'}
        </button>
        {onBack && <button type="button" className="btn btn-ghost" onClick={onBack}>Back</button>}
      </div>
      <p className="ab-note">Made on this device while Breader is open, and kept in this browser until you export it; clearing site data removes it.</p>
    </div>
  );
}

/** How far it's got, with pause or carry on: alone before its first chapter is made, under the player after. */
function Making({ book, engine, m, first, onCarryOn, lead, children }: {
  book: Book;
  engine: Engine;
  m: Made;
  first?: boolean;
  onCarryOn: () => void;
  /** The main button, on a line of its own above the others. */
  lead?: ReactNode;
  /** More buttons, before Remove. */
  children?: ReactNode;
}) {
  const stage = useStage(book.id, engine);
  const p = m.done / m.total;
  const chapters = m.chapters.length;
  const made = chaptersMade(m);
  useSpeed();
  const togo = (parts: number) => `~${minutes(timeToMake((m.words * Math.max(0, parts)) / m.total, engine, m.mode))}`;
  const firstEnd = m.chapters[1]?.from ?? m.total;
  let line: string;
  if (m.state === 'making') {
    if (stage) line = stage;
    else if (first && made === 0 && chapters > 1) line = `Chapter 1 in ${togo(firstEnd - m.done)}: listen then, or wait for the whole book`;
    else if (chapters > 1) line = `${made} of ${chapters} chapters made · the rest in ${togo(m.total - m.done)}`;
    else line = `${Math.round(p * 100)}% · ready in ${togo(m.total - m.done)}`;
  } else if (m.state === 'paused') {
    line = m.error ?? (chapters > 1 ? `Paused · ${made} of ${chapters} chapters made` : `Paused at ${Math.round(p * 100)}%`);
  } else if (m.state === 'ready') {
    line = 'All made';
  } else {
    line = m.error ?? 'It stopped.';
  }
  return (
    <div className="ab-making">
      <div className={`ab-meter${m.state === 'making' ? ' is-moving' : ''}`} role="progressbar" aria-label="Made" aria-valuenow={Math.round(p * 100)} aria-valuemin={0} aria-valuemax={100}>
        <span style={{ width: `${Math.max(1, p * 100)}%` }} />
      </div>
      <p className={`ab-line${m.state === 'failed' ? ' is-bad' : ''}`}>{line}</p>
      <div className="ab-actions">
        {lead}
        {m.state === 'making'
          ? <button type="button" className="btn btn-quiet" onClick={() => void pause(book.id, engine)}>Pause</button>
          : m.state !== 'ready' && <button type="button" className="btn btn-primary" onClick={onCarryOn}>Carry on</button>}
        {children}
        <RemoveButton id={book.id} engine={engine} />
      </div>
    </div>
  );
}

function PlayerView({ book, engine, ab, hear, onEngine, onOther, onCarryOn }: {
  book: Book;
  engine: Engine;
  ab: Partial<Record<Engine, Made>>;
  /** The voices it can be listened to in. */
  hear: Engine[];
  onEngine: (e: Engine) => void;
  onOther: (e: Engine) => void;
  onCarryOn: () => void;
}) {
  const m = ab[engine]!;
  const p = player.usePlayer();
  const [saving, setSaving] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { player.open(book.id, engine, { title: book.title, author: book.author }); heard = book; }, [book, engine]);
  useAudiobookKeys(true);

  const mine = p.id === book.id && p.engine === engine;
  const at = mine ? p.at : m.at;
  const playing = mine && p.playing;
  const waiting = mine && p.waiting;
  const ready = m.state === 'ready';
  const chapter = [...m.chapters].reverse().find((c) => c.from <= at);
  const left = lengthOf(m.words) * (1 - at / m.total);
  const other = ENGINES.find((e) => e !== engine)!;
  const o = ab[other];
  const end = Math.max(1, m.total - 1);
  // Making it in the other voice too, or how far that's got.
  const otherButton = o?.state !== 'ready' && (
    <button type="button" className="btn btn-ghost" onClick={() => onOther(other)}>
      {o ? `${NAME[other]} ${Math.round((o.done / o.total) * 100)}%` : `Add ${NAME[other]}`}
    </button>
  );

  const save = async () => {
    setError(null);
    setSaving(0);
    try {
      saveFile(await exportMp3(book, engine, (n, of) => setSaving(n / of)));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(null);
    }
  };

  return (
    <div className="ab-player">
      {hear.length > 1 && (
        <div className="ab-tabs" role="tablist" aria-label="Voice">
          {hear.map((e) => (
            <button key={e} type="button" role="tab" aria-selected={e === engine} className={e === engine ? 'is-on' : ''} onClick={() => { player.close(); onEngine(e); }}>{NAME[e]}</button>
          ))}
        </div>
      )}
      <p className="ab-chapter">{chapter?.title ?? book.title}</p>
      <p className="ab-line">{waiting ? 'Waiting for the next paragraph to be made…' : `Paragraph ${at + 1} of ${m.total} · ~${minutes(left)} left · ${NAME[engine]}`}</p>
      <input
        type="range"
        className="ab-bar"
        min={0}
        max={end}
        value={at}
        aria-label="Paragraph"
        style={{ '--p': `${(at / end) * 100}%`, '--m': `${(Math.max(0, m.done - 1) / end) * 100}%` } as CSSProperties}
        onChange={(e) => void player.seek(Number(e.target.value))}
      />
      <div className="ab-transport">
        <button type="button" className="ab-skip" aria-label="Back a paragraph" disabled={at === 0} onClick={() => void player.step(-1)}><DotIcon rows={BACK} /></button>
        <button type="button" className="ab-play" disabled={waiting} onClick={() => void (playing ? player.pause() : player.play())}>
          <DotIcon rows={playing ? PAUSE : PLAY} />
          <span>{playing ? 'Pause' : waiting ? 'Waiting…' : at === 0 ? 'Start audiobook' : 'Resume'}</span>
        </button>
        <button type="button" className="ab-skip" aria-label="On a paragraph" disabled={at >= m.done - 1} onClick={() => void player.step(1)}><DotIcon rows={ON} /></button>
      </div>
      {!ready && <Making book={book} engine={engine} m={m} onCarryOn={onCarryOn}>{otherButton}</Making>}
      {error && <p className="ab-error" role="alert">{error}</p>}
      {ready && (
        <div className="ab-actions">
          <button type="button" className="btn btn-quiet" disabled={saving !== null} onClick={() => void save()}>
            {saving !== null ? `Export ${Math.round(saving * 100)}%` : 'Export MP3'}
          </button>
          {otherButton}
          <RemoveButton id={book.id} engine={engine} />
        </div>
      )}
      <p className="ab-note">
        {ready ? `${megabytes(m.bytes / 1e6)} · in this browser only. Export the MP3 to keep it for good.` : 'Export the MP3 once it’s all made.'}
      </p>
    </div>
  );
}
