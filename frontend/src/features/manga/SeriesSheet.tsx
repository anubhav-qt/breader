import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { MangaCard, MangaChapter, MangaSeries } from '@breader/shared/manga';
import { Modal } from '../../components/Modal';
import { IconCheck, IconOut } from '../../components/icons';
import { laidOut, madeBy, pickChapters, remoteOf, startOf } from '../../books/remote';
import type { BookRecord, Position } from '../../books/types';
import { ApiError } from '../../lib/api';
import { byLang, KIND_NAME, langName, mangadex, RATING_NAME, STATUS_NAME, type MangaPrefs } from '../../lib/mangadex';
import { Elsewhere, type MoveTo } from './Elsewhere';

/*
 * A MangaDex series: what it is, where its publisher has it, and its chapters in a language, each
 * with the group that made it. Read starts it (or carries on) in the reader, adding it to My manga;
 * a chapter tapped starts there. A chapter its publisher puts up itself opens on their site. One in
 * My manga can move to another site (Elsewhere.tsx).
 */

interface Props {
  card: MangaCard;
  prefs: MangaPrefs;
  /** This series in My manga already. */
  had?: BookRecord;
  /** Moving it to another site, once it's in My manga. */
  move?: MoveTo;
  onRead: (series: MangaSeries, lang: string, from: Position | undefined, rect: DOMRect | undefined) => void;
  onAdd: (series: MangaSeries, lang: string) => void;
  onClose: () => void;
}

type Load<T> = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; value: T };

const errorText = (e: unknown) =>
  e instanceof ApiError && e.code === 'laptop_off'
    ? 'MangaDex comes through Breader’s own computer, which can’t be reached just now.'
    : e instanceof Error ? e.message : 'Breader couldn’t reach MangaDex.';

