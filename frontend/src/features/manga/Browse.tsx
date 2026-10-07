import { useEffect, useMemo, useRef, useState } from 'react';
import type { MangaCard, MangaFound, MangaSort, SourceCard } from '@breader/shared/manga';
import { IconCheck, IconSearch } from '../../components/icons';
import { LANGS, langName, mangadex, RATING_NAME, sources, STATUS_NAME, writeMangaPrefs, type MangaPrefs } from '../../lib/mangadex';
import './manga.css';

/*
 * The Manga shelf's Browse tab: one search across every place Breader's computer looks (MangaDex,
 * its Suwayomi sources, its Komga library), by name or by what's popular, new or just updated, in a
 * language. The same series found in two places is two cards, each naming its place under the
 * title. Series for adults show only once 18+ is on. Picking one opens its sheet (SeriesSheet.tsx,
 * SourceSheet.tsx), to read it or add it to My manga.
 */

interface Props {
  id: string;
  labelledBy: string;
  hidden: boolean;
  /** Series already in My manga: MangaDex ids, and source ids (sw:44, kg:0RVCY8NST343X). */
  have: ReadonlySet<string>;
  prefs: MangaPrefs;
  onPrefs: (p: MangaPrefs) => void;
  onPick: (card: MangaCard) => void;
  onPickSource: (card: SourceCard) => void;
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
  /** The quiet line under the title: where it's from, then what else is known. */
  meta: string;
  /** A MangaDex cover comes in two sizes, a source's in one. */
  cover: { src: string; srcSet: string | undefined } | null;
  have: boolean;
  adult: boolean;
  pick: () => void;
}

/** next: where the next lot starts, as the server said, or null once every place is done. */
type Found = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; items: Item[]; next: string | null };

function messageOf(e: unknown): string {
  if (e instanceof Error) return e.message;
  return 'Breader couldn’t reach it.';
}

