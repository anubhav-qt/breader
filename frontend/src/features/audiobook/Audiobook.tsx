import { lazy, Suspense, useEffect, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence } from 'motion/react';
import type { BookRecord } from '../../books/types';
import { Toast, type ToastMessage } from '../../components/Toast';
import { IconDownload, IconSpeaker } from '../../components/icons';
import { DotIcon } from '../reader/chrome/parts';
import { PAUSE, PLAY } from '../reader/chrome/icons';
import { anyMaking, canAudiobook, ENGINES, listenable, onListenable, useAudiobook, type Engine, type Made } from './made';
import { useAudiobookKeys } from './keys';
import * as player from './player';
import './audiobook.css';

/*
 * A book's audiobook: the button on its card, beside the edit button, and the dialog it opens
 * (AudiobookDialog.tsx). The dialog and the making come in a piece of their own, fetched once the
 * app is idle (App's loadSoon), so the library opens on less.
 */

type Book = BookRecord;

const AudiobookDialog = lazy(() => import('./AudiobookDialog').then((m) => ({ default: m.AudiobookDialog })));

/* Which book's dialog is open */

let opened: { book: Book; listen?: Engine } | null = null;
const subs = new Set<() => void>();
function openAudiobook(book: Book, listen?: Engine) {
  opened = { book, listen };
  subs.forEach((f) => f());
}
/** Closed while it plays, it plays on, worked from the top bar (AudiobookNav); paused, it stops. */
const closeAudiobook = () => {
  opened = null;
  const p = player.now();
  if (!p.id || !(p.playing || p.waiting)) { player.close(); player.setHeard(null); }
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
  // Books being made when the page closed carry on being made: only then does the making load now.
  useEffect(() => { if (anyMaking()) void import('./audiobooks').then((m) => m.wake()); }, []);
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
      <Suspense fallback={null}>
        <AnimatePresence>{o && <AudiobookDialog key={o.book.id} book={o.book} listen={o.listen} onClose={closeAudiobook} />}</AnimatePresence>
      </Suspense>
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
  const book = player.heardBook();
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
