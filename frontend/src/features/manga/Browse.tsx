import { useEffect, useMemo, useRef, useState } from 'react';
import { MANGA_KINDS, type MangaFound, type MangaKind, type MangaSort } from '@breader/shared/manga';
import { IconCheck, IconSearch } from '../../components/icons';
import { LANGS, langName, mangadex, writeMangaPrefs, type MangaPrefs } from '../../lib/mangadex';
import { entriesOf, viewOf } from './found';
import './manga.css';

/*
 * The Manga shelf's Browse tab: one search across every place Breader's computer looks (MangaDex
 * and its Suwayomi sources), by name or by what's popular, new or just updated, in a language. The
 * same series found in several places is one card (found.ts), saying where under the title. Under
 * the search, one line holds the order, the kinds to show, Doujinshi, 18+ and the language, each a
 * dot that lights when it's on. Series for adults show only once 18+ is on. Picking one opens its
 * sheet (MangaSheet.tsx), to pick a copy, read it or add it to My manga.
 */

interface Props {
  id: string;
  labelledBy: string;
  hidden: boolean;
  /** Series already in My manga: MangaDex ids, and source ids (sw:44). */
  have: ReadonlySet<string>;
  prefs: MangaPrefs;
  onPrefs: (p: MangaPrefs) => void;
  /** A series picked: everywhere it was found, the first the one it opens at. */
  onPick: (found: MangaFound[]) => void;
}

const SORTS: Array<{ v: MangaSort; label: string }> = [
  { v: 'popular', label: 'Popular' },
  { v: 'latest', label: 'Updated' },
  { v: 'new', label: 'New' },
  { v: 'rated', label: 'Top rated' },
];

const KINDS: Array<{ v: MangaKind; label: string; about: string }> = [
  { v: 'manga', label: 'Manga', about: 'Manga: from Japan' },
  { v: 'manhwa', label: 'Manhwa', about: 'Manhwa: from Korea, mostly webtoons' },
  { v: 'manhua', label: 'Manhua', about: 'Manhua: from China' },
  { v: 'comics', label: 'Comics', about: 'Comics: from everywhere else' },
];

/**
 * ask: the search these are for (askKey), so a lot asked for by an earlier one is never added.
 * next: where the next lot starts, as the server said, or null once every place is done.
 */
type Found = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; ask: string; items: MangaFound[]; next: string | null };

function messageOf(e: unknown): string {
  if (e instanceof Error) return e.message;
  return 'Breader couldn’t reach it.';
}

