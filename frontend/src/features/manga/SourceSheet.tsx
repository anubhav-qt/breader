import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { MangaChapter, SourceCard, SourceSeries } from '@breader/shared/manga';
import { Modal } from '../../components/Modal';
import { IconCheck, IconOut } from '../../components/icons';
import { laidOut, madeBy, pickChapters, startOf } from '../../books/remote';
import type { BookRecord, Position } from '../../books/types';
import { sources, STATUS_NAME } from '../../lib/mangadex';

/*
 * A series on one of Breader's Suwayomi sources: what it is, where it's from, and its chapters,
 * each with the group that made it. Read starts it (or carries on) in the reader, adding it to My
 * manga; a chapter tapped starts there.
 */

interface Props {
  card: SourceCard;
  /** 18+ is on, so a series for adults shows. */
  adult: boolean;
  /** This series in My manga already. */
  had?: BookRecord;
  onRead: (series: SourceSeries, from: Position | undefined, rect: DOMRect | undefined) => void;
  onAdd: (series: SourceSeries) => void;
  onClose: () => void;
}

type Load<T> = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; value: T };

function errorText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return 'Breader couldn’t reach it.';
}

const dateText = (at: number) => (at ? new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');

export function SourceSheet({ card, adult, had, onRead, onAdd, onClose }: Props) {
  const [series, setSeries] = useState<Load<SourceSeries>>({ state: 'loading' });
  const [list, setList] = useState<Load<MangaChapter[]>>({ state: 'loading' });
  const [more, setMore] = useState(false);
  const coverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    sources.series(card.id, adult).then(
      (value) => { if (live) setSeries({ state: 'ready', value }); },
      (e) => { if (live) setSeries({ state: 'error', message: errorText(e) }); },
    );
    return () => { live = false; };
  }, [card.id, adult]);

  useEffect(() => {
    let live = true;
    sources.chapters(card.id).then(
      (r) => { if (live) setList({ state: 'ready', value: r.chapters }); },
      (e) => { if (live) setList({ state: 'error', message: errorText(e) }); },
    );
    return () => { live = false; };
  }, [card.id]);

  const picked = useMemo(() => (list.state === 'ready' ? pickChapters(list.value) : []), [list]);
  const { chapters } = useMemo(() => laidOut(picked), [picked]);
  const s = series.state === 'ready' ? series.value : null;
  // Opened from My manga, the card knows little until the series comes.
  const status = s?.status ?? card.status;
  const meta: string[] = [];
  if (status) meta.push(STATUS_NAME[status]);
  if (s) meta.push(s.source);
  const isAdult = s?.adult ?? card.adult;
  const genres = s?.genres.slice(0, 14) ?? [];
  const canRead = !!s && chapters.length > 0;
  const rect = () => coverRef.current?.getBoundingClientRect();

  let count = 'Chapters';
  if (list.state === 'ready' && chapters.length === 1) count = '1 chapter';
  else if (list.state === 'ready') count = `${chapters.length} chapters`;

  let credit = 'From its source, through Breader’s own computer. Breader asks it for each chapter’s pages as they’re read.';
  if (s) credit = `From ${s.source}, through Breader’s own computer. Breader asks it for each chapter’s pages as they’re read.`;

  return createPortal(
    <Modal title={card.title} onClose={onClose} width={860} className="mds">
      <div className="mds-top">
        <div className="mds-cover" ref={coverRef}>
          {card.cover ? <img src={sources.coverUrl(card.cover)} alt="" draggable={false} /> : <span className="mdx-nocover">{card.title}</span>}
        </div>
        <div className="mds-info">
          {s && s.authors.length > 0 && <p className="mds-by">{s.authors.join(', ')}</p>}
          <p className="mds-meta">{meta.join(' · ')}</p>
          {(isAdult || genres.length > 0) && (
            <div className="mds-tags">
              {isAdult && <span className="chip is-rating">18+</span>}
              {genres.map((g) => <span key={g} className="chip">{g}</span>)}
            </div>
          )}
        </div>
        <div className="mds-actions">
          <button type="button" className="btn btn-primary" disabled={!canRead} onClick={() => s && onRead(s, undefined, rect())}>{had ? 'Carry on' : 'Read'}</button>
          {had ? (
            <span className="mds-in"><IconCheck /> In My manga</span>
          ) : (
            <button type="button" className="btn btn-quiet" disabled={!s} onClick={() => s && onAdd(s)}>Add to My manga</button>
          )}
        </div>
      </div>

      {series.state === 'error' && <p className="mds-error">{series.message}</p>}
      {s?.description && (
        <div className={`mds-desc${more ? ' is-open' : ''}`}>
          <p>{s.description}</p>
          {s.description.length > 320 && <button type="button" className="mds-more" onClick={() => setMore(!more)}>{more ? 'Less' : 'More'}</button>}
        </div>
      )}
      {s?.link && (
        <div className="mds-links">
          <a className="btn btn-quiet" href={s.link} target="_blank" rel="noopener noreferrer"><IconOut /> {s.source}</a>
        </div>
      )}

      <div className="mds-ch-head">
        <span>{count}</span>
      </div>
      {list.state === 'loading' && <p className="mds-wait"><span className="add-spinner" /> Finding its chapters…</p>}
      {list.state === 'error' && <p className="mds-error">{list.message}</p>}
      {list.state === 'ready' && chapters.length === 0 && <p className="mds-wait">No chapters yet.</p>}
      {chapters.length > 0 && (
        <ol className="mds-chapters">
          {chapters.map((c, i) => (
            <li key={c.id}>
              <button type="button" className="mds-ch" disabled={!s} onClick={() => s && onRead(s, startOf(c), rect())}>
                <span className="mds-ch-n">{c.label}</span>
                <span className="mds-ch-t">{c.number !== null && c.title ? c.title : ''}</span>
                <span className="mds-ch-g">{c.groups.length ? madeBy(c) : ''}</span>
                <span className="mds-ch-d">{dateText(picked[i].at)}</span>
              </button>
            </li>
          ))}
        </ol>
      )}
      <p className="mds-credit">{credit}</p>
    </Modal>,
    document.body,
  );
}