export function Browse({ id, labelledBy, hidden, have, prefs, onPrefs, onPick, onPickSource }: Props) {
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [found, setFound] = useState<Found>({ state: 'loading' });
  const [tries, setTries] = useState(0);
  const end = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const loadingMore = useRef(false);

  // Searching, the best match comes first; otherwise the order picked.
  let sort: MangaSort = prefs.sort;
  if (q) sort = 'relevance';
  const askKey = JSON.stringify({ q, lang: prefs.lang, sort, adult: prefs.adult, doujinshi: prefs.doujinshi });

  // A pause in typing searches.
  useEffect(() => {
    const t = window.setTimeout(() => setQ(text.trim()), 350);
    return () => window.clearTimeout(t);
  }, [text]);

  const itemOf = (f: MangaFound): Item => {
    if (f.kind === 'mangadex') {
      const c = f.card;
      const meta = [f.source];
      if (c.year) meta.push(String(c.year));
      if (c.status) meta.push(STATUS_NAME[c.status]);
      if (c.rating === 'suggestive') meta.push(RATING_NAME.suggestive);
      let cover: Item['cover'] = null;
      if (c.cover) {
        const small = mangadex.coverUrl(c.id, c.cover, 256);
        const big = mangadex.coverUrl(c.id, c.cover, 512);
        cover = { src: small, srcSet: `${small} 256w, ${big} 512w` };
      }
      return {
        key: c.id,
        title: c.title,
        meta: meta.join(' · '),
        cover,
        have: false,
        adult: c.rating === 'erotica' || c.rating === 'pornographic',
        pick: () => onPick(c),
      };
    }
    const c = f.card;
    const meta = [f.source];
    if (c.status) meta.push(STATUS_NAME[c.status]);
    let cover: Item['cover'] = null;
    if (c.cover) cover = { src: sources.coverUrl(c.cover), srcSet: undefined };
    return {
      key: c.id,
      title: c.title,
      meta: meta.join(' · '),
      cover,
      have: false,
      adult: c.adult,
      pick: () => onPickSource(c),
    };
  };

  /**
   * A lot of results from every place, from where the search had got to. Only series that can be
   * read here show, and a slow place shows with the next lot, so a lot can be short or even empty.
   */
  const fetchLot = async (next: string | null): Promise<{ items: Item[]; next: string | null }> => {
    const r = await mangadex.search({ q, lang: prefs.lang || undefined, sort, adult: prefs.adult, doujinshi: prefs.doujinshi, next: next ?? undefined });
    return { items: r.items.map(itemOf), next: r.next };
  };

  useEffect(() => {
    let live = true;
    setFound({ state: 'loading' });
    scroller.current?.scrollTo({ top: 0 });
    fetchLot(null).then(
      (r) => { if (live) setFound({ state: 'ready', ...r }); },
      (e) => { if (live) setFound({ state: 'error', message: messageOf(e) }); },
    );
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [askKey, tries]);

  // Near the end of what's shown, the next lot comes. A lot that came back empty leaves the end in
  // view, so the one after it is asked for straight away.
  const ready = found.state === 'ready' ? found : null;
  useEffect(() => {
    const el = end.current;
    if (!el || !ready?.next || hidden) return;
    const io = new IntersectionObserver((entries) => {
      if (!entries[0].isIntersecting || loadingMore.current) return;
      loadingMore.current = true;
      const at = ready.next;
      fetchLot(at).then(
        (r) => {
          setFound((f) => {
            if (f.state !== 'ready' || f.next !== at) return f;
            const seen = new Set(f.items.map((x) => x.key));
            const fresh = r.items.filter((x) => !seen.has(x.key));
            return { state: 'ready', items: [...f.items, ...fresh], next: r.next };
          });
        },
        () => setFound((f) => (f.state === 'ready' ? { ...f, next: null } : f)),
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

  let nothing = 'Nothing here yet.';
  if (q) {
    nothing = `Nothing goes by “${q}”`;
    if (prefs.lang) nothing += ` in ${langName(prefs.lang)}`;
    nothing += '.';
  }

  let body;
  if (found.state === 'error') {
    body = (
      <div className="mdx-note">
        <p>{found.message}</p>
        <button type="button" className="btn btn-quiet" onClick={() => setTries((n) => n + 1)}>Try again</button>
      </div>
    );
  } else if (found.state === 'loading') {
    body = (
      <div className="mdx-grid" aria-busy="true">
        {Array.from({ length: 12 }, (_, i) => <span key={i} className="mdx-card is-ghost"><span className="mdx-cover" /></span>)}
      </div>
    );
  } else if (items.length === 0 && !found.next) {
    body = <div className="mdx-note"><p>{nothing}</p></div>;
  } else {
    body = (
      <>
        <ul className="mdx-grid">
          {items.map((c) => (
            <li key={c.key}>
              <button type="button" className="mdx-card" onClick={c.pick}>
                <span className="mdx-cover">
                  {c.cover ? (
                    <img src={c.cover.src} srcSet={c.cover.srcSet} sizes="(max-width: 640px) 45vw, 190px" alt="" loading="lazy" decoding="async" draggable={false} />
                  ) : (
                    <span className="mdx-nocover">{c.title}</span>
                  )}
                  {c.have && <span className="mdx-have" title="In My manga"><IconCheck /></span>}
                  {c.adult && <span className="mdx-badge">18+</span>}
                </span>
                <span className="mdx-title">{c.title}</span>
                <span className="mdx-meta">{c.meta}</span>
              </button>
            </li>
          ))}
        </ul>
        <div ref={end} className="mdx-end">{found.next ? <span className="add-spinner" /> : null}</div>
      </>
    );
  }

  return (
    <div id={id} role="tabpanel" aria-labelledby={labelledBy} hidden={hidden} className="gallery mdx" ref={scroller}>
      <div className="mdx-bar">
        <label className="mdx-search">
          <IconSearch />
          <span className="sr-only">Search manga</span>
          <input type="search" value={text} placeholder="Search manga" enterKeyHint="search" onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') setQ(text.trim()); }} />
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
            <span id={`${id}-doujinshi`}>Doujinshi</span>
            <button type="button" className="switch" role="switch" aria-checked={prefs.doujinshi} aria-labelledby={`${id}-doujinshi`} title="Show doujinshi (fan-made works) and anthologies too" onClick={() => set({ doujinshi: !prefs.doujinshi })} />
          </span>
          <span className="mdx-switch">
            <span id={`${id}-adult`}>18+</span>
            <button type="button" className="switch" role="switch" aria-checked={prefs.adult} aria-labelledby={`${id}-adult`} title="Show series for adults too" onClick={() => set({ adult: !prefs.adult })} />
          </span>
        </div>
      </div>

      {body}

      <p className="mdx-credit">
        Series come from <a href="https://mangadex.org" target="_blank" rel="noopener noreferrer">MangaDex</a>, Breader’s Suwayomi sources and its Komga library, each card saying which. Chapters credit the scanlation groups that made them, and where a publisher puts a series up itself, its sheet links there.
      </p>
    </div>
  );
}
