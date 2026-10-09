import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { animate } from 'motion';
import { AnimatePresence, MotionConfig, motion, useReducedMotion } from 'motion/react';
import { BulkBar, type BulkAction } from './components/BulkBar';
import { Header, type Tab } from './components/Header';
import { IconAddBook, IconLock, IconPeople, IconPlus, IconStar, IconTrash } from './components/icons';
import { PreviewBar, type AppTheme } from './components/PreviewBar';
import { Toast, type ToastMessage } from './components/Toast';
import { categoryOf, countOf, type Category } from './books/category';
import { coverOf, detectFormat, forget, loadRecord, parseSource, titleFromName } from './books/load';
import { recordFromBook } from './books/record';
import { sweepKept } from './books/kept';
import { placeChapter, remoteCover, remoteOf } from './books/remote';
import type { BookEdit, BookRecord, LoadedBook, Position, ReadState } from './books/types';
import { normColor } from './data/colors';
import { canRemove, canShare, mixedCovers, mixedRecords, placeholderRecords, PREVIEW_MODES, sampleRecords, seriesRecords, type PreviewMode } from './data/library';
import { useMangaPreview } from './data/mangaPreview';
import type { AccountResponse } from '@breader/shared/protocol';
import { namesOf, type MangaFound } from '@breader/shared/manga';
import { useLabels } from './data/labels';
import { addLibrary, keepShelfCover, libraryName, shelfCover, shelfRecord, showLibrary, useShared, type Showing } from './data/shelf';
import { flush, openWithKey } from './data/sync';
import { useLibrary, withReading, type RemovedBook, type ShelfItem } from './data/useLibrary';
import { AddBook } from './features/add/AddBook';
import { KeyDialog } from './features/add/KeyDialog';
import { SettingsMenu } from './features/account/SettingsMenu';
import { LoginDialog, type LoginStart } from './features/account/LoginDialog';
import { Gallery } from './features/gallery/Gallery';
import { RemoveDialog } from './features/gallery/RemoveDialog';
import { detectSeries, seriesNames } from './features/gallery/series';
import { fillGaps, genreFor } from './features/gallery/fill';
import { Reader } from './features/reader/Reader';
import { Browse } from './features/manga/Browse';
import { urlOf } from './features/manga/copies';
import { MangaSheet, type About, type Picked } from './features/manga/MangaSheet';
import { LibraryMenu } from './features/shared/LibraryMenu';
import { OwnLibraryMenu } from './features/shared/OwnLibraryMenu';
import { loginError, logOut, refreshAccount, useAccount, verifyEmail } from './lib/account';
import { api } from './lib/api';
import { newId, newLibraryKey } from './lib/key';
import { genreOf, mangadex, readMangaPrefs, sources, type MangaPrefs } from './lib/mangadex';
import { springs } from './lib/springs';
import { readLocal, writeLocal } from './lib/store';
import './app.css';

type Route = { name: 'library' } | { name: 'read'; id: string };

function parseHash(): Route {
  const m = window.location.hash.match(/^#\/read\/(.+)$/);
  return m ? { name: 'read', id: decodeURIComponent(m[1]) } : { name: 'library' };
}

/**
 * Development only: the preview bar, the ?preview= and ?theme= links it writes, and the placeholder
 * books. Production shows only real books.
 */
const devTools = import.meta.env.DEV;
/** Where the eye over manga's covers is kept, on this device. */
const COVERS_ONLY = 'breader.manga.coversOnly.v1';

function readParam<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const v = new URLSearchParams(window.location.search).get(name) as T | null;
  return v && allowed.includes(v) ? v : fallback;
}

function writeParam(name: string, value: string, fallback: string) {
  const url = new URL(window.location.href);
  if (value === fallback) url.searchParams.delete(name);
  else url.searchParams.set(name, value);
  window.history.replaceState(null, '', url);
}

const byRecent = (a: ShelfItem, b: ShelfItem) => b.lastOpened - a.lastOpened;

/** What stopping sharing some books at once says. */
function stoppedSharing(n: number, category: Category): string {
  let after = 'Anyone well into one keeps their copy.';
  if (n === 1) after = 'Anyone well into it keeps their copy.';
  return `Stopped sharing ${countOf(n, category)}. ${after}`;
}

/** Links that bring the reader back to the app: from Google, and from Breader's emails. */
const RETURN_PARAMS = ['login', 'error', 'verify', 'reset'];

const WELCOME: Record<AccountResponse['outcome'], string> = {
  adopted: 'Logged in. Your books are saved to your account.',
  created: 'Logged in. Books you add are saved to your account.',
  opened: 'Logged in. Here are your account’s books.',
  claimed: 'Logged in. This browser’s books are in your account now.',
  switched: 'Logged in. The other books stay under their own key.',
  same: 'Logged in.',
  choose: 'Logged in.',
};
const inset = (r: DOMRect) =>
  `inset(${r.top}px ${window.innerWidth - r.right}px ${window.innerHeight - r.bottom}px ${r.left}px round 20px)`;
const FULL = 'inset(0px 0px 0px 0px round 0px)';

/** Where a book's card is in the library, as it will settle (the library may still be rising in). */
function cardRect(id: string): DOMRect | null {
  const tile = document.querySelector<HTMLElement>(`.gallery:not([hidden]) .tile-hit[data-id="${CSS.escape(id)}"]`)?.parentElement;
  if (!tile) return null;
  const r = tile.getBoundingClientRect();
  const slot = tile.closest<HTMLElement>('.tile-slot');
  const t = slot ? getComputedStyle(slot).transform : 'none';
  const dy = t && t !== 'none' ? new DOMMatrixReadOnly(t).m42 : 0;
  const top = r.top - dy;
  if (r.width < 8 || top >= window.innerHeight || top + r.height <= 0) return null;
  return new DOMRect(r.left, top, r.width, r.height);
}

/** The reader goes back into its card: its text clears, then the page draws back into the card. */
async function closeReader(host: HTMLElement, id: string, reduced: boolean) {
  if (reduced) { await animate(host, { opacity: 0 }, { duration: 0.15 }); return; }
  const r = cardRect(id);
  if (!r) { await animate(host, { opacity: 0, scale: 0.98 }, { duration: 0.3 }); return; }
  const content = Array.from(host.querySelectorAll<HTMLElement>('.rd-body'));
  await Promise.all([
    animate(host, { opacity: [1, 1, 0] }, { duration: 0.62, times: [0, 0.72, 1] }),
    ...content.map((el) => animate(el, { opacity: 0 }, { duration: 0.16 })),
    animate(host, { clipPath: [FULL, inset(r)] }, springs.snappy),
  ]);
}