export function Browse({ id, labelledBy, hidden, have, prefs, onPrefs, onPick }: Props) {
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [found, setFound] = useState<Found>({ state: 'loading' });
  const [tries, setTries] = useState(0);
  const end = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  /** The search a next lot is being fetched for, if any. */
  const loadingMore = useRef<string | null>(null);

  // Searching, the best match comes first; otherwise the order picked.
  let sort: MangaSort = prefs.sort;
  if (q) sort = 'relevance';
  const askKey = JSON.stringify({ q, lang: prefs.lang, sort, adult: prefs.adult, doujinshi: prefs.doujinshi, kinds: prefs.kinds });

  // A pause in typing searches.
  useEffect(() => {
    const t = window.setTimeout(() => setQ(text.trim()), 350);
    return () => window.clearTimeout(t);
  }, [text]);

  /**
   * A lot of results from every place, from where the search had got to. Only series that can be
   * read here show, and a slow place shows with the next lot, so a lot can be short or even empty.
   */
  const fetchLot = async (next: string | null): Promise<{ items: MangaFound[]; next: string | null }> => {
    const r = await mangadex.search({ q, lang: prefs.lang || undefined, sort, adult: prefs.adult, doujinshi: prefs.doujinshi, kinds: prefs.kinds, next: next ?? undefined });
    return { items: r.items, next: r.next };
  };

  useEffect(() => {
    let live = true;
    setFound({ state: 'loading' });
    scroller.current?.scrollTo({ top: 0 });
    fetchLot(null).then(
      (r) => { if (live) setFound({ state: 'ready', ask: askKey, ...r }); },
      (e) => { if (live) setFound({ state: 'error', message: messageOf(e) }); },
    );
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [askKey, tries]);

  // Near the end of what's shown, the next lot comes. A lot that came back empty leaves the end in
  // view, so the one after it is asked for straight away. Another search started meanwhile (a dot
  // flipped, say) may have got just as far, so a lot is added only to the search it's for.
  const ready = found.state === 'ready' ? found : null;
  useEffect(() => {
    const el = end.current;
    if (!el || !ready?.next || hidden) return;
    const ask = ready.ask;
    const io = new IntersectionObserver((entries) => {
      if (!entries[0].isIntersecting || loadingMore.current === ask) return;
      loadingMore.current = ask;
      const at = ready.next;
      fetchLot(at).then(
        (r) => {
          setFound((f) => {
            if (f.state !== 'ready' || f.ask !== ask || f.next !== at) return f;
            const seen = new Set(f.items.map((x) => x.card.id));
            const fresh = r.items.filter((x) => !seen.has(x.card.id));
            return { state: 'ready', ask, items: [...f.items, ...fresh], next: r.next };
          });
        },
        () => {
          setFound((f) => {
            if (f.state !== 'ready' || f.ask !== ask) return f;
            return { ...f, next: null };
          });
        },
      ).finally(() => {
        if (loadingMore.current === ask) loadingMore.current = null;
      });
    }, { root: scroller.current, rootMargin: '600px 0px' });
    io.observe(el);
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, hidden, askKey]);

  // One card a series, however many places have it. A later lot's copy joins the card it's the
  // same series as. What's in My manga shows as it changes, without asking again.
  const items = useMemo(() => {
    if (!ready) return [];
    return entriesOf(ready.items).map((e) => ({
      ...viewOf(e),
      have: e.found.some((f) => have.has(f.card.id)),
      pick: () => onPick(e.found),
    }));
  }, [ready, have, onPick]);

  const set = (p: Partial<MangaPrefs>) => {
    const next = { ...prefs, ...p };
    writeMangaPrefs(next);
    onPrefs(next);
  };

  const flipKind = (kind: MangaKind) => {
    const on = prefs.kinds.includes(kind);
    // One kind stays on, as a search for none would find nothing.
    if (on && prefs.kinds.length === 1) return;
    let kinds: MangaKind[];
    if (on) kinds = prefs.kinds.filter((k) => k !== kind);
    else kinds = MANGA_KINDS.filter((k) => k === kind || prefs.kinds.includes(k));
    set({ kinds });
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
        <div className="mdx-row">
          <div className="mdx-sorts" role="radiogroup" aria-label="Order">
            {SORTS.map((s) => (
              <button key={s.v} type="button" role="radio" aria-checked={!q && prefs.sort === s.v} className="mdx-sort" disabled={!!q} onClick={() => set({ sort: s.v })}>{s.label}</button>
            ))}
          </div>
          <div className="mdx-right">
            <div className="mdx-dots" role="group" aria-label="Show">
              {KINDS.map((k) => (
                <button key={k.v} type="button" className="mdx-dot" aria-pressed={prefs.kinds.includes(k.v)} title={k.about} onClick={() => flipKind(k.v)}>
                  <span className="mdx-led" />
                  {k.label}
                </button>
              ))}
              <span className="mdx-rule" />
              <button type="button" className="mdx-dot" aria-pressed={prefs.doujinshi} title="Doujinshi (fan-made works) and anthologies too" onClick={() => set({ doujinshi: !prefs.doujinshi })}>
                <span className="mdx-led" />
                Doujin
              </button>
              <button type="button" className="mdx-dot" aria-pressed={prefs.adult} title="Series for adults too" onClick={() => set({ adult: !prefs.adult })}>
                <span className="mdx-led" />
                18+
              </button>
            </div>
            <label className="mdx-lang">
              <span className="sr-only">Language</span>
              <select value={prefs.lang} onChange={(e) => set({ lang: e.target.value })}>
                <option value="">Any language</option>
                {LANGS.map((l) => <option key={l} value={l}>{langName(l)}</option>)}
              </select>
            </label>
          </div>
        </div>
      </div>

      {body}

      <p className="mdx-credit">
        Series come from <a href="https://mangadex.org" target="_blank" rel="noopener noreferrer">MangaDex</a>, and the sites Breader’s Suwayomi reads, each card saying which. Chapters credit the scanlation groups that made them, and where a publisher puts a series up itself, its sheet links there.
      </p>
    </div>
  );
}
