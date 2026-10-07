import { useEffect, useMemo, useRef, useState } from 'react';
import type { MangaCard, MangaSort } from '@breader/shared/manga';
import { IconCaret, IconCheck, IconSearch } from '../../components/icons';
import { ApiError } from '../../lib/api';
import { LANGS, langName, mangadex, RATING_NAME, STATUS_NAME, writeMangaPrefs, type MangaPrefs } from '../../lib/mangadex';
import type { Entry } from '../../lib/opds';
import { readCatalog } from '../../lib/opds';
import { readServer, suwayomi, type ServerCard, type ServerSource } from '../../lib/suwayomi';
import { Catalog } from './Catalog';
import { ServerCover } from './ServerCover';
import './manga.css';

/*
 * The Manga shelf's Browse tab: series to find on MangaDex, by name or by what's popular, new or
 * just updated, in a language; or on a source of the reader's own Suwayomi server, which can be any
 * extension installed there. Series for adults (and adult sources) show only once 18+ is on. Picking
 * one opens its sheet (SeriesSheet.tsx, ServerSheet.tsx), to read it or add it to My manga.
 */

interface Props {
  id: string;
  labelledBy: string;
  hidden: boolean;
  /** Series already in My manga: MangaDex ids, and sw:<id> for those on the reader's server. */
  have: ReadonlySet<string>;
  prefs: MangaPrefs;
  /** Changes when a server is connected or let go, so its sources are asked again. */
  server: string | null;
  /** The reader's OPDS catalog, when one's connected; changes when it does. */
  catalog: string | null;
  /** Downloads a book from the catalog into the library. */
  onAddBook: (book: Extract<Entry, { kind: 'book' }>) => Promise<void>;
  onPrefs: (p: MangaPrefs) => void;
  onPick: (card: MangaCard) => void;
  onPickServer: (card: ServerCard) => void;
  onConnect: () => void;
}

const SORTS: Array<{ v: MangaSort; label: string }> = [
  { v: 'popular', label: 'Popular' },
  { v: 'latest', label: 'Updated' },
  { v: 'new', label: 'New' },
  { v: 'rated', label: 'Top rated' },
];

interface Item {
  key: string;
  title: string;
  meta: string;
  cover: { url: string; small: string } | { path: string } | null;
  have: boolean;
  adult: boolean;
  pick: () => void;
}

/** next: where the next lot starts, MangaDex's offset after what it looked through. */
type Found = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; items: Item[]; more: boolean; next: number };

const messageOf = (e: unknown) =>
  e instanceof ApiError && e.code === 'laptop_off'
    ? 'MangaDex comes through Breader’s own computer, which can’t be reached just now.'
    : e instanceof Error ? e.message : 'Breader couldn’t reach it.';

