import { useEffect, useRef, useState } from 'react';
import type { MangaCard, MangaSort } from '@breader/shared/manga';
import { IconCheck, IconSearch } from '../../components/icons';
import { ApiError } from '../../lib/api';
import { LANGS, langName, mangadex, RATING_NAME, STATUS_NAME, writeMangaPrefs, type MangaPrefs } from '../../lib/mangadex';
import './manga.css';

/*
 * The Manga shelf's MangaDex tab: series to find there, by name or by what's popular, new or just
 * updated, in a language. Series for adults show only once Show 18+ is on. Picking one opens its
 * sheet (SeriesSheet.tsx), to read it or add it to My manga.
 */

interface Props {
  id: string;
  labelledBy: string;
  hidden: boolean;
  /** Series already in My manga, by their MangaDex id. */
  have: ReadonlySet<string>;
  prefs: MangaPrefs;
  onPrefs: (p: MangaPrefs) => void;
  onPick: (card: MangaCard) => void;
}

const SORTS: Array<{ v: MangaSort; label: string }> = [
  { v: 'popular', label: 'Popular' },
  { v: 'latest', label: 'Updated' },
  { v: 'new', label: 'New' },
  { v: 'rated', label: 'Top rated' },
];

type Found = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; items: MangaCard[]; total: number; more: boolean };

const messageOf = (e: unknown) =>
  e instanceof ApiError && e.code === 'laptop_off'
    ? 'MangaDex comes through Breader’s own computer, which can’t be reached just now.'
    : e instanceof Error ? e.message : 'Breader couldn’t reach MangaDex.';