const dateText = (at: number) => (at ? new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');

export function SeriesSheet({ card, prefs, had, move, onRead, onAdd, onClose }: Props) {
  const [series, setSeries] = useState<Load<MangaSeries>>({ state: 'loading' });
  const [more, setMore] = useState(false);
  const [looking, setLooking] = useState(move?.first ?? false);
  const s = series.state === 'ready' ? series.value : null;
  // Opened from My manga, the card knows little until the series comes.
  const shown: MangaCard = s ?? card;
  const langs = byLang(shown.langs.length ? shown.langs : ['en'], prefs.lang);
  // The one it's read in, once it's in My manga; or the one a search found all its chapters in; or
  // English unless it's being looked for in another language.
  const [lang, setLang] = useState(() => {
    const w = had && remoteOf(had.url);
    const kept = w && w.kind === 'mangadex' ? w.lang : undefined;
    if (kept) return kept;
    if (card.readIn && langs.includes(card.readIn)) return card.readIn;
    if (prefs.lang && langs.includes(prefs.lang)) return prefs.lang;
    return langs.includes('en') ? 'en' : langs[0];
  });
  const [list, setList] = useState<Load<MangaChapter[]>>({ state: 'loading' });
  const coverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    mangadex.series(card.id, prefs.adult).then(
      (value) => { if (live) setSeries({ state: 'ready', value }); },
      (e) => { if (live) setSeries({ state: 'error', message: errorText(e) }); },
    );
    return () => { live = false; };
  }, [card.id, prefs.adult]);

  useEffect(() => {
    let live = true;
    setList({ state: 'loading' });
    mangadex.chapters(card.id, lang).then(
      (r) => { if (live) setList({ state: 'ready', value: r.chapters }); },
      (e) => { if (live) setList({ state: 'error', message: errorText(e) }); },
    );
    return () => { live = false; };
  }, [card.id, lang]);

  const picked = useMemo(() => (list.state === 'ready' ? pickChapters(list.value) : []), [list]);
  const { chapters, total } = useMemo(() => laidOut(picked), [picked]);
  const people = s ? [...new Set([...s.authors, ...s.artists])] : card.authors;
  const official = s?.links.filter((l) => l.kind === 'official') ?? [];
  const elsewhere = s?.links.filter((l) => l.kind !== 'official') ?? [];
  const alt = s?.altTitles.find((t) => /^[\x20-\x7e’‘“”]+$/.test(t));
  const canRead = !!s && total > 0;
  const rect = () => coverRef.current?.getBoundingClientRect();
  // Read in another language than the one kept, it carries on in that one.
  const keptIn = had && remoteOf(had.url);
  const sameLang = !had || (keptIn?.kind === 'mangadex' && keptIn.lang === lang);

  return createPortal(
    <Modal title={card.title} onClose={onClose} width={860} className="mds">
      <div className="mds-top">
        <div className="mds-cover" ref={coverRef}>
          {shown.cover ? <img src={mangadex.coverUrl(card.id, shown.cover, 512)} alt="" draggable={false} /> : <span className="mdx-nocover">{card.title}</span>}
        </div>
        <div className="mds-info">
          {alt && <p className="mds-alt">{alt}</p>}
          {people.length > 0 && <p className="mds-by">{people.join(', ')}</p>}
          <p className="mds-meta">
            {[shown.year, shown.status ? STATUS_NAME[shown.status] : null, s ? KIND_NAME[s.kind] : null, s?.demographic ? s.demographic[0].toUpperCase() + s.demographic.slice(1) : null, s ? `From ${langName(s.original)}` : null]
              .filter(Boolean)
              .join(' · ')}
          </p>
          {(shown.rating !== 'safe' || (s?.tags.length ?? 0) > 0) && (
            <div className="mds-tags">
              {shown.rating !== 'safe' && <span className="chip is-rating">{RATING_NAME[shown.rating]}</span>}
              {s?.tags.filter((t) => t.group === 'genre' || t.group === 'theme').slice(0, 14).map((t) => <span key={t.name} className="chip">{t.name}</span>)}
            </div>
          )}
        </div>
        <div className="mds-actions">
          <button type="button" className="btn btn-primary" disabled={!canRead} onClick={() => s && onRead(s, lang, undefined, rect())}>
            {had && sameLang ? 'Carry on' : 'Read'}
          </button>
          {had ? (
            <span className="mds-in"><IconCheck /> In My manga</span>
          ) : (
            <button type="button" className="btn btn-quiet" disabled={!s} onClick={() => s && onAdd(s, lang)}>Add to My manga</button>
          )}
          {had && move && (
            <button type="button" className="btn btn-quiet" aria-expanded={looking} onClick={() => setLooking(!looking)}>Elsewhere</button>
          )}
        </div>
      </div>

      {had && move && looking && <Elsewhere title={card.title} from={card.id} {...move} />}

      {series.state === 'error' && <p className="mds-error">{series.message}</p>}
      {s?.description && (
        <div className={`mds-desc${more ? ' is-open' : ''}`}>
          <p>{s.description}</p>
          {s.description.length > 320 && <button type="button" className="mds-more" onClick={() => setMore(!more)}>{more ? 'Less' : 'More'}</button>}
        </div>
      )}

      {s && (
        <div className="mds-links">
          {official.map((l) => (
            <a key={l.url} className="btn btn-quiet" href={l.url} target="_blank" rel="noopener noreferrer"><IconOut /> {l.label}</a>
          ))}
          <a className="btn btn-ghost" href={s.page} target="_blank" rel="noopener noreferrer"><IconOut /> MangaDex</a>
          {elsewhere.map((l) => (
            <a key={l.url} className="mds-link" href={l.url} target="_blank" rel="noopener noreferrer">{l.label}</a>
          ))}
        </div>
      )}

      <div className="mds-ch-head">
        <span>{list.state === 'ready' ? (chapters.length === 1 ? '1 chapter' : `${chapters.length} chapters`) : 'Chapters'}</span>
        <label className="mdx-lang">
          <span className="sr-only">Chapters in</span>
          <select value={lang} onChange={(e) => setLang(e.target.value)}>
            {langs.map((l) => <option key={l} value={l}>{langName(l)}</option>)}
          </select>
        </label>
      </div>
      {list.state === 'loading' && <p className="mds-wait"><span className="add-spinner" /> Finding its chapters…</p>}
      {list.state === 'error' && <p className="mds-error">{list.message}</p>}
      {list.state === 'ready' && chapters.length === 0 && <p className="mds-wait">No chapters in {langName(lang)} yet.</p>}
      {chapters.length > 0 && (
        <ol className="mds-chapters">
          {chapters.map((c, i) => {
            const body = (
              <>
                <span className="mds-ch-n">{c.label}</span>
                <span className="mds-ch-t">{c.number !== null && c.title ? c.title : ''}</span>
                <span className="mds-ch-g">{c.external ? 'On its publisher’s site' : madeBy(c)}</span>
                <span className="mds-ch-d">{c.external ? <IconOut /> : dateText(picked[i].at)}</span>
              </>
            );
            return (
              <li key={c.id}>
                {c.external ? (
                  <a className="mds-ch is-out" href={c.external} target="_blank" rel="noopener noreferrer">{body}</a>
                ) : (
                  <button type="button" className="mds-ch" disabled={!s} onClick={() => s && onRead(s, lang, startOf(c), rect())}>{body}</button>
                )}
              </li>
            );
          })}
        </ol>
      )}
      <p className="mds-credit">Chapters come from MangaDex, made by the scanlation groups named with each. Reading them here, Breader asks MangaDex for each page as it’s read.</p>
    </Modal>,
    document.body,
  );
}