export function Browse({ id, labelledBy, hidden, have, prefs, server, catalog, onPrefs, onPick, onPickServer, onAddBook, onConnect }: Props) {
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [found, setFound] = useState<Found>({ state: 'loading' });
  const [tries, setTries] = useState(0);
  const [sources, setSources] = useState<ServerSource[] | null>(null);
  const [picking, setPicking] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const loadingMore = useRef(false);
  const page = useRef(1);

  // The reader's server's sources, once it's connected.
  useEffect(() => {
    if (!server) { setSources(null); return; }
    let live = true;
    suwayomi.sources().then((s) => { if (live) setSources(s); }, () => { if (live) setSources([]); });
    return () => { live = false; };
  }, [server]);

  const shownSources = useMemo(
    () => (sources ?? []).filter((s) => prefs.adult || !s.isNsfw).sort((a, b) => a.displayName.localeCompare(b.displayName)),
    [sources, prefs.adult],
  );
  const onServer = prefs.source.startsWith('sw:') && !!server;
  const source = onServer ? sources?.find((s) => `sw:${s.id}` === prefs.source) : undefined;
  // A source not there any more, or adult with 18+ off, or no server: MangaDex.
  const gone = !server || (!!sources && (!source || (source.isNsfw && !prefs.adult)));
  const where = prefs.source === 'opds' && catalog ? 'opds' : prefs.source.startsWith('sw:') && !gone ? prefs.source : 'mangadex';
  const serverSort = source?.supportsLatest ? prefs.serverSort : 'POPULAR';
  // Searching, the best match comes first; otherwise the order picked.
  const sort: MangaSort = q ? 'relevance' : prefs.sort;
  const ask = where === 'mangadex' ? { where, q, lang: prefs.lang || undefined, sort, adult: prefs.adult, doujinshi: prefs.doujinshi } : { where, q, serverSort };
  const askKey = JSON.stringify(ask);
  /** A source on the server, while the server's sources are still on their way. */
  const waiting = where.startsWith('sw:') && !source;

  // A pause in typing searches.
  useEffect(() => {
    const t = window.setTimeout(() => setQ(text.trim()), 350);
    return () => window.clearTimeout(t);
  }, [text]);

  const mdItem = (c: MangaCard): Item => ({
    key: c.id,
    title: c.title,
    meta: [c.year, c.status ? STATUS_NAME[c.status] : null, c.rating === 'suggestive' ? RATING_NAME.suggestive : null].filter(Boolean).join(' · '),
    cover: c.cover ? { url: mangadex.coverUrl(c.id, c.cover, 512), small: mangadex.coverUrl(c.id, c.cover, 256) } : null,
    have: false,
    adult: c.rating === 'erotica' || c.rating === 'pornographic',
    pick: () => onPick(c),
  });
  const swItem = (c: ServerCard): Item => ({
    key: `sw:${c.id}`,
    title: c.title,
    meta: source?.displayName ?? '',
    cover: c.thumbnailUrl ? { path: c.thumbnailUrl } : null,
    have: false,
    adult: !!source?.isNsfw,
    pick: () => onPickServer(c),
  });

  /**
   * A lot of results: MangaDex's from an offset, only the series that can be read here, so it can
   * be short or even empty; a server source's by page.
   */
  const fetchLot = async (offset: number): Promise<{ items: Item[]; more: boolean; next: number }> => {
    if (where === 'mangadex') {
      const r = await mangadex.search({ q, lang: prefs.lang || undefined, sort, adult: prefs.adult, doujinshi: prefs.doujinshi, offset });
      return { items: r.items.map(mdItem), more: r.next !== null, next: r.next ?? offset };
    }
    const n = offset === 0 ? 1 : page.current + 1;
    const r = await suwayomi.browse(source!.id, q ? 'SEARCH' : serverSort, n, q || undefined);
    page.current = n;
    return { items: r.mangas.map(swItem), more: r.hasNextPage && r.mangas.length > 0, next: offset + r.mangas.length };
  };

  useEffect(() => {
    if (waiting || where === 'opds') return;
    let live = true;
    setFound({ state: 'loading' });
    scroller.current?.scrollTo({ top: 0 });
    page.current = 1;
    fetchLot(0).then(
      (r) => { if (live) setFound({ state: 'ready', ...r }); },
      (e) => { if (live) setFound({ state: 'error', message: messageOf(e) }); },
    );
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [askKey, tries, waiting]);

  // Near the end of what's shown, the next lot comes.
  const ready = found.state === 'ready' ? found : null;
  useEffect(() => {
    const el = end.current;
    if (!el || !ready?.more || hidden) return;
    const io = new IntersectionObserver((entries) => {
      if (!entries[0].isIntersecting || loadingMore.current) return;
      loadingMore.current = true;
      const offset = ready.next;
      fetchLot(offset).then(
        (r) => {
          setFound((f) => {
            if (f.state !== 'ready' || f.next !== offset) return f;
            const seen = new Set(f.items.map((x) => x.key));
            return { state: 'ready', items: [...f.items, ...r.items.filter((x) => !seen.has(x.key))], more: r.more, next: r.next };
          });
        },
        () => setFound((f) => (f.state === 'ready' ? { ...f, more: false } : f)),
      ).finally(() => { loadingMore.current = false; });
    }, { root: scroller.current, rootMargin: '600px 0px' });
    io.observe(el);
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, hidden, askKey]);

  // What's in My manga shows as it changes, without asking again.
  const items = useMemo(() => (ready ? ready.items.map((x) => ({ ...x, have: have.has(x.key) })) : []), [ready, have]);

  const set = (p: Partial<MangaPrefs>) => {
    const next = { ...prefs, ...p };
    writeMangaPrefs(next);
    onPrefs(next);
  };

  // The list of places to look closes on a click elsewhere, or Escape.
  const pickerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!picking) return;
    const away = (e: PointerEvent) => { if (!pickerRef.current?.contains(e.target as Node)) setPicking(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setPicking(false); };
    window.addEventListener('pointerdown', away);
    window.addEventListener('keydown', esc);
    return () => { window.removeEventListener('pointerdown', away); window.removeEventListener('keydown', esc); };
  }, [picking]);
  const choose = (s: string) => {
    setPicking(false);
    if (s !== prefs.source) set({ source: s });
  };
  const sourceName = where === 'mangadex' ? 'MangaDex' : where === 'opds' ? 'your catalog' : source?.displayName ?? 'your server';
  const hostOf = (url?: string) => { try { return url ? new URL(url).host : ''; } catch { return ''; } };
  const host = hostOf(readServer()?.url);

  return (
    <div id={id} role="tabpanel" aria-labelledby={labelledBy} hidden={hidden} className="gallery mdx" ref={scroller}>
      <div className="mdx-bar">
        <div className="mdx-from" ref={pickerRef}>
          <button type="button" className="mdx-from-b" aria-haspopup="listbox" aria-expanded={picking} onClick={() => setPicking(!picking)}>
            <span>{where === 'mangadex' ? 'MangaDex' : where === 'opds' ? 'Your catalog' : source?.displayName ?? 'Your server'}</span>
            <IconCaret />
          </button>
          {picking && (
            <div className="mdx-from-list" role="listbox" aria-label="Where to look">
              <button type="button" role="option" aria-selected={where === 'mangadex'} onClick={() => choose('mangadex')}>
                <span>MangaDex</span>
                <small>through Breader’s computer</small>
              </button>
              {server && (
                <>
                  <div className="mdx-from-h">{host || 'Your server'}</div>
                  {sources === null && <div className="mdx-from-note">Asking your server…</div>}
                  {sources?.length === 0 && <div className="mdx-from-note">No sources there yet. Install extensions on your server to read from them here.</div>}
                  {shownSources.map((s) => (
                    <button key={s.id} type="button" role="option" aria-selected={where === `sw:${s.id}`} onClick={() => choose(`sw:${s.id}`)}>
                      <span>{s.displayName}</span>
                      {s.isNsfw && <small className="is-adult">18+</small>}
                    </button>
                  ))}
                  {sources && sources.length > shownSources.length && <div className="mdx-from-note">Turn on 18+ for its sources for adults.</div>}
                </>
              )}
              {catalog && (
                <>
                  <div className="mdx-from-h">{hostOf(readCatalog()?.url) || 'Your catalog'}</div>
                  <button type="button" role="option" aria-selected={where === 'opds'} onClick={() => choose('opds')}>
                    <span>Your catalog</span>
                    <small>OPDS</small>
                  </button>
                </>
              )}
              <button type="button" className="mdx-from-connect" onClick={() => { setPicking(false); onConnect(); }}>
                {server || catalog ? 'Your servers…' : 'Connect your own server…'}
              </button>
            </div>
          )}
        </div>
        {where !== 'opds' && <label className="mdx-search">
          <IconSearch />
          <span className="sr-only">Search {sourceName}</span>
          <input type="search" value={text} placeholder={`Search ${sourceName}`} enterKeyHint="search" onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') setQ(text.trim()); }} />
        </label>}
        {where !== 'opds' && <div className="mdx-tools">
          {where === 'mangadex' ? (
            <>
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
            </>
          ) : (
            <div className="mdx-sorts" role="radiogroup" aria-label="Order">
              <button type="button" role="radio" aria-checked={!q && serverSort === 'POPULAR'} className="mdx-sort" disabled={!!q} onClick={() => set({ serverSort: 'POPULAR' })}>Popular</button>
              {source?.supportsLatest && (
                <button type="button" role="radio" aria-checked={!q && serverSort === 'LATEST'} className="mdx-sort" disabled={!!q} onClick={() => set({ serverSort: 'LATEST' })}>Latest</button>
              )}
            </div>
          )}
          {where === 'mangadex' && (
            <span className="mdx-switch">
              <span id={`${id}-doujinshi`}>Doujinshi</span>
              <button type="button" className="switch" role="switch" aria-checked={prefs.doujinshi} aria-labelledby={`${id}-doujinshi`} title="Show doujinshi, fan-made works, too" onClick={() => set({ doujinshi: !prefs.doujinshi })} />
            </span>
          )}
          <span className="mdx-switch">
            <span id={`${id}-adult`}>18+</span>
            <button type="button" className="switch" role="switch" aria-checked={prefs.adult} aria-labelledby={`${id}-adult`} title="Show series and sources for adults too" onClick={() => set({ adult: !prefs.adult })} />
          </span>
        </div>}
      </div>

      {where === 'opds' ? (
        <Catalog key={catalog ?? ''} onAdd={onAddBook} />
      ) : found.state === 'error' && !waiting ? (
        <div className="mdx-note">
          <p>{found.message}</p>
          <button type="button" className="btn btn-quiet" onClick={() => setTries((n) => n + 1)}>Try again</button>
        </div>
      ) : found.state === 'loading' || waiting ? (
        <div className="mdx-grid" aria-busy="true">
          {Array.from({ length: 12 }, (_, i) => <span key={i} className="mdx-card is-ghost"><span className="mdx-cover" /></span>)}
        </div>
      ) : items.length === 0 && !ready?.more ? (
        <div className="mdx-note"><p>{q ? `Nothing on ${sourceName} goes by “${q}”${where === 'mangadex' && prefs.lang ? ` in ${langName(prefs.lang)}` : ''}.` : 'Nothing here yet.'}</p></div>
      ) : (
        <>
          <ul className="mdx-grid">
            {items.map((c) => (
              <li key={c.key}>
                <button type="button" className="mdx-card" onClick={c.pick}>
                  <span className="mdx-cover">
                    {c.cover && 'url' in c.cover ? (
                      <img src={c.cover.small} srcSet={`${c.cover.small} 256w, ${c.cover.url} 512w`} sizes="(max-width: 640px) 45vw, 190px" alt="" loading="lazy" decoding="async" draggable={false} />
                    ) : c.cover ? (
                      <ServerCover path={c.cover.path} />
                    ) : (
                      <span className="mdx-nocover">{c.title}</span>
                    )}
                    {c.have && <span className="mdx-have" title="In My manga"><IconCheck /></span>}
                    {c.adult && <span className="mdx-badge">18+</span>}
                  </span>
                  <span className="mdx-title">{c.title}</span>
                  {c.meta && <span className="mdx-meta">{c.meta}</span>}
                </button>
              </li>
            ))}
          </ul>
          <div ref={end} className="mdx-end">{ready?.more ? <span className="add-spinner" /> : null}</div>
        </>
      )}
      <p className="mdx-credit">
        {where === 'opds' ? (
          <>From your own catalog. Breader asks it from this browser, and its address and login stay here.</>
        ) : where === 'mangadex' ? (
          <>Series, chapters and pages from <a href="https://mangadex.org" target="_blank" rel="noopener noreferrer">MangaDex</a>, made by the scanlation groups credited with each chapter. Where a publisher puts a series up itself, its sheet links there.</>
        ) : (
          <>From {sourceName}, through your own Suwayomi server. Breader asks it from this browser, and its address and login stay here.</>
        )}
      </p>
    </div>
  );
}