export default function App() {
  // Notices from sync (a file the server wouldn't take) use the toast below.
  const lib = useLibrary({ onNotice: (text) => say(text) });
  const sharing = useShared();
  const [now] = useState(() => Date.now());
  const [route, setRoute] = useState<Route>(parseHash);
  const [tab, setTab] = useState<Tab>('mine');
  /** Books or manga: the shelf both tabs show, as the reader last left it. */
  const [category, setCategory] = useState<Category>(() => (readLocal<string>('breader.category.v1', 'books') === 'manga' ? 'manga' : 'books'));
  useEffect(() => { writeLocal('breader.category.v1', category); }, [category]);
  /** The laptop has MangaDex (null until it says), and how this device looks through it. */
  const [mdOn, setMdOn] = useState<boolean | null>(null);
  const [mdPrefs, setMdPrefs] = useState<MangaPrefs>(readMangaPrefs);
  /** A series' sheet, open over the library: everywhere it was found, the first the one picked. */
  const [sheet, setSheet] = useState<MangaFound[] | null>(null);
  /** A chapter picked in a sheet: where its series opens, this once. */
  const [startAt, setStartAt] = useState<{ id: string; pos: Position } | null>(null);
  // Whether the Manga shelf has its Browse button: the laptop says. Out of reach, it stays and Browse says so.
  useEffect(() => {
    if (category !== 'manga' || mdOn !== null) return;
    let live = true;
    mangadex.state().then((st) => { if (live) setMdOn(st.on); }, () => { if (live) setMdOn(true); });
    return () => { live = false; };
  }, [category, mdOn]);
  if ((category !== 'manga' || mdOn === false) && tab === 'browse') setTab('mine');
  /**
   * Picking books to act on together: where (the shelf, the library and, for a shared one, which)
   * and the ones ticked. It's in the library as it shows, and ends when anything else shows.
   */
  const [picking, setPicking] = useState<{ place: string; ids: ReadonlySet<string> } | null>(null);
  let pickPlace = '';
  if (route.name === 'library' && tab === 'mine') pickPlace = `${category} mine`;
  if (route.name === 'library' && tab === 'shelf') pickPlace = `${category} shelf ${sharing.showing}`;
  if (picking && picking.place !== pickPlace) setPicking(null);
  // Each tab's library stays once it's been seen, so switching back finds it as it was.
  const [seen, setSeen] = useState<ReadonlySet<Tab>>(() => new Set([tab]));
  if (!seen.has(tab)) setSeen(new Set([...seen, tab]));
  const [preview, setPreview] = useState<PreviewMode>(() => (devTools ? readParam('preview', PREVIEW_MODES.map((m) => m.id), 'live') : 'live'));
  const [theme, setTheme] = useState<AppTheme>(() => (devTools ? readParam('theme', ['auto', 'light', 'dark'] as const, 'auto') : 'auto'));
  const labels = useLabels();
  /** Manga's covers without their titles: off until the reader turns it on, then kept on this device. */
  const [coversOnly, setCoversOnly] = useState(() => readLocal<unknown>(COVERS_ONLY, false) === true);
  const [adding, setAdding] = useState<{ file?: File | null; mode?: 'file' | 'paste' } | null>(null);
  const [keyOpen, setKeyOpen] = useState(false);
  const [freshKey, setFreshKey] = useState<string | null>(null);
  /** A book in both places being removed from one: asking whether it leaves the other too. */
  const [asking, setAsking] = useState<{ id: string; title: string; from: 'mine' | 'shelf'; category: Category; fromKeyboard: boolean; then?: () => void } | null>(null);
  /** Picked books being removed, some of them shared too: asking once about all of those. */
  const [askingAll, setAskingAll] = useState<{ ids: string[]; shared: string[]; title: string; category: Category; fromKeyboard: boolean } | null>(null);
  const [login, setLogin] = useState<LoginStart | null>(null);
  const account = useAccount();
  const [dragOver, setDragOver] = useState(false);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  /* Books removed this session, kept out of every view (previews show copies of stored books). */
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const [opening, setOpening] = useState<{ id: string; rect: DOMRect } | null>(null);
  const [closing, setClosing] = useState<{ id: string } | null>(null);
  const reduced = useReducedMotion() ?? false;
  const hostRef = useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = useState<{ id: string; book: LoadedBook } | null>(null);
  const openAnimDone = useRef(false);
  const loadedId = useRef<string | null>(null);
  const toastId = useRef(0);

  const say = useCallback((text: string, more?: Omit<ToastMessage, 'id' | 'text'>) => {
    setToast({ id: ++toastId.current, text, ...more });
  }, []);
  const dismissToast = useCallback((id: number) => setToast((t) => (t?.id === id ? null : t)), []);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'auto') delete root.dataset.theme;
    else root.dataset.theme = theme;
    writeParam('theme', theme, 'auto');
  }, [theme]);
  useEffect(() => { writeParam('preview', preview, 'live'); }, [preview]);

  // Back from Google, or from a link in one of Breader's emails.
  useEffect(() => {
    const url = new URL(window.location.href);
    const q = Object.fromEntries(RETURN_PARAMS.map((k) => [k, url.searchParams.get(k)]));
    if (!q.login && !q.verify && !q.reset) return;
    RETURN_PARAMS.forEach((k) => url.searchParams.delete(k));
    window.history.replaceState(null, '', url);
    if (q.reset) setLogin({ mode: 'reset', token: q.reset });
    else if (q.login === 'google') setLogin({ mode: 'entering' });
    else if (q.login === 'failed') say('Logging in with Google didn’t work. Try again, or use your email and a password.');
    else if (q.verify) {
      const token = q.verify;
      void (async () => {
        try {
          const before = await refreshAccount();
          const after = await verifyEmail(token);
          say('Your email is confirmed.');
          // The link logs in a browser that wasn't: that browser moves to the account's library too.
          if (before.status !== 'in' && after.status === 'in') setLogin({ mode: 'entering' });
        } catch (e) {
          say(loginError(e));
        }
      })();
    }
  }, [say]);

  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  /* Data for the current view */
  const previewSets = useMemo(
    () => (devTools
      ? { all: [...sampleRecords(now), ...placeholderRecords(now)], series: seriesRecords(now), mixed: mixedRecords(now), covers: mixedCovers() }
      : { all: [], series: [], mixed: [], covers: {} }),
    [now],
  );
  // Manga for the previews of several books, from MangaDex.
  const mangaPreview = useMangaPreview(devTools && (preview === 'few' || preview === 'many'), now);
  /*
   * Copies of shared books read too little of to keep (KEEP_WORDS) that no one shares any more.
   * The server says which, to a library on it.
   */
  const lapsed = lib.lapsed;

  /*
   * The shared libraries tab: the books the reader shares, or those of a library in their list, as
   * its owner has them. A book of theirs the reader has too, as their own or a copy, is `kept`.
   */
  const showing = sharing.showing;
  const others = showing === 'own' ? null : sharing.libs[showing];
  const sharedRecords = useMemo(
    () => (showing === 'own' ? lib.records.filter((r) => r.shared && !lapsed.has(r.id)) : (others?.books ?? []).map(shelfRecord)),
    [showing, others, lib.records, lapsed],
  );
  const keptFirsts = useMemo(
    () => new Set(lib.records.filter((r) => !hidden.has(r.id) && !lapsed.has(r.id) && !r.sharedOnly).map((r) => r.origin ?? r.id)),
    [lib.records, lapsed, hidden],
  );
  /** Series from a catalogue in the reader's own books, however they came in, by where they're read. */
  const keptSeries = useMemo(() => {
    const keys = new Set<string>();
    for (const r of lib.records) {
      if (r.source !== 'remote' || hidden.has(r.id) || r.sharedOnly) continue;
      const w = remoteOf(r.url);
      if (w) keys.add(w.key);
    }
    return keys;
  }, [lib.records, hidden]);

  const recordById = useMemo(() => {
    const m = new Map<string, BookRecord>();
    for (const r of [...previewSets.all, ...previewSets.mixed, ...mangaPreview.records, ...sharedRecords, ...lib.records]) m.set(r.id, r);
    // The series preview places some of the same books differently; it wins while it's showing.
    if (preview === 'series') for (const r of previewSets.series) m.set(r.id, r);
    return m;
  }, [previewSets, mangaPreview, sharedRecords, lib.records, preview]);

  const everything = useMemo(() => {
    const covers = { ...previewSets.covers, ...mangaPreview.covers, ...sharing.covers, ...lib.covers };
    const view = (recs: BookRecord[]) =>
      recs.filter((r) => !hidden.has(r.id)).map((r) => withReading(r, lib.reads, covers, lib.edits)).sort(byRecent);
    const liveMine = view(lib.records.filter((r) => !lapsed.has(r.id) && !r.sharedOnly));
    /** A book of theirs the reader has too: a copy of it, or the same series from a catalogue. */
    const isKept = (b: BookRecord) => {
      if (b.source !== 'shelf') return false;
      if (keptFirsts.has(b.origin ?? b.id)) return true;
      const w = remoteOf(b.url);
      if (!w) return false;
      return keptSeries.has(w.key);
    };
    // No one's reading shows in a shared library, the reader's own included, newest first. Copies
    // go by their first book, so a card stays put however many hands it passed through.
    const onShelf = sharedRecords
      .filter((r) => !hidden.has(r.id))
      .map((r) => withReading(r, {}, covers, showing === 'own' ? lib.edits : {}))
      .map((b) => ({ ...b, key: b.origin ?? b.id, ...(isKept(b) ? { kept: true } : {}) }))
      .sort((a, b) => b.addedAt - a.addedAt);
    let mine: ShelfItem[];
    switch (preview) {
      case 'empty': mine = []; break;
      case 'one': mine = liveMine.slice(0, 1).length ? liveMine.slice(0, 1) : view(previewSets.all).slice(0, 1); break;
      case 'few': mine = [...view(previewSets.all).slice(0, 6), ...view(mangaPreview.records).slice(0, 6)]; break;
      case 'many': mine = [...view(previewSets.all), ...view(mangaPreview.records)]; break;
      case 'series': mine = view(previewSets.series); break;
      case 'mixed': mine = view(previewSets.mixed); break;
      default: mine = liveMine;
    }
    // Blank series, numbers and genres filled in from the rest of both libraries, and one name a series.
    const filled = fillGaps([...mine, ...onShelf]);
    return { mine: filled.slice(0, mine.length), shelf: filled.slice(mine.length) };
  }, [lib.records, lib.reads, lib.covers, lib.edits, lapsed, sharing.covers, sharedRecords, keptFirsts, keptSeries, showing, previewSets, mangaPreview, preview, hidden]);
  // Each tab shows the chosen shelf's books; series and genres are offered from both.
  const items = useMemo(() => ({
    mine: everything.mine.filter((b) => categoryOf(b) === category),
    shelf: everything.shelf.filter((b) => categoryOf(b) === category),
  }), [everything, category]);
  const allSeries = useMemo(() => seriesNames([...everything.mine, ...everything.shelf]), [everything]);
  /** Series from MangaDex in this library, by their MangaDex id. */
  const remoteSeries = useMemo(() => {
    const m = new Map<string, BookRecord>();
    for (const r of lib.records) {
      const w = r.source === 'remote' && !hidden.has(r.id) ? remoteOf(r.url) : null;
      if (w) m.set(w.key, r);
    }
    return m;
  }, [lib.records, hidden]);
  const haveSeries = useMemo(() => new Set(remoteSeries.keys()), [remoteSeries]);
  // Chapters kept offline of series no longer in the library go, once the library's open.
  const swept = useRef(false);
  useEffect(() => {
    if (!lib.ready || swept.current) return;
    swept.current = true;
    void sweepKept(haveSeries);
  }, [lib.ready, haveSeries]);
  const guessGenre = useCallback((b: Parameters<typeof genreFor>[1]) => genreFor([...everything.mine, ...everything.shelf], b), [everything]);

  /* Opening a book: the reader grows out of the card, then takes over. */
  const finishOpen = useCallback((id: string) => {
    window.location.hash = `#/read/${encodeURIComponent(id)}`;
    setOpening(null);
  }, []);

  /**
   * A series in My manga: its sheet, from what the card knows until the rest comes. Its other
   * copies are looked for by its name.
   */
  const chaptersOf = useCallback((b: BookRecord) => {
    const w = remoteOf(b.url);
    const names = namesOf([b.title]);
    if (w?.kind === 'mangadex') {
      const card = { id: w.series, title: b.title, cover: null, rating: 'safe' as const, status: null, year: null, langs: [], original: '', kind: 'manga' as const, authors: b.author ? [b.author] : [], side: false };
      setSheet([{ kind: 'mangadex', source: 'MangaDex', card, ...names }]);
    } else if (w?.kind === 'source') {
      const card = { id: w.id, title: b.title, cover: `/v1/manga/source/${w.id}/cover`, status: null, adult: false, side: false, kind: null };
      setSheet([{ kind: 'source', source: '', card, ...names }]);
    }
  }, []);

  const startLoad = useCallback(async (id: string, given?: BookRecord, at?: Position) => {
    const rec = given ?? recordById.get(id);
    if (!rec) return null;
    try {
      // A series from a Suwayomi source opens a few chapters around its place.
      const book = await loadRecord(rec, at ?? lib.reads[id]?.pos);
      loadedId.current = id;
      setLoaded({ id, book });
      // Its own shelf is the one to go back to, opened from a link or not.
      setCategory(categoryOf(rec));
      // Books added before they had a cover get one the first time they open.
      if (!rec.hasCover && rec.source === 'file') {
        void coverOf(book).then((cover) => { if (cover) void lib.setCover(id, cover); });
      }
      return book;
    } catch (e) {
      console.error(e);
      let text = 'Couldn’t open this book.';
      if (e instanceof Error) text = e.message;
      // A manga's site may be down or gone: its sheet lists its other copies.
      if (rec.source === 'remote') say(text, { action: { label: 'Other copies', run: () => chaptersOf(rec) } });
      else say(text);
      return null;
    }
  }, [recordById, lib, say, chaptersOf]);

  const onOpen = useCallback(async (book: ShelfItem, rect: DOMRect) => {
    openAnimDone.current = false;
    loadedId.current = null;
    // A shared book this reader hasn't started joins their library as they open it.
    const entry = recordById.get(book.id);
    const rec = entry?.source === 'shelf' ? await lib.startShelfBook(entry) : entry;
    if (!rec) return;
    // One taken out of My books comes back in once it's being read again.
    if (rec.sharedOnly) lib.setSharedOnly(rec.id, false);
    setOpening({ id: rec.id, rect });
    void startLoad(rec.id, rec).then((b) => {
      if (!b) setOpening(null);
      else if (openAnimDone.current) finishOpen(rec.id);
    });
  }, [recordById, lib, startLoad, finishOpen]);

  /** Renaming, recolouring or favouring a shared book adds it to the reader's library first. */
  const editBook = useCallback(async (id: string, patch: BookEdit) => {
    const rec = recordById.get(id);
    lib.editBook(rec?.source === 'shelf' ? (await lib.startShelfBook(rec)).id : id, patch);
  }, [recordById, lib]);

  // A reader URL opened directly (or reloaded) loads without the transition.
  useEffect(() => {
    if (route.name === 'read' && loaded?.id !== route.id && !opening && lib.ready) void startLoad(route.id);
  }, [route, loaded, opening, lib.ready, startLoad]);

  const back = useCallback(() => {
    if (route.name === 'read' && loadedId.current === route.id) setClosing({ id: route.id });
    window.location.hash = '';
    setRoute({ name: 'library' });
    setStartAt(null);
  }, [route]);

  // A chapter not in the book as it's open (a series from a Suwayomi source opens a few at a
  // time): the book opens again, there.
  useEffect(() => {
    const onReopen = (e: Event) => {
      const pos = (e as CustomEvent<{ pos?: Position }>).detail?.pos;
      const rec = route.name === 'read' ? recordById.get(route.id) : undefined;
      if (!pos || !rec) return;
      forget(rec.id);
      setStartAt({ id: rec.id, pos });
      loadedId.current = null;
      setLoaded(null);
      void startLoad(rec.id, rec, pos);
    };
    window.addEventListener('breader:reopen', onReopen);
    return () => window.removeEventListener('breader:reopen', onReopen);
  }, [route, recordById, startLoad]);

  /** A series into My manga, read from the copy picked: its cover kept here, its genres from its tags. */
  const addNewSeries = useCallback(async (about: About, url: string): Promise<BookRecord> => {
    const now = Date.now();
    let cover: Blob | undefined = undefined;
    let author = '';
    let genre = '';
    if (about.kind === 'mangadex') {
      const s = about.series;
      if (s.cover) cover = await mangadex.cover(s.id, s.cover, 512);
      author = [...new Set([...s.authors, ...s.artists])].join(', ');
      genre = genreOf(s.tags);
    } else {
      const s = about.series;
      if (s.cover) cover = await sources.cover(s.cover);
      author = s.authors.join(', ');
      genre = genreOf(s.genres.map((name) => ({ name })));
    }
    const rec: BookRecord = {
      id: newId(),
      title: about.series.title.slice(0, 500),
      author: author.slice(0, 300),
      format: 'CBZ',
      source: 'remote',
      url,
      shared: false,
      addedAt: now,
      words: 0,
      color: lib.nextColor(),
      progress: 0,
      line: '',
      lastOpened: now,
      ...(genre ? { genre } : {}),
    };
    await lib.addRemote(rec, cover);
    setPreview('live');
    // As with a first book: a key gives it somewhere to sync, and its pages a library to go to.
    if (!lib.key) {
      const key = newLibraryKey();
      await lib.setKey(key);
      setFreshKey(key);
    }
    return rec;
  }, [lib]);

  /**
   * Series on their way into My manga, by the url they're read from. Its cover can take half a
   * minute, and a second tap meanwhile gets the same book, not another copy.
   */
  const addingSeries = useRef(new Map<string, Promise<BookRecord>>());
  const addSeries = useCallback((about: About, url: string): Promise<BookRecord> => {
    const going = addingSeries.current.get(url);
    if (going) return going;
    const adding = addNewSeries(about, url);
    addingSeries.current.set(url, adding);
    const done = () => { addingSeries.current.delete(url); };
    adding.then(done, done);
    return adding;
  }, [addNewSeries]);

  /** Read from a series' sheet: into My manga if it isn't, then open, at the chapter picked if one was. */
  const readSeries = useCallback(async (about: About, picked: Picked, had: BookRecord | undefined, from: Position | undefined, rect: DOMRect | undefined) => {
    const url = urlOf(picked.found, picked.group, picked.lang);
    let rec = had;
    // Read in another language than the one kept, it's read in that one from now on.
    if (rec && rec.url !== url) {
      lib.setRemoteUrl(rec.id, url);
      rec = { ...rec, url };
    }
    if (!rec) rec = await addSeries(about, url);
    const id = rec.id;
    setStartAt(from ? { id, pos: from } : null);
    setSheet(null);
    openAnimDone.current = false;
    loadedId.current = null;
    setOpening({ id, rect: rect ?? new DOMRect(window.innerWidth / 2 - 60, window.innerHeight / 2 - 85, 120, 170) });
    void startLoad(id, rec, from).then((b) => {
      if (!b) setOpening(null);
      else if (openAnimDone.current) finishOpen(id);
    });
  }, [lib, addSeries, startLoad, finishOpen]);

  const addSeriesOnly = useCallback(async (about: About, picked: Picked) => {
    const rec = await addSeries(about, urlOf(picked.found, picked.group, picked.lang));
    say(`Added “${rec.title}” to ${labels.mine}`);
  }, [addSeries, say, labels.mine]);

  /**
   * A series in My manga, read from another copy from now on (MangaSheet.tsx). Its place stays, as
   * places go by chapter number; what it kept offline goes the next time the app opens (sweepKept).
   */
  const moveSeries = useCallback((rec: BookRecord, picked: Picked, site: string) => {
    lib.setRemoteUrl(rec.id, urlOf(picked.found, picked.group, picked.lang));
    say(`“${rec.title}” is read from ${site} now.`);
  }, [lib, say]);

  const recordOf = useCallback((id: string) => remoteSeries.get(id), [remoteSeries]);

  /** The number of the chapter a series in My manga is at. */
  const placeOf = useCallback((rec: BookRecord) => placeChapter(lib.reads[rec.id]?.pos), [lib.reads]);

  // A series added on another device brings its cover here once, through the laptop.
  const coverAsked = useRef(new Set<string>());
  const { ready: libIsReady, records: libRecords, setCover } = lib;
  useEffect(() => {
    if (!libIsReady || category !== 'manga') return;
    for (const r of libRecords) {
      if (r.source !== 'remote' || r.hasCover || coverAsked.current.has(r.id)) continue;
      coverAsked.current.add(r.id);
      void remoteCover(r.url).then((blob) => {
        if (blob) void setCover(r.id, blob);
      });
    }
  }, [libIsReady, libRecords, category, setCover]);

  // Someone's shared series brings its cover through the laptop too, once, then from this browser.
  const shelfCoverAsked = useRef(new Set<string>());
  useEffect(() => {
    if (category !== 'manga') return;
    for (const r of sharedRecords) {
      if (r.source !== 'shelf' || !r.url) continue;
      if (sharing.covers[r.id] || shelfCoverAsked.current.has(r.id)) continue;
      shelfCoverAsked.current.add(r.id);
      void shelfCover(r.id)
        .then((kept) => kept ?? remoteCover(r.url))
        .then((blob) => {
          if (blob) void keepShelfCover(r.id, blob);
        });
    }
  }, [category, sharedRecords, sharing.covers]);

  // Closing waits two frames, so the library underneath has laid out the card to land on.
  useEffect(() => {
    if (!closing) return;
    let live = true;
    let raf = requestAnimationFrame(() => {
      raf = requestAnimationFrame(() => {
        const host = hostRef.current;
        void (host ? closeReader(host, closing.id, reduced) : Promise.resolve()).then(() => {
          if (!live) return;
          // Gone before its styles are undone, or it shows whole for a frame over the library.
          flushSync(() => setClosing(null));
          if (!host?.isConnected) return;
          host.removeAttribute('style');
          host.querySelectorAll<HTMLElement>('.rd-body').forEach((el) => { el.style.opacity = ''; });
        });
      });
    });
    return () => { live = false; cancelAnimationFrame(raf); };
  }, [closing, reduced]);

  const onSave = useCallback((read: ReadState) => {
    if (route.name !== 'read') return;
    const rec = recordById.get(route.id);
    if (rec?.source === 'placeholder') lib.saveRead(route.id, { ...(lib.reads[route.id] ?? { progress: rec.progress, line: rec.line }), lastOpened: read.lastOpened });
    else lib.saveRead(route.id, read);
  }, [route, recordById, lib]);

  /* Removing a book takes it out of every view at once, with a few seconds to undo. */
  const removeBook = useCallback(async (id: string, fromKeyboard = false) => {
    const rec = recordById.get(id);
    if (!rec) return;
    const title = lib.edits[id]?.title?.trim() || rec.title;
    forget(id);
    const removed = lib.records.some((r) => r.id === id) ? await lib.removeBook(id) : null;
    setHidden((h) => new Set(h).add(id));
    const undo = async () => {
      // Focus on the toast (or nowhere) would be lost with it, so it goes to the card that came back.
      const a = document.activeElement;
      const refocus = !a || a === document.body || !!a.closest('.toast-host');
      if (removed) await lib.restoreBook(removed);
      setHidden((h) => {
        const next = new Set(h);
        next.delete(id);
        return next;
      });
      if (refocus) {
        requestAnimationFrame(() => requestAnimationFrame(() => {
          document.querySelector<HTMLElement>(`.gallery:not([hidden]) .tile-hit[data-id="${CSS.escape(id)}"]`)?.focus();
        }));
      }
    };
    say(`Removed “${title}”`, { action: { label: 'Undo', run: () => void undo() }, focus: fromKeyboard });
  }, [recordById, lib, say]);

  /** Removes a book, first asking about the other place when it's in both the reader's books and their shared library. */
  const askRemove = useCallback((id: string, fromKeyboard = false, then?: () => void) => {
    const rec = lib.records.find((r) => r.id === id);
    const title = (rec && lib.edits[id]?.title?.trim()) || rec?.title || '';
    if (rec && canShare(rec) && rec.shared && !rec.sharedOnly) {
      setAsking({ id, title, from: tab === 'shelf' ? 'shelf' : 'mine', category: categoryOf(rec), fromKeyboard, then });
      return;
    }
    void removeBook(id, fromKeyboard).then(then);
  }, [lib, tab, removeBook]);

  const chooseRemove = useCallback((both: boolean) => {
    if (!asking) return;
    const { id, title, from, fromKeyboard, then } = asking;
    const yours = asking.category === 'manga' ? 'your manga' : 'your books';
    setAsking(null);
    if (both) void removeBook(id, fromKeyboard);
    else if (from === 'mine') {
      lib.setSharedOnly(id, true);
      say(`Took “${title}” out of ${yours}. It stays in your shared library.`, { action: { label: 'Undo', run: () => lib.setSharedOnly(id, false) }, focus: fromKeyboard });
    } else {
      lib.setShared(id, false);
      say(`Stopped sharing “${title}”. It stays in ${yours}.`, { action: { label: 'Undo', run: () => lib.setShared(id, true) }, focus: fromKeyboard });
    }
    then?.();
  }, [asking, lib, removeBook, say]);

  /**
   * Takes picked books out of the reader's own library at once, with one Undo for all of them.
   * Those in `stayShared` stay in their shared library; the rest go from everywhere.
   */
  const removeAll = useCallback(async (ids: string[], stayShared: string[], fromKeyboard: boolean) => {
    const removed: RemovedBook[] = [];
    const hiding: string[] = [];
    for (const id of ids) {
      if (stayShared.includes(id)) {
        lib.setSharedOnly(id, true);
        continue;
      }
      forget(id);
      hiding.push(id);
      // Books in the previews aren't stored: they're only hidden.
      const gone = lib.records.some((r) => r.id === id) ? await lib.removeBook(id) : null;
      if (gone) removed.push(gone);
    }
    setHidden((h) => new Set([...h, ...hiding]));
    setPicking(null);
    const undo = async () => {
      // Back in the opposite order, so each finds its old place among the others.
      for (const r of [...removed].reverse()) await lib.restoreBook(r);
      for (const id of stayShared) lib.setSharedOnly(id, false);
      setHidden((h) => {
        const next = new Set(h);
        for (const id of hiding) next.delete(id);
        return next;
      });
    };
    let text = `Removed ${countOf(ids.length, category)}`;
    if (stayShared.length === 1) text += '. One stays in your shared library.';
    if (stayShared.length > 1) text += `. ${stayShared.length} stay in your shared library.`;
    say(text, { action: { label: 'Undo', run: () => void undo() }, focus: fromKeyboard });
  }, [lib, category, say]);

  const chooseRemoveAll = useCallback((both: boolean) => {
    if (!askingAll) return;
    const { ids, shared, fromKeyboard } = askingAll;
    setAskingAll(null);
    let stayShared: string[] = [];
    if (!both) stayShared = shared;
    void removeAll(ids, stayShared, fromKeyboard);
  }, [askingAll, removeAll]);

  const removeOpen = useCallback(() => {
    if (route.name === 'read') askRemove(route.id, false, back);
  }, [route, askRemove, back]);

  /* Drop files anywhere on the library and they're added straight to the tab you're on. */
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const categoryRef = useRef(category);
  categoryRef.current = category;
  const showingRef = useRef(showing);
  showingRef.current = showing;
  const addFiles = useCallback(async (files: File[]) => {
    // Dropped on the reader's own shared library, they're shared; on someone else's, they're the reader's own.
    const shared = tabRef.current === 'shelf' && showingRef.current === 'own';
    let needKey = !lib.key;
    /** The shelves they went on: none on the one showing, and it switches to theirs. */
    const landed = new Set<Category>();
    for (const file of files) {
      const format = detectFormat(file);
      if (!format) { say(`Breader can’t open “${file.name}”`); continue; }
      try {
        const book = await parseSource(file, format, titleFromName(file.name));
        const rec = recordFromBook(book, format, shared, lib.nextColor());
        // What the Add a book dialog would have filled in, taken as it is.
        const found = detectSeries(book.title, file.name, book.kind !== 'pdf' ? book.series : undefined, allSeries);
        if (found) Object.assign(rec, { series: found.name, seriesIndex: found.index });
        const genre = guessGenre({ author: rec.author, series: found?.name, subjects: book.kind !== 'pdf' ? book.subjects : undefined });
        if (genre) rec.genre = genre;
        const cover = await coverOf(book);
        book.cleanup?.();
        await lib.addBook(rec, file, cover);
        setPreview('live');
        const on = categoryOf(rec);
        landed.add(on);
        say(`Added “${rec.title}”${on !== categoryRef.current ? ` to ${on === 'manga' ? 'Manga' : 'Books'}` : ''}`);
        // A key gives the book somewhere on the server to go: to sync, and to reach the Shared Library.
        if (needKey) {
          const key = newLibraryKey();
          await lib.setKey(key);
          setFreshKey(key);
          needKey = false;
        }
      } catch (e) {
        console.error(e);
        say(`Breader couldn’t read “${file.name}”`);
      }
    }
    if (landed.size && !landed.has(categoryRef.current)) setCategory([...landed][0]);
  }, [lib, say, allSeries, guessGenre]);

  useEffect(() => {
    if (route.name !== 'library') return;
    let depth = 0;
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
    const enter = (e: DragEvent) => { if (!hasFiles(e) || adding) return; e.preventDefault(); depth++; setDragOver(true); };
    const over = (e: DragEvent) => { if (hasFiles(e) && !adding) e.preventDefault(); };
    const leave = () => { depth = Math.max(0, depth - 1); if (!depth) setDragOver(false); };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e) || adding) return;
      e.preventDefault();
      depth = 0;
      setDragOver(false);
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length) void addFiles(files);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
  }, [route.name, adding, addFiles]);

  const onAdded = useCallback(async (rec: BookRecord, data: Blob | string, cover?: Blob, opts?: { ai: boolean }) => {
    await lib.addBook(rec, data, cover);
    if (opts?.ai) lib.editBook(rec.id, { ai: true });
    setPreview('live');
    setTab('mine');
    const on = categoryOf(rec);
    setCategory(on);
    say(`Added “${rec.title}” to ${labels.mine}${rec.shared ? ', shared with your key' : ''}`);
  }, [lib, say, labels.mine]);

  /* The Key dialog's usual answer to someone's key: a shared library of its own, beside My books. */
  const openShared = useCallback(async (key: string) => {
    const r = await addLibrary(key);
    setPreview('live');
    setTab('shelf');
    say(r.own ? 'That’s your own key: these are the books you share with it.' : `Added ${r.label} to your shared libraries`);
  }, [say]);

  /* The Key dialog's "It's my own key": this browser switches to the library behind that key. */
  const openKey = useCallback(async (key: string) => {
    await openWithKey(key);
    setPreview('live');
    setTab('mine');
    say('Opened the library for that key');
  }, [say]);

  /*
   * Logged in, with no library in this browser: a phone's home-screen app, which starts with the
   * login Safari had and none of its storage, or a browser that cleared its storage. It opens the
   * account's library quietly, as logging in would have; offline, it tries again next time.
   */
  const rejoined = useRef(false);
  const { ready: libReady, key: libKey, joinAccount } = lib;
  useEffect(() => {
    if (rejoined.current || account.status !== 'in' || !libReady || libKey || login) return;
    rejoined.current = true;
    void joinAccount().then((res) => { if (res.outcome === 'choose') setLogin({ mode: 'entering' }); }, () => {});
  }, [account.status, libReady, libKey, joinAccount, login]);

  const loggedIn = account.status === 'in';
  const onLoggedIn = useCallback((res: AccountResponse) => {
    setLogin(null);
    setPreview('live');
    setTab('mine');
    say(WELCOME[res.outcome]);
  }, [say]);

  /** Logs out and clears this browser: the books stay in the account, not here. */
  const logOutAll = useCallback(async () => {
    await flush();
    await logOut();
    await api.del('/v1/session').catch(() => {});
    await lib.reset();
  }, [lib]);

  /** From a new key's dialog: log in instead. */
  const loginInstead = useCallback(() => {
    setFreshKey(null);
    setAdding(null);
    setKeyOpen(false);
    setLogin({ mode: 'login' });
  }, []);

  const reading = route.name === 'read' && loaded?.id === route.id ? loaded : null;
  // A reader on its way back into its card stays on screen until it gets there.
  const leaving = !reading && closing && loaded?.id === closing.id ? loaded : null;
  const shown = reading ?? leaving;
  const shownRec = shown ? recordById.get(shown.id) : undefined;
  const books = tab === 'shelf' ? items.shelf : items.mine;
  const ownShared = useMemo(() => lib.records.filter((r) => r.shared && !lapsed.has(r.id) && !hidden.has(r.id)).length, [lib.records, lapsed, hidden]);
  /** Someone's book, put in the reader's own library from their shared one without opening it. */
  const keep = useCallback(async (b: ShelfItem) => {
    const entry = recordById.get(b.id);
    if (entry?.source !== 'shelf') return;
    await lib.startShelfBook(entry);
    say(`Added “${b.title}” to ${labels.mine}`);
  }, [recordById, lib, say, labels.mine]);
  /**
   * Books from someone's shared library, put in the reader's own at once, last book first so the
   * first is the newest in Recent. Returns the ones it added.
   */
  const keepBooks = useCallback(async (books: ShelfItem[]) => {
    const had = new Set(lib.records.map((r) => r.id));
    const added: string[] = [];
    for (const b of [...books].reverse()) {
      const entry = recordById.get(b.id);
      if (entry?.source !== 'shelf' || b.kept) continue;
      const rec = await lib.startShelfBook(entry);
      if (!had.has(rec.id)) added.push(rec.id);
    }
    return added;
  }, [recordById, lib]);
  /** A series from someone's shared library, put in the reader's own books. Undo takes out the ones it added. */
  const keepAll = useCallback(async (books: ShelfItem[], series: string) => {
    const added = await keepBooks(books);
    if (!added.length) return;
    const on = categoryOf(books[0]);
    say(`Added ${countOf(added.length, on)} of “${series}” to ${labels.mine}`, {
      action: { label: 'Undo', run: () => { for (const id of added) void lib.removeBook(id); } },
    });
  }, [keepBooks, lib, say, labels.mine]);
  const manga = category === 'manga';

  /* Picking books in the library showing, to act on them together. */
  const pickedBooks = useMemo(() => {
    if (!picking) return [];
    return books.filter((b) => picking.ids.has(b.id));
  }, [picking, books]);
  const yours = labels.mine;
  const allFavourites = pickedBooks.length > 0 && pickedBooks.every((b) => b.favorite);
  /** Ticks these books, or takes the tick off when they all have one already (a series' card). */
  const pick = useCallback((books: ShelfItem[]) => {
    setPicking((p) => {
      if (!p) return p;
      const ids = new Set(p.ids);
      const all = books.every((b) => ids.has(b.id));
      for (const b of books) {
        if (all) ids.delete(b.id);
        else ids.add(b.id);
      }
      return { ...p, ids };
    });
  }, []);
  /** Favourites the picked books, or unfavourites them when they all are already. They stay picked. */
  const favouritePicked = () => {
    for (const b of pickedBooks) void editBook(b.id, { favorite: !allFavourites });
  };
  /** Removes the picked books, asking once first about any the reader shares too. */
  const removePicked = (fromKeyboard: boolean) => {
    const ids: string[] = [];
    const shared: ShelfItem[] = [];
    for (const b of pickedBooks) {
      const rec = recordById.get(b.id);
      if (!rec || !canRemove(rec)) continue;
      ids.push(b.id);
      if (canShare(rec) && rec.shared && !rec.sharedOnly) shared.push(b);
    }
    if (!ids.length) return;
    if (shared.length) {
      setAskingAll({ ids, shared: shared.map((b) => b.id), title: shared[0].title, category, fromKeyboard });
      return;
    }
    void removeAll(ids, [], fromKeyboard);
  };
  /** The picked books that can be shared and aren't yet: shares them with the reader's key. They stay picked. */
  const toShare = pickedBooks.filter((b) => canShare(b) && !b.shared);
  const sharePicked = () => {
    for (const b of toShare) lib.setShared(b.id, true);
    say(`Shared ${countOf(toShare.length, category)} with your key`);
  };
  /** The picked books shared already: stops sharing them. They stay picked. */
  const toStop = pickedBooks.filter((b) => canShare(b) && b.shared);
  const stopSharingPicked = () => {
    for (const b of toStop) lib.setShared(b.id, false);
    say(stoppedSharing(toStop.length, category));
  };
  /** In the reader's own shared library: the picked books taken out of their own books, put back in. */
  const outOfMine = pickedBooks.filter((b) => b.sharedOnly);
  const addBackPicked = (fromKeyboard: boolean) => {
    const ids = outOfMine.map((b) => b.id);
    for (const id of ids) lib.setSharedOnly(id, false);
    setPicking(null);
    say(`Added ${countOf(ids.length, category)} to ${yours}`, {
      action: { label: 'Undo', run: () => { for (const id of ids) lib.setSharedOnly(id, true); } },
      focus: fromKeyboard,
    });
  };
  /**
   * In the reader's own shared library: stops sharing the picked books, with one Undo for all.
   * Those out of their own books already would be nowhere, so they go.
   */
  const unsharePicked = async (fromKeyboard: boolean) => {
    const stopped: string[] = [];
    const removed: RemovedBook[] = [];
    const hiding: string[] = [];
    for (const b of pickedBooks) {
      if (!b.sharedOnly) {
        lib.setShared(b.id, false);
        stopped.push(b.id);
        continue;
      }
      forget(b.id);
      hiding.push(b.id);
      const gone = await lib.removeBook(b.id);
      if (gone) removed.push(gone);
    }
    setHidden((h) => new Set([...h, ...hiding]));
    setPicking(null);
    const undo = async () => {
      for (const r of [...removed].reverse()) await lib.restoreBook(r);
      for (const id of stopped) lib.setShared(id, true);
      setHidden((h) => {
        const next = new Set(h);
        for (const id of hiding) next.delete(id);
        return next;
      });
    };
    say(stoppedSharing(pickedBooks.length, category), {
      action: { label: 'Undo', run: () => void undo() },
      focus: fromKeyboard,
    });
  };
  /** In someone else's shared library: the picked books the reader doesn't have yet, into their own. */
  const notKept = pickedBooks.filter((b) => !b.kept);
  const keepPicked = async (fromKeyboard: boolean) => {
    const added = await keepBooks(notKept);
    setPicking(null);
    if (!added.length) return;
    say(`Added ${countOf(added.length, category)} to ${yours}`, {
      action: { label: 'Undo', run: () => { for (const id of added) void lib.removeBook(id); } },
      focus: fromKeyboard,
    });
  };

  /** What can be done with the picked books, by the library they're in. */
  let actions: BulkAction[] = [];
  if (tab === 'mine') {
    actions = [
      { key: 'favourite', label: allFavourites ? 'Unfavourite' : 'Favourite', icon: <IconStar />, run: favouritePicked },
      { key: 'share', label: 'Share', icon: <IconPeople />, disabled: !toShare.length, run: sharePicked },
      { key: 'unshare', label: 'Unshare', icon: <IconLock />, disabled: !toStop.length, run: stopSharingPicked },
      { key: 'remove', label: 'Remove', icon: <IconTrash />, danger: true, run: removePicked },
    ];
  } else if (showing === 'own') {
    actions = [
      { key: 'add', label: 'Add', icon: <IconAddBook />, disabled: !outOfMine.length, run: addBackPicked },
      { key: 'unshare', label: 'Unshare', icon: <IconLock />, run: (k) => void unsharePicked(k) },
    ];
  } else {
    actions = [
      { key: 'add', label: 'Add', icon: <IconAddBook />, disabled: !notKept.length, run: (k) => void keepPicked(k) },
    ];
  }
  /** Every book in the library showing is picked. */
  const allPicked = pickedBooks.length > 0 && pickedBooks.length === books.length;
  /** Picks every book in the library showing, or none when they all are already. */
  const pickAll = () => {
    let ids = new Set<string>();
    if (!allPicked) ids = new Set(books.map((b) => b.id));
    setPicking((p) => {
      if (!p) return p;
      return { ...p, ids };
    });
  };
  let bulkBar: ReactNode = null;
  if (picking) {
    bulkBar = <BulkBar count={pickedBooks.length} all={allPicked} onAll={pickAll} actions={actions} onDone={() => setPicking(null)} />;
  }
  /** Select, where the library showing has books to pick. */
  let startPicking: (() => void) | undefined = undefined;
  if (tab !== 'browse' && books.length > 0) startPicking = () => setPicking({ place: pickPlace, ids: new Set() });

  const flipCovers = () => {
    const next = !coversOnly;
    setCoversOnly(next);
    writeLocal(COVERS_ONLY, next);
  };
  /** Manga is found in Browse, which this opens, where the laptop has anywhere to look. */
  const browseButton = mdOn !== false && (
    <button type="button" className="btn btn-primary" onClick={() => setTab('browse')}><IconPlus /> Browse</button>
  );
  /** An empty shared library: the reader's own says how to share; someone else's, why it's empty. */
  const emptyShelf = showing === 'own' ? (
    <div className="gallery-empty">
      <p>You don’t share any {manga ? 'manga' : 'books'} yet. Switch on <b>Share with your key</b> in {manga ? 'a manga’s' : 'a book’s'} ⋯ menu, or as you add one, and anyone you give your key to can read it here.</p>
      {manga ? browseButton : <button type="button" className="btn btn-primary" onClick={() => setAdding({ mode: 'file' })}><IconPlus /> Add a book</button>}
    </div>
  ) : others?.state === 'closed' ? (
    <div className="gallery-empty">
      <p>This key doesn’t open {libraryName(sharing, showing)} any more. Its owner may have a new key to give you.</p>
    </div>
  ) : (
    <div className="gallery-empty"><p>{others?.state === 'ready' ? `Nothing is shared in ${libraryName(sharing, showing)} yet.` : 'Opening…'}</p></div>
  );
  /** No manga yet: what goes here, and how. */
  const emptyManga = (
    <div className="gallery-empty">
      <p>Manga and comics go here. Find a series in <b>Browse</b> and add it to {labels.mine}.</p>
      {browseButton}
    </div>
  );

  return (
    <MotionConfig reducedMotion="user">
      {route.name === 'library' && (
        <div className="lib">
          <Header
            category={category}
            onCategory={setCategory}
            tab={tab}
            counts={{ mine: items.mine.length, shelf: items.shelf.length }}
            browse={mdOn !== false}
            shelfName={libraryName(sharing, showing)}
            labels={labels}
            onTab={setTab}
            onAdd={() => setAdding({ mode: 'file' })}
            onBrowse={() => setTab('browse')}
            libraries={(close) => (
              <LibraryMenu
                key="libraries"
                sharing={sharing}
                ownCount={ownShared}
                onShow={(which: Showing) => { showLibrary(which); setTab('shelf'); }}
                onClose={close}
                say={say}
              />
            )}
            ownMenu={() => <OwnLibraryMenu key="own" name={labels.mine} count={items.mine.length} category={category} />}
            settings={(
              <SettingsMenu
                account={account}
                onLogin={() => setLogin({ mode: 'login' })}
                onLogOut={logOutAll}
                onKey={() => setKeyOpen(true)}
                // Only over manga's covers, where there are some to show.
                coversOnly={manga && tab !== 'browse' && books.length > 0 ? coversOnly : undefined}
                onCoversOnly={flipCovers}
              />
            )}
            onSelect={startPicking}
            bulk={bulkBar}
          />
          {lib.ready && (['mine', 'shelf'] as const).filter((t) => seen.has(t)).map((t) => (
            <Gallery
              key={`${category}-${t}-${preview}${t === 'shelf' ? `-${showing}` : ''}`}
              books={t === 'mine' ? items.mine : items.shelf}
              seriesNames={allSeries}
              place={t}
              // Shared libraries are browsed by genre; one's own books, by series.
              view={t === 'shelf' ? 'genre' : 'series'}
              manga={manga}
              coversOnly={coversOnly}
              now={now}
              id={`library-${t}`}
              labelledBy={`tab-${t}`}
              hidden={t !== tab}
              onOpen={(b, rect) => void onOpen(b, rect)}
              onAdd={() => setAdding({ mode: 'file' })}
              onEdit={(id, patch) => void editBook(id, patch)}
              // Reading shows only in My books.
              onFinish={t === 'mine' ? (b, finished) => lib.setFinished(b.id, finished, b) : undefined}
              onKeep={t === 'shelf' && showing !== 'own' ? (b) => void keep(b) : undefined}
              onKeepAll={t === 'shelf' && showing !== 'own' ? (books, series) => void keepAll(books, series) : undefined}
              onChapters={chaptersOf}
              empty={t === 'shelf' ? emptyShelf : manga ? emptyManga : undefined}
              onRemove={(b, fromKeyboard) => askRemove(b.id, fromKeyboard)}
              onShare={(b, shared) => {
                // Out of their books already: not shared either, it's nowhere, so it goes.
                if (!shared && b.sharedOnly) { void removeBook(b.id); return; }
                lib.setShared(b.id, shared);
                say(shared ? `“${b.title}” is shared with your key` : `Stopped sharing “${b.title}”. Anyone well into it keeps their copy.`);
              }}
              picked={picking && t === tab ? picking.ids : undefined}
              onPick={pick}
            />
          ))}
          {lib.ready && mdOn !== false && seen.has('browse') && (
            <Browse
              hidden={!manga || tab !== 'browse'}
              have={haveSeries}
              prefs={mdPrefs}
              onPrefs={setMdPrefs}
              onPick={setSheet}
            />
          )}
        </div>
      )}

      {shown && shownRec && (
        <div className={`rd-host${leaving ? ' is-leaving' : ''}`} ref={hostRef}>
          <Reader
            key={shown.id}
            record={shownRec}
            title={lib.edits[shown.id]?.title}
            color={normColor(lib.edits[shown.id]?.color ?? shownRec.color, shownRec.title)}
            book={shown.book}
            // A chapter picked in its sheet: there, whatever place was kept.
            initial={startAt?.id === shown.id ? { ...(lib.reads[shown.id] ?? { progress: 0, line: '', lastOpened: now }), pos: startAt.pos } : lib.reads[shown.id]}
            closing={!!leaving}
            onBack={back}
            onSave={onSave}
            onReadTime={(seconds) => lib.addReadTime(shown.id, seconds)}
            onRemove={canRemove(shownRec) ? removeOpen : undefined}
            ai={!!lib.edits[shown.id]?.ai}
            onAi={(on) => on && void editBook(shown.id, { ai: true })}
            // A series opened a few chapters at a time, with the next few added as it's read on.
            onBook={(grown) => setLoaded((l) => (l && l.id === shown.id ? { id: l.id, book: grown } : l))}
          />
        </div>
      )}
      {route.name === 'read' && !reading && !opening && (
        <div className="loading"><span className="add-spinner" /> Opening…</div>
      )}

      <AnimatePresence>
        {opening && (
          <motion.div
            key="opening"
            className={`opening t-${readLocal<{ theme?: string }>('breader.reader.v1', {}).theme ?? 'auto'}`}
            initial={{ clipPath: inset(opening.rect) }}
            animate={{ clipPath: FULL }}
            exit={{ opacity: 0, transition: { duration: 0.16 } }}
            transition={springs.snappy}
            onAnimationComplete={() => {
              openAnimDone.current = true;
              if (loadedId.current === opening.id) finishOpen(opening.id);
            }}
          >
            {loaded?.id !== opening.id && <span className="opening-note"><span className="add-spinner" /> Opening…</span>}
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {dragOver && (
          <motion.div key="drop" className="drop-over" aria-hidden="true" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }} />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {adding && (
          <AddBook
            key="add"
            initialFile={adding.file}
            initialMode={adding.mode}
            manga={manga}
            hasKey={!!lib.key}
            nextColor={lib.nextColor}
            defaultShared={tab === 'shelf' && showing === 'own'}
            knownSeries={allSeries}
            genreFor={guessGenre}
            onClose={() => setAdding(null)}
            onAdded={onAdded}
            onKey={lib.setKey}
            onLogin={loggedIn ? undefined : loginInstead}
          />
        )}
        {asking && <RemoveDialog key="remove" title={asking.title} from={asking.from} manga={asking.category === 'manga'} onChoose={chooseRemove} onClose={() => setAsking(null)} />}
        {askingAll && (
          <RemoveDialog
            key="remove-all"
            title={askingAll.title}
            count={askingAll.shared.length}
            from="mine"
            manga={askingAll.category === 'manga'}
            onChoose={chooseRemoveAll}
            onClose={() => setAskingAll(null)}
          />
        )}
        {keyOpen && <KeyDialog key="key" libraryKey={lib.key} loggedIn={loggedIn} onClose={() => setKeyOpen(false)} onShared={openShared} onOpen={openKey} />}
        {/* A key made as a series was read waits for the library. */}
        {freshKey && route.name === 'library' && <KeyDialog key="fresh-key" libraryKey={freshKey} fresh onLogin={loggedIn ? undefined : loginInstead} onClose={() => setFreshKey(null)} />}
        {sheet && route.name === 'library' && (
          <MangaSheet
            key={`sheet-${sheet[0].card.id}`}
            found={sheet}
            prefs={mdPrefs}
            recordOf={recordOf}
            placeOf={placeOf}
            onRead={(about, picked, had, from, rect) => readSeries(about, picked, had, from, rect)}
            onAdd={(about, picked) => addSeriesOnly(about, picked)}
            onMove={moveSeries}
            onClose={() => setSheet(null)}
          />
        )}
        {login && (
          <LoginDialog
            key="login"
            start={login}
            google={account.google}
            ready={lib.ready}
            localKey={lib.key}
            enter={lib.joinAccount}
            onDone={onLoggedIn}
            onClose={() => setLogin(null)}
          />
        )}
      </AnimatePresence>

      <Toast toast={toast} onDone={dismissToast} />
      {devTools && route.name === 'library' && (
        <PreviewBar
          mode={preview}
          onMode={setPreview}
          theme={theme}
          onTheme={setTheme}
          onReset={() => void lib.reset()}
        />
      )}
    </MotionConfig>
  );
}
