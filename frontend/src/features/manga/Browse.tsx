import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { MANGA_KINDS, type MangaFound, type MangaKind, type MangaSort } from '@breader/shared/manga';
import { IconCheck, IconSearch } from '../../components/icons';
import { useLabels } from '../../data/labels';
import { LANGS, langName, mangadex, writeMangaPrefs, type MangaPrefs } from '../../lib/mangadex';
import { entriesOf, viewOf } from './found';
import './manga.css';

/*
 * The Manga shelf's Browse, opened by its button in the header: one search across every place Breader's computer looks (MangaDex
 * and its Suwayomi sources), by name or by what's popular, new or just updated, in a language. The
 * same series found in several places is one card (found.ts), saying where under the title. Under
 * the search, one line holds the order, the kinds to show, Doujinshi, 18+ and the language, each a
 * dot that lights when it's on. Series for adults show only once 18+ is on. Picking one opens its
 * sheet (MangaSheet.tsx), to pick a copy, read it or add it to My manga.
 */

interface Props {
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

/** What one lot found, and where the one after it starts. */
type Lot = { items: MangaFound[]; next: string | null };

/** How long a lot that got nowhere, every place late, waits before it's asked for again. */
const STILL_MS = 5_000;

const wait = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

/**
 * What Browse last showed, and how far down it was. Reading a chapter takes the library off the
 * screen, Browse with it, so coming back finds the same series where they were, not asked for again.
 */
let kept: { text: string; found: Extract<Found, { state: 'ready' }>; top: number } | null = null;

function messageOf(e: unknown): string {
  if (e instanceof Error) return e.message;
  return 'Breader couldn’t reach it.';
}

export function Browse({ hidden, have, prefs, onPrefs, onPick }: Props) {
  const labels = useLabels();
  const [text, setText] = useState(() => kept?.text ?? '');
  const [q, setQ] = useState(() => kept?.text.trim() ?? '');
  const [found, setFound] = useState<Found>(() => kept?.found ?? { state: 'loading' });
  /** Where to scroll back to, once Browse is on screen, and what it came back with. */
  const back = useRef(kept?.top ?? 0);
  const restored = useRef(kept?.found);
  const [tries, setTries] = useState(0);
  const end = useRef<HTMLDivElement>(null);
  const row = useRef<HTMLDivElement>(null);
  /** The line of dots, sliding sideways on a phone: whether there's more of it either way. */
  const [more, setMore] = useState({ l: false, r: false });
  const scroller = useRef<HTMLDivElement>(null);
  /** The search a next lot is being added to, if any. */
  const loadingMore = useRef<string | null>(null);
  /** The next lot, asked for as soon as the one before it came: the search it's for, and where it starts. */
  const ahead = useRef<{ ask: string; at: string; lot: Promise<Lot> } | null>(null);

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
  const fetchLot = async (next: string | null): Promise<Lot> => {
    const r = await mangadex.search({ q, lang: prefs.lang || undefined, sort, adult: prefs.adult, doujinshi: prefs.doujinshi, kinds: prefs.kinds, next: next ?? undefined });
    return { items: r.items, next: r.next };
  };

  /** The lot starting at `at`: the one already asked for ahead, or asked for now. */
  const lotAt = (ask: string, at: string): Promise<Lot> => {
    const a = ahead.current;
    if (a && a.ask === ask && a.at === at) return a.lot;
    const lot = fetchLot(at);
    ahead.current = { ask, at, lot };
    // One asked for ahead may fail before it's wanted, or get nowhere as every place was late. It's
    // forgotten, so it's asked for again then.
    const forget = () => {
      if (ahead.current && ahead.current.lot === lot) ahead.current = null;
    };
    void lot.then(
      (r) => {
        if (r.next === at) forget();
      },
      forget,
    );
    return lot;
  };

  useEffect(() => {
    // Back from a chapter, with what was showing: it stays.
    if (found === restored.current && found.ask === askKey && !tries) return;
    let live = true;
    back.current = 0;
    setFound({ state: 'loading' });
    scroller.current?.scrollTo({ top: 0 });
    fetchLot(null).then(
      (r) => { if (live) setFound({ state: 'ready', ask: askKey, ...r }); },
      (e) => { if (live) setFound({ state: 'error', message: messageOf(e) }); },
    );
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [askKey, tries]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || hidden || !back.current) return;
    el.scrollTop = back.current;
    back.current = 0;
  }, [hidden]);

  // The line fades out at an edge it goes on past, so it's plain that it slides.
  useEffect(() => {
    const el = row.current;
    if (!el || hidden) return;
    const look = () => {
      const l = el.scrollLeft > 2;
      const r = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
      setMore((m) => (m.l === l && m.r === r ? m : { l, r }));
    };
    look();
    const ro = new ResizeObserver(look);
    ro.observe(el);
    el.addEventListener('scroll', look, { passive: true });
    return () => { ro.disconnect(); el.removeEventListener('scroll', look); };
  }, [hidden]);

  useEffect(() => {
    if (found.state !== 'ready') return;
    kept = { text, found, top: kept?.found.ask === found.ask ? kept.top : 0 };
  }, [text, found]);

  // The next lot is asked for as soon as one comes, so it's mostly here before the end is.
  const ready = found.state === 'ready' ? found : null;
  useEffect(() => {
    if (!ready?.next || hidden) return;
    if (ready.ask !== askKey) return;
    void lotAt(ready.ask, ready.next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, hidden, askKey]);

  // Within a screen and a half of the end, the next lot shows. A short or empty one leaves the end
  // that near, so the one after it shows straight away too. Another search started meanwhile (a dot
  // flipped, say) may have got just as far, so a lot is added only to the search it's for.
  useEffect(() => {
    const el = end.current;
    if (!el || !ready?.next || hidden) return;
    if (ready.ask !== askKey) return;
    const ask = ready.ask;
    const at = ready.next;
    const io = new IntersectionObserver((entries) => {
      if (!entries[0].isIntersecting || loadingMore.current === ask) return;
      loadingMore.current = ask;
      lotAt(ask, at).then(
        async (r) => {
          // Every place was late, so the search is where it was. Asked again straight away, an
          // answer that comes at once (a kept copy, say) would be asked for thousands of times.
          if (r.next === at && r.items.length === 0) await wait(STILL_MS);
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
    }, { root: scroller.current, rootMargin: '150% 0px' });
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
                    <img src={c.cover.src} srcSet={c.cover.srcSet} sizes="(max-width: 720px) 32vw, 190px" alt="" loading="lazy" decoding="async" draggable={false} />
                  ) : (
                    <span className="mdx-nocover">{c.title}</span>
                  )}
                  {c.have && <span className="mdx-have" title={`In ${labels.mine}`}><IconCheck /></span>}
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
    <section aria-label="Browse" hidden={hidden} className="gallery mdx" ref={scroller} onScroll={(e) => { if (kept) kept.top = e.currentTarget.scrollTop; }}>
      <div className="mdx-bar">
        <label className="mdx-search">
          <IconSearch />
          <span className="sr-only">Search manga</span>
          <input type="search" value={text} placeholder="Search manga" enterKeyHint="search" onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') setQ(text.trim()); }} />
        </label>
        <div className={`mdx-row${more.l ? ' is-more-l' : ''}${more.r ? ' is-more-r' : ''}`} ref={row}>
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
    </section>
  );
}