export function Browse({ id, labelledBy, hidden, have, prefs, onPrefs, onPick }: Props) {
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [found, setFound] = useState<Found>({ state: 'loading' });
  const [tries, setTries] = useState(0);
  const end = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const loadingMore = useRef(false);
  // Searching, the best match comes first; otherwise the order picked.
  const sort: MangaSort = q ? 'relevance' : prefs.sort;
  const ask = { q, lang: prefs.lang || undefined, sort, adult: prefs.adult };
  const askKey = JSON.stringify(ask);

  // A pause in typing searches.
  useEffect(() => {
    const t = window.setTimeout(() => setQ(text.trim()), 350);
    return () => window.clearTimeout(t);
  }, [text]);

  useEffect(() => {
    let live = true;
    setFound({ state: 'loading' });
    scroller.current?.scrollTo({ top: 0 });
    mangadex.search(ask).then(
      (r) => { if (live) setFound({ state: 'ready', items: r.items, total: r.total, more: r.offset + r.items.length < r.total && r.items.length > 0 }); },
      (e) => { if (live) setFound({ state: 'error', message: messageOf(e) }); },
    );
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [askKey, tries]);

  // Near the end of what's shown, the next lot comes.
  const ready = found.state === 'ready' ? found : null;
  useEffect(() => {
    const el = end.current;
    if (!el || !ready?.more || hidden) return;
    const io = new IntersectionObserver((entries) => {
      if (!entries[0].isIntersecting || loadingMore.current) return;
      loadingMore.current = true;
      const offset = ready.items.length;
      mangadex.search({ ...ask, offset }).then(
        (r) => {
          setFound((f) => {
            if (f.state !== 'ready' || f.items.length !== offset) return f;
            const seen = new Set(f.items.map((x) => x.id));
            const items = [...f.items, ...r.items.filter((x) => !seen.has(x.id))];
            return { state: 'ready', items, total: r.total, more: r.items.length > 0 && r.offset + r.items.length < r.total };
          });
        },
        () => setFound((f) => (f.state === 'ready' ? { ...f, more: false } : f)),
      ).finally(() => { loadingMore.current = false; });
    }, { root: scroller.current, rootMargin: '600px 0px' });
    io.observe(el);
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, hidden, askKey]);

  const set = (p: Partial<MangaPrefs>) => {
    const next = { ...prefs, ...p };
    writeMangaPrefs(next);
    onPrefs(next);
  };

  return (
    <div id={id} role="tabpanel" aria-labelledby={labelledBy} hidden={hidden} className="gallery mdx" ref={scroller}>
      <div className="mdx-bar">
        <label className="mdx-search">
          <IconSearch />
          <span className="sr-only">Search MangaDex</span>
          <input type="search" value={text} placeholder="Search MangaDex" enterKeyHint="search" onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') setQ(text.trim()); }} />
        </label>
        <div className="mdx-tools">
          <div className="mdx-sorts" role="radiogroup" aria-label="Order">
            {SORTS.map((s) => (
              <button key={s.v} type="button" role="radio" aria-checked={!q && prefs.sort === s.v} className="mdx-sort" disabled={!!q} onClick={() => set({ sort: s.v })}>{s.label}</button>
            ))}
          </div>
          <label className="mdx-lang">
            <span className="sr-only">Language</span>
            <select value={prefs.lang} onChange={(e) => set({ lang: e.target.value })}>
              <option value="">Any language</option>
              {LANGS.map((l) => <option key={l} value={l}>{langName(l)}</option>)}
            </select>
          </label>
          <span className="mdx-switch">
            <span id={`${id}-adult`}>18+</span>
            <button type="button" className="switch" role="switch" aria-checked={prefs.adult} aria-labelledby={`${id}-adult`} title="Show series for adults too" onClick={() => set({ adult: !prefs.adult })} />
          </span>
        </div>
      </div>

      {found.state === 'error' ? (
        <div className="mdx-note">
          <p>{found.message}</p>
          <button type="button" className="btn btn-quiet" onClick={() => setTries((n) => n + 1)}>Try again</button>
        </div>
      ) : found.state === 'loading' ? (
        <div className="mdx-grid" aria-busy="true">
          {Array.from({ length: 12 }, (_, i) => <span key={i} className="mdx-card is-ghost"><span className="mdx-cover" /></span>)}
        </div>
      ) : found.items.length === 0 ? (
        <div className="mdx-note"><p>{q ? `Nothing on MangaDex goes by “${q}”${prefs.lang ? ` in ${langName(prefs.lang)}` : ''}.` : 'Nothing here yet.'}</p></div>
      ) : (
        <>
          <ul className="mdx-grid">
            {found.items.map((c) => (
              <li key={c.id}>
                <button type="button" className="mdx-card" onClick={() => onPick(c)}>
                  <span className="mdx-cover">
                    {c.cover ? (
                      <img
                        src={mangadex.coverUrl(c.id, c.cover, 256)}
                        srcSet={`${mangadex.coverUrl(c.id, c.cover, 256)} 256w, ${mangadex.coverUrl(c.id, c.cover, 512)} 512w`}
                        sizes="(max-width: 640px) 45vw, 190px"
                        alt=""
                        loading="lazy"
                        decoding="async"
                        draggable={false}
                      />
                    ) : <span className="mdx-nocover">{c.title}</span>}
                    {have.has(c.id) && <span className="mdx-have" title="In My manga"><IconCheck /></span>}
                    {c.rating === 'erotica' || c.rating === 'pornographic' ? <span className="mdx-badge">18+</span> : null}
                  </span>
                  <span className="mdx-title">{c.title}</span>
                  <span className="mdx-meta">{[c.year, c.status ? STATUS_NAME[c.status] : null, c.rating === 'suggestive' ? RATING_NAME.suggestive : null].filter(Boolean).join(' · ')}</span>
                </button>
              </li>
            ))}
          </ul>
          <div ref={end} className="mdx-end">{found.more ? <span className="add-spinner" /> : null}</div>
        </>
      )}
      <p className="mdx-credit">
        Series, chapters and pages from <a href="https://mangadex.org" target="_blank" rel="noopener noreferrer">MangaDex</a>, made by the scanlation groups credited with each chapter. Where a publisher puts a series up itself, its sheet links there.
      </p>
    </div>
  );
}
