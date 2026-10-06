import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { MangaChapter } from '@breader/shared/manga';
import { Modal } from '../../components/Modal';
import { IconCheck, IconOut } from '../../components/icons';
import { laidOut, madeBy, pickChapters, startOf } from '../../books/remote';
import type { BookRecord, Position } from '../../books/types';
import { STATUS, suwayomi, type ServerCard, type ServerManga } from '../../lib/suwayomi';
import { ServerCover } from './ServerCover';

/*
 * A series on a source of the reader's own Suwayomi server: what it is, and its chapters, each with
 * the group that made it. Read starts it (or carries on), adding it to My manga; a chapter tapped
 * starts there.
 */

interface Props {
  card: ServerCard;
  /** This series in My manga already. */
  had?: BookRecord;
  onRead: (manga: ServerManga, from: Position | undefined, rect: DOMRect | undefined) => void;
  onAdd: (manga: ServerManga) => void;
  onClose: () => void;
}

type Load<T> = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; value: T };
const errorText = (e: unknown) => (e instanceof Error ? e.message : 'Your server couldn’t do that.');
const dateText = (at: number) => (at ? new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');

export function ServerSheet({ card, had, onRead, onAdd, onClose }: Props) {
  const [manga, setManga] = useState<Load<ServerManga>>({ state: 'loading' });
  const [list, setList] = useState<Load<MangaChapter[]>>({ state: 'loading' });
  const [more, setMore] = useState(false);
  const coverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    suwayomi.manga(card.id).then(
      (value) => { if (live) setManga({ state: 'ready', value }); },
      (e) => { if (live) setManga({ state: 'error', message: errorText(e) }); },
    );
    suwayomi.chapters(card.id).then(
      (value) => { if (live) setList({ state: 'ready', value }); },
      (e) => { if (live) setList({ state: 'error', message: errorText(e) }); },
    );
    return () => { live = false; };
  }, [card.id]);

  const picked = useMemo(() => (list.state === 'ready' ? pickChapters(list.value) : []), [list]);
  const { chapters } = useMemo(() => laidOut(picked), [picked]);
  const m = manga.state === 'ready' ? manga.value : null;
  const people = m ? [...new Set([m.author, m.artist].flatMap((p) => p?.split(/\s*,\s*/) ?? []).filter(Boolean))] : [];
  const rect = () => coverRef.current?.getBoundingClientRect();
  const web = suwayomi.webUrl(card.id);
  const canRead = !!m && chapters.length > 0;

  return createPortal(
    <Modal title={card.title} onClose={onClose} width={860} className="mds">
      <div className="mds-top">
        <div className="mds-cover" ref={coverRef}>
          {card.thumbnailUrl ? <ServerCover path={card.thumbnailUrl} /> : <span className="mdx-nocover">{card.title}</span>}
        </div>
        <div className="mds-info">
          {people.length > 0 && <p className="mds-by">{people.join(', ')}</p>}
          <p className="mds-meta">{[m && STATUS[m.status], m?.source?.displayName].filter(Boolean).join(' · ')}</p>
          {(m?.genre.length ?? 0) > 0 && (
            <div className="mds-tags">
              {m?.source?.isNsfw && <span className="chip is-rating">18+</span>}
              {m?.genre.slice(0, 14).map((g) => <span key={g} className="chip">{g}</span>)}
            </div>
          )}
        </div>
        <div className="mds-actions">
          <button type="button" className="btn btn-primary" disabled={!canRead} onClick={() => m && onRead(m, undefined, rect())}>{had ? 'Carry on' : 'Read'}</button>
          {had ? (
            <span className="mds-in"><IconCheck /> In My manga</span>
          ) : (
            <button type="button" className="btn btn-quiet" disabled={!m} onClick={() => m && onAdd(m)}>Add to My manga</button>
          )}
        </div>
      </div>

      {manga.state === 'error' && <p className="mds-error">{manga.message}</p>}
      {m?.description && (
        <div className={`mds-desc${more ? ' is-open' : ''}`}>
          <p>{m.description}</p>
          {m.description.length > 320 && <button type="button" className="mds-more" onClick={() => setMore(!more)}>{more ? 'Less' : 'More'}</button>}
        </div>
      )}
      {m && (m.realUrl || web) && (
        <div className="mds-links">
          {m.realUrl && <a className="btn btn-quiet" href={m.realUrl} target="_blank" rel="noopener noreferrer"><IconOut /> {m.source?.displayName ?? 'Its source'}</a>}
          {web && <a className="btn btn-ghost" href={web} target="_blank" rel="noopener noreferrer"><IconOut /> Your server</a>}
        </div>
      )}

      <div className="mds-ch-head">
        <span>{list.state === 'ready' ? (chapters.length === 1 ? '1 chapter' : `${chapters.length} chapters`) : 'Chapters'}</span>
      </div>
      {list.state === 'loading' && <p className="mds-wait"><span className="add-spinner" /> Your server is finding its chapters…</p>}
      {list.state === 'error' && <p className="mds-error">{list.message}</p>}
      {list.state === 'ready' && chapters.length === 0 && <p className="mds-wait">No chapters yet.</p>}
      {chapters.length > 0 && (
        <ol className="mds-chapters">
          {chapters.map((c, i) => (
            <li key={c.id}>
              <button type="button" className="mds-ch" disabled={!m} onClick={() => m && onRead(m, startOf({ ...c, first: 0 }), rect())}>
                <span className="mds-ch-n">{c.label}</span>
                <span className="mds-ch-t">{c.number !== null && c.title ? c.title : ''}</span>
                <span className="mds-ch-g">{c.groups.length ? madeBy(c) : ''}</span>
                <span className="mds-ch-d">{dateText(picked[i].at)}</span>
              </button>
            </li>
          ))}
        </ol>
      )}
      <p className="mds-credit">From {m?.source?.displayName ?? 'its source'}, through your own Suwayomi server. Breader asks it for each chapter’s pages as they’re read.</p>
    </Modal>,
    document.body,
  );
}
