import { useState, type ReactNode } from 'react';
import { keepChapters, letGo, stopKeeping, useKept } from '../../books/kept';
import { remoteOf, wholeSeries } from '../../books/remote';
import type { RemoteChapter } from '../../books/types';
import type { ShelfItem } from '../../data/useLibrary';
import { readMangaPrefs } from '../../lib/mangadex';
import { IconDownload } from '../../components/icons';

/** About how big a MangaDex page is, and its data-saver copy: to say how much a whole series takes. */
const PAGE_MB = 0.35;
const SAVER_MB = 0.12;

type Plan =
  | { state: 'counting' }
  | { state: 'ready'; key: string; chapters: RemoteChapter[] }
  | { state: 'error'; text: string };

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

function sizeOf(mb: number): string {
  if (mb >= 1000) return `${(mb / 1000).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(mb))} MB`;
}

/** What downloading these will take, as far as it can be told before their pages are counted. */
function sizeNote(chapters: RemoteChapter[]): string {
  const counted = chapters.filter((c) => c.pages > 0);
  const pages = counted.reduce((n, c) => n + c.pages, 0);
  const mb = pages * (readMangaPrefs().saver ? SAVER_MB : PAGE_MB);
  const what = plural(chapters.length, 'chapter');
  if (counted.length === chapters.length) return `${what}, ${plural(pages, 'page')}, about ${sizeOf(mb)}`;
  // A source's pages are counted as they're kept.
  if (counted.length === 0) return what;
  return `${what}, at least ${sizeOf(mb)}`;
}

/**
 * A manga's ⋯: the whole series downloaded to read offline, in this browser. Every chapter as Read
 * lays it out, other copies filling in what its own hasn't got (books/remote.ts), kept a page at a
 * time while Breader is open (books/kept.ts). Asked first, saying how much it takes.
 */
export function Download({ book }: { book: ShelfItem }) {
  const key = remoteOf(book.url)?.key;
  const { kept, now, queued, failed } = useKept(key);
  const [plan, setPlan] = useState<Plan | null>(null);
  if (!key) return null;

  const done = Object.values(kept).filter((k) => k.done);
  const mb = done.reduce((n, k) => n + k.bytes, 0) / 1_000_000;
  const going = now !== null || queued > 0;
  const left = plan?.state === 'ready' ? plan.chapters.filter((c) => !kept[c.id]?.done) : [];

  const ask = async () => {
    setPlan({ state: 'counting' });
    try {
      const whole = await wholeSeries(book.url);
      setPlan({ state: 'ready', ...whole });
    } catch (e) {
      setPlan({ state: 'error', text: e instanceof Error ? e.message : 'Its chapters couldn’t be found just now.' });
    }
  };
  const start = () => {
    if (plan?.state !== 'ready') return;
    // Kept for good, so the browser doesn't clear it to make room.
    void navigator.storage?.persist?.().catch(() => false);
    keepChapters(plan.key, left);
    setPlan(null);
  };

  let note: string;
  let actions: ReactNode;
  if (going) {
    const of = done.length + queued + (now ? 1 : 0);
    note = `${done.length} of ${plural(of, 'chapter')} downloaded${now ? `, ${now.label} ${now.done} of ${now.of} pages` : ''}. It carries on while Breader is open.`;
    actions = <button type="button" className="ep-mini" onClick={stopKeeping}>Stop</button>;
  } else if (plan?.state === 'counting') {
    note = 'Counting its chapters…';
    actions = <span className="add-spinner" aria-hidden />;
  } else if (plan?.state === 'error') {
    note = plan.text;
    actions = <button type="button" className="ep-mini" onClick={() => void ask()}>Try again</button>;
  } else if (plan?.state === 'ready') {
    note = left.length
      ? `${sizeNote(left)}, kept in this browser to read with no connection. It downloads while Breader is open.`
      : 'Every chapter is downloaded already.';
    actions = (
      <>
        <button type="button" className="ep-mini is-quiet" onClick={() => setPlan(null)}>{left.length ? 'Cancel' : 'OK'}</button>
        {left.length > 0 && <button type="button" className="ep-mini is-go" onClick={start}>Download</button>}
      </>
    );
  } else if (done.length) {
    note = `${plural(done.length, 'chapter')} downloaded, ${sizeOf(mb)}.${failed ? ` Not all came: ${failed}` : ''}`;
    actions = (
      <>
        <button type="button" className="ep-mini is-quiet" onClick={() => void letGo(key)}>Remove</button>
        <button type="button" className="ep-mini" onClick={() => void ask()}>Get the rest</button>
      </>
    );
  } else {
    note = 'Download every chapter to read with no connection.';
    actions = <button type="button" className="ep-mini" onClick={() => void ask()}><IconDownload />Download</button>;
  }

  return (
    <div className="ep-off" aria-live="polite">
      <div className="ep-share">
        <span className="ep-label">Offline</span>
        <span className="ep-off-b">{actions}</span>
      </div>
      <p className="ep-note">{note}</p>
    </div>
  );
}
