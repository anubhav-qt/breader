import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { animate } from 'motion';
import { AnimatePresence, MotionConfig, motion, useReducedMotion } from 'motion/react';
import { BulkBar, type BulkAction } from './components/BulkBar';
import { Header, type Tab } from './components/Header';
import { IconAddBook, IconLock, IconPeople, IconStar, IconTrash } from './components/icons';
import { Hint, type HintSpec } from './features/guide/Hint';
import type { Go } from './features/guide/list';
import { markSeen, useGuideKept, useNews } from './features/guide/seen';
import { checkDevice } from './features/reader/able';
import { WelcomeBooks, WelcomeManga, WelcomeShared } from './features/guide/Welcome';
import type { DemoId } from './features/guide/Demo';
import type { Note } from './features/news/notes';
import { firstOnServer, markShown, unseen } from './features/news/seen';
import { anyWorking, askReplies, doneNote, WORKING, WORKING_MS } from './features/feedback/replies';
import type { FeedbackReply } from '@breader/shared/feedback';
import { PreviewBar, type AppTheme } from './components/PreviewBar';
import { Toast, type ToastMessage } from './components/Toast';
import { AudiobookHost, AudiobookNav } from './features/audiobook/Audiobook';
import { AddWhat } from './features/add/AddWhat';
import { CATEGORIES, categoryOf, countOf, type Category } from './books/category';
import { coverOf, detectFormat, forget, loadRecord, parseSource, titleFromName } from './books/load';
import { recordFromBook } from './books/record';
import { placeChapter, remoteCover, remoteOf, withAlso } from './books/remote';
import type { BookEdit, BookRecord, LoadedBook, Position, ReadState } from './books/types';
import { normColor } from './data/colors';
import { canRemove, canShare, mixedCovers, mixedRecords, placeholderRecords, PREVIEW_MODES, sampleRecords, seriesRecords, type PreviewMode } from './data/library';
import { useMangaPreview } from './data/mangaPreview';
import type { AccountResponse, FeedLibrary } from '@breader/shared/protocol';
import { namesOf, type MangaFound } from '@breader/shared/manga';
import { useLabels } from './data/labels';
import { addLibrary, changeToken, isSaved, isYours, libraryName, refreshFeed, refreshLibrary, removeFromLibrary, renameLibrary, saveLibrary, sharedNow, shelfRecord, showLibrary, unsaveLibrary, useShared, yoursAs, type Showing } from './data/shelf';
import { feedName } from './features/shared/facts';
import { LibraryHead } from './features/shared/LibraryHead';
import { flush, openWithKey } from './data/sync';
import { useLibrary, withReading, type RemovedBook, type ShelfItem } from './data/useLibrary';
import type { Where } from './features/add/AddWhere';
import type { Shown } from './features/add/AddTo';
import { holds, mineOf, targetsOf, type Hands } from './features/add/places';
import { addOwnBook, addShelfBook } from './data/sharedAdds';
import { SettingsMenu } from './features/account/SettingsMenu';
import type { LoginStart } from './features/account/LoginDialog';
import { Gallery } from './features/gallery/Gallery';
import { detectSeries, seriesKey, seriesNames } from './features/gallery/series';
import { fillGaps, genreFor } from './features/gallery/fill';
import { urlOf } from './features/manga/copies';
import type { About, Picked } from './features/manga/MangaPage';
import { loginError, logOut, refreshAccount, useAccount, verifyEmail } from './lib/account';
import { api, ApiError } from './lib/api';
import { newId, newLibraryKey } from './lib/key';
import { genreOf, mangadex, readMangaPrefs, sources, type MangaPrefs } from './lib/mangadex';
import { springs } from './lib/springs';
import { readLocal, writeLocal } from './lib/store';
import './app.css';
import { Loader } from './components/Loader';
import { OpeningBack } from './components/OpeningBack';

/** The library; a book open (#/read/<id>); or a series' page (#/manga/<id>, by the id of the place it was picked in). */
type Route = { name: 'library' } | { name: 'read'; id: string } | { name: 'series'; id: string };

function parseHash(): Route {
  const read = window.location.hash.match(/^#\/read\/(.+)$/);
  if (read) return { name: 'read', id: decodeURIComponent(read[1]) };
  const series = window.location.hash.match(/^#\/manga\/(.+)$/);
  if (series) return { name: 'series', id: decodeURIComponent(series[1]) };
  return { name: 'library' };
}

function sameRoute(a: Route, b: Route): boolean {
  if (a.name === 'library' || b.name === 'library') return a.name === b.name;
  return a.name === b.name && a.id === b.id;
}

function hashOf(route: Route): string {
  if (route.name === 'read') return `#/read/${encodeURIComponent(route.id)}`;
  if (route.name === 'series') return `#/manga/${encodeURIComponent(route.id)}`;
  return window.location.pathname + window.location.search;
}

/** A series' page: everywhere the series was found, the first the one picked, and what its Back says. */
/** al: its AniList id, when picked from AniList. fromSeries: opened from another series' page, which Back goes back to. */
type SeriesAt = { found: MangaFound[]; from: string; al?: number; fromSeries?: boolean };

/**
 * What the app keeps with a place in the browser's history, so Back and Forward, and a reload, find
 * it as it was. inApp: it was gone to from another of the app's places, so the app's own Back steps
 * back there. series: the series' page it is, or that a chapter open was read from, over the library.
 */
interface Kept { inApp?: boolean; series?: SeriesAt }

function keptNow(): Kept {
  const s: unknown = window.history.state;
  if (!s || typeof s !== 'object') return {};
  return s as Kept;
}

/** The series' page the place in the history has, where it has one. */
function seriesNow(route: Route): SeriesAt | null {
  if (route.name === 'library') return null;
  return keptNow().series ?? null;
}

const seriesId = (s: SeriesAt) => s.found[0].card.id;

/** A series in My manga, as found where it's read from: what its card knows, until its page has the rest. */
/** A series as one of the reader's books, read from this url; its cover comes apart. */
function seriesRecord(about: About, url: string, color: string): BookRecord {
  const now = Date.now();
  let author = '';
  let genre = '';
  if (about.kind === 'mangadex') {
    const s = about.series;
    author = [...new Set([...s.authors, ...s.artists])].join(', ');
    genre = genreOf(s.tags);
  } else {
    const s = about.series;
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
    color,
    progress: 0,
    line: '',
    lastOpened: now,
  };
  if (genre) rec.genre = genre;
  return rec;
}

function foundOf(b: BookRecord): MangaFound[] | null {
  const w = remoteOf(b.url);
  const names = namesOf([b.title], b.author ? b.author.split(',') : []);
  if (w?.kind === 'mangadex') {
    const card = { id: w.series, title: b.title, cover: null, rating: 'safe' as const, status: null, year: null, langs: [], original: '', kind: 'manga' as const, authors: b.author ? [b.author] : [], side: false };
    return [{ kind: 'mangadex', source: 'MangaDex', card, ...names }];
  }
  if (w?.kind === 'source') {
    const card = { id: w.id, title: b.title, cover: `/v1/manga/source/${w.id}/cover`, status: null, adult: false, side: false, kind: null };
    return [{ kind: 'source', source: '', card, ...names }];
  }
  return null;
}

/**
 * Development only: the preview bar, the ?preview= and ?theme= links it writes, and the placeholder
 * books. Production shows only real books.
 */
const devTools = import.meta.env.DEV;
/** Where Only covers is kept, on this device (named for manga, where it began). */
const COVERS_ONLY = 'breader.manga.coversOnly.v1';
/** Light or dark, once the sun-or-moon button has picked one, on this device (read early by index.html too). */
const THEME = 'breader.theme.v1';
const DARK = '(prefers-color-scheme: dark)';

/** The device is dark, kept up as it changes. */
function useDeviceDark(): boolean {
  return useSyncExternalStore(
    (change) => {
      const m = window.matchMedia(DARK);
      m.addEventListener('change', change);
      return () => m.removeEventListener('change', change);
    },
    () => window.matchMedia(DARK).matches,
  );
}

function readTheme(): AppTheme {
  const v = readLocal<unknown>(THEME, 'auto');
  return v === 'light' || v === 'dark' ? v : 'auto';
}

function readParam<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const v = new URLSearchParams(window.location.search).get(name) as T | null;
  return v && allowed.includes(v) ? v : fallback;
}

function writeParam(name: string, value: string, fallback: string) {
  const url = new URL(window.location.href);
  if (value === fallback) url.searchParams.delete(name);
  else url.searchParams.set(name, value);
  window.history.replaceState(window.history.state, '', url);
}

const byRecent = (a: ShelfItem, b: ShelfItem) => b.lastOpened - a.lastOpened;

/** What stopping sharing some books at once says. */
function stoppedSharing(n: number, category: Category): string {
  return `Stopped sharing ${countOf(n, category)}`;
}

/** Links that bring the reader back to the app: from Google, and from Breader's emails. */
const RETURN_PARAMS = ['login', 'error', 'verify', 'reset'];

/*
 * The reader, Browse, a series' page and Add book come in pieces of their own, so the library
 * opens on less. Each is fetched once the app is idle, so it's here before it's wanted.
 */
const loadReader = () => import('./features/reader/Reader');
const loadBrowse = () => import('./features/manga/Browse');
const loadFeed = () => import('./features/shared/PublicFeed');
const loadPage = () => import('./features/manga/MangaPage');
const loadAdd = () => import('./features/add/AddBook');
const Reader = lazy(() => loadReader().then((m) => ({ default: m.Reader })));
const Browse = lazy(() => loadBrowse().then((m) => ({ default: m.Browse })));
const PublicFeed = lazy(() => loadFeed().then((m) => ({ default: m.PublicFeed })));
const MangaPage = lazy(() => loadPage().then((m) => ({ default: m.MangaPage })));
const AddBook = lazy(() => loadAdd().then((m) => ({ default: m.AddBook })));
const Guide = lazy(() => import('./features/guide/Guide').then((m) => ({ default: m.Guide })));
const News = lazy(() => import('./features/news/News').then((m) => ({ default: m.News })));
const Demo = lazy(() => import('./features/guide/Demo').then((m) => ({ default: m.Demo })));
const Feedback = lazy(() => import('./features/feedback/Feedback').then((m) => ({ default: m.Feedback })));
/* The dialogs and menus too: none shows as the library opens. */
const loadLogin = () => import('./features/account/LoginDialog');
const loadKey = () => import('./features/add/KeyDialog');
const loadWhere = () => import('./features/add/AddWhere');
const loadAddTo = () => import('./features/add/AddTo');
const loadRemove = () => import('./features/gallery/RemoveDialog');
const loadLibraries = () => import('./features/shared/LibraryMenu');
const loadOwn = () => import('./features/shared/OwnLibraryMenu');
/** A book's edit popover (gallery/Gallery.tsx shows it). */
const loadEditPopover = () => import('./features/gallery/EditPopover');
/** A book's audiobook dialog and the making (audiobook/Audiobook.tsx shows it). */
const loadAudiobooks = () => Promise.all([import('./features/audiobook/AudiobookDialog'), import('./features/audiobook/audiobooks')]);
const LoginDialog = lazy(() => loadLogin().then((m) => ({ default: m.LoginDialog })));
const KeyDialog = lazy(() => loadKey().then((m) => ({ default: m.KeyDialog })));
const AddWhere = lazy(() => loadWhere().then((m) => ({ default: m.AddWhere })));
const AddTo = lazy(() => loadAddTo().then((m) => ({ default: m.AddTo })));
const loadPublicBook = () => import('./features/shared/PublicBook');
const PublicBook = lazy(() => loadPublicBook().then((m) => ({ default: m.PublicBook })));
const RemoveDialog = lazy(() => loadRemove().then((m) => ({ default: m.RemoveDialog })));
const LibraryMenu = lazy(() => loadLibraries().then((m) => ({ default: m.LibraryMenu })));
const OwnLibraryMenu = lazy(() => loadOwn().then((m) => ({ default: m.OwnLibraryMenu })));
const DesignBar = lazy(() => import('./features/design/DesignBar').then((m) => ({ default: m.DesignBar })));
const LATER = [loadReader, loadBrowse, loadPage, loadAdd, loadLogin, loadKey, loadWhere, loadAddTo, loadPublicBook, loadRemove, loadLibraries, loadOwn, loadEditPopover, loadAudiobooks];
function loadSoon() {
  const all = () => { for (const load of LATER) void load().catch(() => {}); };
  // Safari has no requestIdleCallback.
  const idle = window.requestIdleCallback as typeof window.requestIdleCallback | undefined;
  if (idle) window.requestIdleCallback(all, { timeout: 4000 });
  else window.setTimeout(all, 2000);
}

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

/** Where a series' cover is on its page, when it's on screen. */
/**
 * After a book closes, the focus lands on the card it was opened from, so Tab carries on from
 * there; on the library's main part when the card isn't showing. Left alone if it is somewhere.
 */
function focusCard(id: string) {
  const holder = document.activeElement;
  if (holder && holder !== document.body) return;
  const card = document.querySelector<HTMLElement>(`.gallery:not([hidden]) .tile-hit[data-id="${CSS.escape(id)}"]`);
  if (card) {
    card.focus({ preventScroll: true });
    return;
  }
  document.querySelector<HTMLElement>('main[tabindex="-1"]')?.focus({ preventScroll: true });
}

function coverRect(): DOMRect | null {
  const r = document.querySelector('.mdp .mds-cover')?.getBoundingClientRect();
  if (!r || r.width < 8 || r.top >= window.innerHeight || r.bottom <= 0) return null;
  return r;
}

/**
 * The reader goes back into its card, or the cover on the series' page it was read from: its text
 * clears, then the page draws back into it.
 */
async function closeReader(host: HTMLElement, r: DOMRect | null, reduced: boolean) {
  if (reduced) { await animate(host, { opacity: 0 }, { duration: 0.15 }); return; }
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
  /** A library opened from the public feed, by its token: it shows as a shared library does, read only. */
  const [peek, setPeek] = useState<string | null>(null);
  // Leaving Public by any way closes the library opened from it.
  if (tab !== 'public' && peek) setPeek(null);
  /** The library showing: a library opened from the feed is the Shared tab's look, under Public. */
  let shownTab: Tab = tab;
  if (tab === 'public' && peek) shownTab = 'shelf';
  /** Books or manga: the shelf both tabs show, as the reader last left it. */
  const [category, setCategory] = useState<Category>(() => (readLocal<string>('breader.category.v1', 'books') === 'manga' ? 'manga' : 'books'));
  useEffect(() => { writeLocal('breader.category.v1', category); }, [category]);
  /** The laptop has MangaDex (null until it says), and how this device looks through it. */
  const [mdOn, setMdOn] = useState<boolean | null>(null);
  /** The + button's question: books or manga. */
  const [choosing, setChoosing] = useState(false);
  const [mdPrefs, setMdPrefs] = useState<MangaPrefs>(readMangaPrefs);
  /** A series' page, over the library, and under the reader while a chapter read from it is open. */
  const [sheet, setSheet] = useState<SeriesAt | null>(() => seriesNow(parseHash()));
  /** A chapter picked on a series' page: where its series opens, this once. */
  const [startAt, setStartAt] = useState<{ id: string; pos: Position } | null>(null);
  useEffect(loadSoon, []);
  // Whether Add can open Browse: the laptop says. Out of reach, it stays and Browse says so.
  useEffect(() => {
    if ((category !== 'manga' && !choosing) || mdOn !== null) return;
    let live = true;
    mangadex.state().then((st) => { if (live) setMdOn(st.on); }, () => { if (live) setMdOn(true); });
    return () => { live = false; };
  }, [category, choosing, mdOn]);
  if ((category !== 'manga' || mdOn === false) && tab === 'browse') setTab('mine');
  /**
   * Picking books to act on together: where (the shelf, the library and, for a shared one, which)
   * and the ones ticked. It's in the library as it shows, and ends when anything else shows.
   */
  const [picking, setPicking] = useState<{ place: string; ids: ReadonlySet<string> } | null>(null);
  let pickPlace = '';
  if (route.name === 'library' && shownTab === 'mine') pickPlace = `${category} mine`;
  if (route.name === 'library' && shownTab === 'shelf') pickPlace = `${category} shelf ${peek ?? sharing.showing}`;
  if (picking && picking.place !== pickPlace) setPicking(null);
  // Each tab's library stays once it's been seen, so switching back finds it as it was, and so does
  // each shelf's: a tab seen on one shelf is there on the other too once that's been seen, so
  // switching between books and manga never has a library to make, only one to show.
  const [seen, setSeen] = useState<ReadonlySet<Tab>>(() => new Set([tab]));
  if (!seen.has(tab)) setSeen(new Set([...seen, tab]));
  else if (!seen.has(shownTab)) setSeen(new Set([...seen, shownTab]));
  const [visited, setVisited] = useState<ReadonlySet<Category>>(() => new Set([category]));
  if (!visited.has(category)) setVisited(new Set([...visited, category]));
  const [preview, setPreview] = useState<PreviewMode>(() => (devTools ? readParam('preview', PREVIEW_MODES.map((m) => m.id), 'live') : 'live'));
  // The device's until the sun-or-moon button is first tapped, then that one. The preview bar's ?theme= wins.
  const [theme, setTheme] = useState<AppTheme>(() => (devTools ? readParam('theme', ['auto', 'light', 'dark'] as const, readTheme()) : readTheme()));
  const deviceDark = useDeviceDark();
  const dark = theme === 'dark' || (theme === 'auto' && deviceDark);
  const labels = useLabels();
  /** Covers without their titles and how far they're read, books and manga: on until the reader turns it off, then kept on this device. */
  const [coversOnly, setCoversOnly] = useState(() => readLocal<unknown>(COVERS_ONLY, true) !== false);
  const [adding, setAdding] = useState<{ file?: File | null; mode?: 'file' | 'paste' } | null>(null);
  const [keyOpen, setKeyOpen] = useState(false);
  const [freshKey, setFreshKey] = useState<string | null>(null);
  /** A book in both places being removed from one: asking whether it leaves the other too. */
  const [asking, setAsking] = useState<{ id: string; title: string; from: 'mine' | 'shelf'; category: Category; fromKeyboard: boolean; then?: () => void } | null>(null);
  /** Picked books being removed, some of them shared too: asking once about all of those. */
  const [askingAll, setAskingAll] = useState<{ ids: string[]; shared: string[]; title: string; category: Category; fromKeyboard: boolean } | null>(null);
  const [login, setLogin] = useState<LoginStart | null>(null);
  /** The guide, open: when it was last opened before this, so what came since is New in it. */
  const [guide, setGuide] = useState<{ seenAt: number; q?: string } | null>(null);
  /** What changed since this reader was last here, shown once, over the library. */
  const [whatsNew, setWhatsNew] = useState<Note[] | null>(null);
  /** What's new, cleared by the server to show, waiting for nothing else to be open. */
  const [newsWaiting, setNewsWaiting] = useState<Note[] | null>(null);
  /** A What's new note's video, opened by its See how. */
  const [newsDemo, setNewsDemo] = useState<DemoId | null>(null);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const newsAsked = useRef(false);
  /** What this library is told about feedback it sent (features/feedback/replies.ts), asked once a visit. */
  const repliesAsked = useRef(false);
  const [repliesWaiting, setRepliesWaiting] = useState<FeedbackReply[] | null>(null);
  /** Feedback this library sent that's done, in the What's new dialog. */
  const [implemented, setImplemented] = useState<Note | null>(null);
  /** The shared libraries' list, under the arrow beside the switch between libraries; `key`: opened to type someone's key in. */
  const [librariesOpen, setLibrariesOpen] = useState<false | 'list' | 'key'>(false);
  const guideKept = useGuideKept();
  const news = useNews();
  const account = useAccount();
  const [dragOver, setDragOver] = useState(false);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  /* Books removed this session, kept out of every view (previews show copies of stored books). */
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const [opening, setOpening] = useState<{ id: string; rect: DOMRect } | null>(null);
  /** A book closing: back into its card, or into the cover on the series' page it was read from. */
  const [closing, setClosing] = useState<{ id: string; series: boolean } | null>(null);
  const reduced = useReducedMotion() ?? false;
  const hostRef = useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = useState<{ id: string; book: LoadedBook } | null>(null);
  const openAnimDone = useRef(false);
  const loadedId = useRef<string | null>(null);
  /** Goes up each time the reader steps back from a book still opening, so that load is dropped when it comes. */
  const openRun = useRef(0);
  const toastId = useRef(0);

  const say = useCallback((text: string, more?: Omit<ToastMessage, 'id' | 'text'>) => {
    setToast({ id: ++toastId.current, text, ...more });
  }, []);
  const dismissToast = useCallback((id: number) => setToast((t) => (t?.id === id ? null : t)), []);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'auto') delete root.dataset.theme;
    else root.dataset.theme = theme;
    // The browser's bars go with the page, not only with the device.
    document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach((m) => {
      if (theme === 'auto') m.content = m.media.includes('dark') ? '#000000' : '#FFFFFF';
      else m.content = theme === 'dark' ? '#000000' : '#FFFFFF';
    });
    if (devTools) writeParam('theme', theme, 'auto');
  }, [theme]);
  useEffect(() => { writeParam('preview', preview, 'live'); }, [preview]);

  // Back from Google, or from a link in one of Breader's emails.
  useEffect(() => {
    const url = new URL(window.location.href);
    const q = Object.fromEntries(RETURN_PARAMS.map((k) => [k, url.searchParams.get(k)]));
    if (!q.login && !q.verify && !q.reset) return;
    RETURN_PARAMS.forEach((k) => url.searchParams.delete(k));
    window.history.replaceState(window.history.state, '', url);
    if (q.reset) setLogin({ mode: 'reset', token: q.reset });
    else if (q.login === 'google') setLogin({ mode: 'entering' });
    else if (q.login === 'failed') say('Google login didn’t work.');
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

  // Back and Forward, and an address typed in: the place they go to, as the history kept it.
  useEffect(() => {
    const onMove = () => {
      const next = parseHash();
      setRoute((r) => (sameRoute(r, next) ? r : next));
      const series = seriesNow(next);
      setSheet((s) => (s && series && seriesId(s) === seriesId(series) && s.from === series.from ? s : series));
    };
    window.addEventListener('popstate', onMove);
    window.addEventListener('hashchange', onMove);
    return () => {
      window.removeEventListener('popstate', onMove);
      window.removeEventListener('hashchange', onMove);
    };
  }, []);

  /** To one of the app's places, a step on in the browser's history, so Back comes back. */
  const goTo = useCallback((next: Route, series: SeriesAt | null) => {
    const kept: Kept = { inApp: true };
    if (series) kept.series = series;
    window.history.pushState(kept, '', hashOf(next));
    setRoute(next);
    setSheet(series);
  }, []);

  /**
   * Back to the place this one was gone to from: the browser's own step back, when that's where it
   * came from; otherwise (an address opened as it is) there, in this one's place.
   */
  const goBack = useCallback((to: Route, series: SeriesAt | null) => {
    setRoute(to);
    setSheet(series);
    if (keptNow().inApp) {
      window.history.back();
      return;
    }
    let kept: Kept | null = null;
    if (series) kept = { series };
    window.history.replaceState(kept, '', hashOf(to));
  }, []);

  /** A series' page, over the library. from: what its Back says. */
  const openSeries = useCallback((found: MangaFound[], from: string, more: { al?: number; fromSeries?: boolean } = {}) => {
    goTo({ name: 'series', id: found[0].card.id }, { found, from, ...more });
  }, [goTo]);
  const leaveSeries = useCallback(() => {
    // Opened from another series' page: back to it, as the browser's history has it.
    if (sheet?.fromSeries && keptNow().inApp) {
      window.history.back();
      return;
    }
    // Back where it was picked, a reload since or not.
    if (sheet?.from === 'Browse') {
      setCategory('manga');
      setTab('browse');
    }
    goBack({ name: 'library' }, null);
  }, [goBack, sheet]);
  const pickInBrowse = useCallback((found: MangaFound[], al?: number) => openSeries(found, 'Browse', { al }), [openSeries]);

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
  let showing: Showing = sharing.showing;
  if (shownTab === 'shelf' && tab === 'public' && peek) {
    showing = peek;
    // The reader's own, found in the feed: shown as theirs, not as someone else's to keep from.
    const ownRow = sharing.feed.libraries.find((l) => l.token === peek)?.own === true;
    if (ownRow) showing = 'own';
  }
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
  const shelves = useMemo(() => {
    const of = (c: Category) => ({
      mine: everything.mine.filter((b) => categoryOf(b) === c),
      shelf: everything.shelf.filter((b) => categoryOf(b) === c),
    });
    return { books: of('books'), manga: of('manga') };
  }, [everything]);
  const items = shelves[category];
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
    void import('./books/kept').then((m) => m.sweepKept(haveSeries));
  }, [lib.ready, haveSeries]);
  const guessGenre = useCallback((b: Parameters<typeof genreFor>[1]) => genreFor([...everything.mine, ...everything.shelf], b), [everything]);

  /* Opening a book: the reader grows out of the card, then takes over. */
  const finishOpen = useCallback((id: string) => {
    setOpening(null);
    // Open there already, it's no step on in the history, or Back would only come back to it.
    const at = parseHash();
    if (at.name === 'read' && at.id === id) return;
    // Read from a series' page, the page stays under the reader, for coming back to.
    goTo({ name: 'read', id }, seriesNow(at));
  }, [goTo]);

  /** A series in My manga: its page, from what the card knows until the rest comes. Its other copies are looked for by its name. */
  const chaptersOf = useCallback((b: BookRecord) => {
    const found = foundOf(b);
    if (found) openSeries(found, labels.mine);
  }, [openSeries, labels.mine]);

  /** A series' pages need a library to go to, so a reader without one gets one. Two taps at once make one key. */
  const makingKey = useRef<Promise<void> | null>(null);
  const ensureKey = useCallback(async () => {
    if (lib.key) return;
    if (!makingKey.current) {
      const key = newLibraryKey();
      makingKey.current = lib.setKey(key).then(() => setFreshKey(key));
    }
    try {
      await makingKey.current;
    } finally {
      makingKey.current = null;
    }
  }, [lib]);

  const startLoad = useCallback(async (id: string, given?: BookRecord, at?: Position) => {
    const rec = given ?? recordById.get(id);
    if (!rec) return null;
    const run = openRun.current;
    // What this device can do itself, reading aloud and finding panels, checked while the book loads (reader/able.ts).
    void checkDevice();
    try {
      if (rec.source === 'remote') await ensureKey();
      // A series from a Suwayomi source opens a few chapters around its place.
      const book = await loadRecord(rec, at ?? lib.reads[id]?.pos);
      // The reader went back while it was opening: nothing more to do with it.
      if (run !== openRun.current) return null;
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
      if (run !== openRun.current) return null;
      let text = 'Couldn’t open this book.';
      if (e instanceof Error) text = e.message;
      // A manga's site may be down or gone: its sheet lists its other copies.
      if (rec.source === 'remote') say(text, { action: { label: 'Other copies', run: () => chaptersOf(rec) } });
      else say(text);
      return null;
    }
  }, [recordById, lib, say, chaptersOf, ensureKey]);

  /** The reader grows out of the card while the book loads, and takes over once both are done. */
  const growOpen = useCallback((rec: BookRecord, rect: DOMRect, at?: Position) => {
    openAnimDone.current = false;
    loadedId.current = null;
    const run = openRun.current;
    setOpening({ id: rec.id, rect });
    void startLoad(rec.id, rec, at).then((b) => {
      // Gone back from: another book may be opening by now, and this one has no say over it.
      if (run !== openRun.current) return;
      if (!b) setOpening(null);
      else if (openAnimDone.current) finishOpen(rec.id);
    });
  }, [startLoad, finishOpen]);

  /** Back from a book still opening: it stops, and the reader stays where they were. */
  const stopOpening = useCallback(() => {
    openRun.current += 1;
    setOpening(null);
    setStartAt(null);
  }, []);

  const onOpen = useCallback(async (book: ShelfItem, rect: DOMRect, given?: BookRecord) => {
    // A shared book this reader hasn't started joins their library as they open it. Its copy needs
    // a key to reach the server: that's where its AI switch comes on, when the sharer's file has
    // been read, and where its voices, music and notes are fetched from.
    // A book in a public library's row isn't among the cards: it comes as it is, and its copy here
    // isn't shared with the reader's key, since they never picked that stranger's book to share.
    let entry = recordById.get(book.id);
    let shareCopy = true;
    if (given) {
      entry = given;
      shareCopy = false;
    }
    let rec = entry;
    if (entry?.source === 'shelf') {
      await ensureKey();
      rec = await lib.startShelfBook(entry, shareCopy);
    }
    if (!rec) return;
    // One taken out of My books comes back in once it's being read again.
    if (rec.sharedOnly) lib.setSharedOnly(rec.id, false);
    growOpen(rec, rect);
  }, [recordById, lib, growOpen, ensureKey]);

  /**
   * Renaming, recolouring or favouring a shared book adds it to the reader's library first. Turning
   * its AI on needs a key: without one the switch never reaches the server, and the AI's work can't come back.
   */
  const editBook = useCallback(async (id: string, patch: BookEdit) => {
    if (patch.ai) await ensureKey();
    const rec = recordById.get(id);
    lib.editBook(rec?.source === 'shelf' ? (await lib.startShelfBook(rec)).id : id, patch);
  }, [recordById, lib, ensureKey]);

  // A reader URL opened directly (or reloaded) loads without the transition.
  useEffect(() => {
    if (route.name === 'read' && loaded?.id !== route.id && !opening && lib.ready) void startLoad(route.id);
  }, [route, loaded, opening, lib.ready, startLoad]);

  // Back from a book: to the series' page it was read from, or the library.
  const back = useCallback(() => {
    if (route.name === 'read' && loadedId.current === route.id) setClosing({ id: route.id, series: !!sheet });
    if (sheet) goBack({ name: 'series', id: seriesId(sheet) }, sheet);
    else goBack({ name: 'library' }, null);
    setStartAt(null);
  }, [route, sheet, goBack]);

  /** Back from a book opened by its address, still loading: that load is dropped when it comes. */
  const leaveLoading = useCallback(() => {
    openRun.current += 1;
    back();
  }, [back]);

  // A series' page opened from its address alone, with nothing kept in the history (a link, say): from
  // its card in My manga, or the library when it isn't in it.
  useEffect(() => {
    if (route.name !== 'series' || sheet || !lib.ready) return;
    const rec = remoteSeries.get(route.id);
    const found = rec ? foundOf(rec) : null;
    if (!found) {
      window.history.replaceState(null, '', hashOf({ name: 'library' }));
      setRoute({ name: 'library' });
      return;
    }
    const series = { found, from: labels.mine };
    window.history.replaceState({ ...keptNow(), series }, '', hashOf(route));
    setSheet(series);
  }, [route, sheet, lib.ready, remoteSeries, labels.mine]);

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
    let cover: Blob | undefined = undefined;
    if (about.kind === 'mangadex') {
      const s = about.series;
      if (s.cover) cover = await mangadex.cover(s.id, s.cover, 512);
    } else {
      const s = about.series;
      if (s.cover) cover = await sources.cover(s.cover);
    }
    const rec = seriesRecord(about, url, lib.nextColor());
    await lib.addRemote(rec, cover);
    setPreview('live');
    // As with a first book: a key gives it somewhere to sync, and its pages a library to go to.
    await ensureKey();
    return rec;
  }, [lib, ensureKey]);

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
    const url = withAlso(urlOf(picked.found, picked.group, picked.lang), picked.also);
    let rec = had;
    // Read in another language than the one kept, it's read in that one from now on.
    if (rec && rec.url !== url) {
      lib.setRemoteUrl(rec.id, url);
      rec = { ...rec, url };
    }
    if (!rec) rec = await addSeries(about, url);
    const id = rec.id;
    setStartAt(from ? { id, pos: from } : null);
    growOpen(rec, rect ?? new DOMRect(window.innerWidth / 2 - 60, window.innerHeight / 2 - 85, 120, 170), from);
  }, [lib, addSeries, growOpen]);

  /**
   * Where a book being added goes: Personal or a shared library. Always asked for a series; for a
   * book only when the reader has shared libraries to add to.
   */
  const [askingWhere, setAskingWhere] = useState<((where: Where | null) => void) | null>(null);
  const whereTo = useCallback((always = false): Promise<Where | null> => {
    if (!always && sharing.saved.length === 0) return Promise.resolve({ tokens: [] });
    return new Promise((resolve) => setAskingWhere(() => resolve));
  }, [sharing.saved.length]);
  /** A library made while adding: its key goes on the clipboard, to give to the people it's for. */
  const madeLibrary = useCallback((label: string, key: string) => {
    navigator.clipboard.writeText(key).then(
      () => say(`Made “${label}”. Its key is copied: give it to the people it’s for.`),
      () => say(`Made “${label}”. Its key: ${key}`),
    );
  }, [say]);
  const chooseWhere = (where: Where | null) => {
    askingWhere?.(where);
    setAskingWhere(null);
  };
  /** What a book added to these libraries says it joined. */
  const namesOfLibraries = useCallback((tokens: string[]) => tokens.map((t) => libraryName(sharedNow(), t)).join(', '), []);


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

  // Closing waits two frames, so the library underneath has laid out the card to land on.
  useEffect(() => {
    if (!closing) return;
    let live = true;
    let raf = requestAnimationFrame(() => {
      raf = requestAnimationFrame(() => {
        const host = hostRef.current;
        const to = closing.series ? coverRect() : cardRect(closing.id);
        void (host ? closeReader(host, to, reduced) : Promise.resolve()).then(() => {
          if (!live) return;
          // Gone before its styles are undone, or it shows whole for a frame over the library.
          flushSync(() => setClosing(null));
          if (!closing.series) focusCard(closing.id);
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
      setAsking({ id, title, from: shownTab === 'shelf' ? 'shelf' : 'mine', category: categoryOf(rec), fromKeyboard, then });
      return;
    }
    void removeBook(id, fromKeyboard).then(then);
  }, [lib, shownTab, removeBook]);

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

  /** The guide, from settings, an empty library, a tip or ? in the library; `q`: what it looks for first. */
  /** The button under a What's new video: Public's opens Public; the others have none yet. */
  const demoAct = (id: DemoId) => {
    if (id !== 'public') return null;
    const run = () => {
      setNewsDemo(null);
      setPeek(null);
      setTab('public');
    };
    return { label: 'Open Public', run };
  };

  const openGuide = useCallback((q?: string) => {
    setGuide({ seenAt: guideKept.seen, q });
    markSeen();
  }, [guideKept.seen]);
  // ? in the library opens the guide, as in a book it opens the keys.
  useEffect(() => {
    if (route.name !== 'library') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '?' || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
      if (document.querySelector('[role="dialog"]')) return;
      e.preventDefault();
      openGuide();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [route.name, openGuide]);

  const onAdded = useCallback(async (rec: BookRecord, data: Blob | string, cover?: Blob, opts?: { ai: boolean; tokens?: string[] }) => {
    await lib.addBook(rec, data, cover);
    if (opts?.ai) lib.editBook(rec.id, { ai: true });
    setPreview('live');
    const tokens = opts?.tokens ?? [];
    if (tokens.length > 0) {
      await lib.addToShared(rec, tokens);
      setTab('shelf');
      say(`Added “${rec.title}” to ${namesOfLibraries(tokens)}`);
      return;
    }
    setTab('mine');
    const on = categoryOf(rec);
    setCategory(on);
    say(`Added “${rec.title}” to ${labels.mine}${rec.shared ? ', shared with your key' : ''}`);
  }, [lib, say, labels.mine, namesOfLibraries]);

  /* The Key dialog's usual answer to someone's key: a shared library of its own, beside My books. */
  const openShared = useCallback(async (key: string) => {
    const r = await addLibrary(key);
    setPreview('live');
    setTab('shelf');
    say(r.own ? 'That’s your own key.' : `Added ${r.label} to your shared libraries`);
  }, [say]);

  /* The Key dialog's "It's my own key": this browser switches to the library behind that key. */
  const openKey = useCallback(async (key: string) => {
    await openWithKey(key);
    setPreview('live');
    setTab('mine');
    say('Opened the library for that key');
  }, [say]);

  /*
   * Logged in: this browser should be on the account's library, and once a start it checks. A
   * phone's home-screen app starts with the login Safari had and none of its storage; a browser may
   * have cleared its storage, or still be on a key library it opened before it logged in, so its
   * places never reach the other devices. It moves to the account's library quietly, as logging in
   * would have, or asks first if it holds books the account hasn't got; offline, it tries again
   * next time.
   */
  const rejoined = useRef(false);
  const { ready: libReady, joinAccount } = lib;
  useEffect(() => {
    if (rejoined.current || account.status !== 'in' || !libReady || login) return;
    rejoined.current = true;
    void joinAccount().then((res) => { if (res.outcome === 'choose') setLogin({ mode: 'entering' }); }, () => {});
  }, [account.status, libReady, joinAccount, login]);

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
  const shownId = shown?.id;
  // The open book's series as the library shows it, filled in where its file names none: its books share their character voices.
  const shownSeries = useMemo(() => {
    for (const b of [...everything.mine, ...everything.shelf]) {
      if (b.id !== shownId) continue;
      if (!b.series?.trim()) return undefined;
      return seriesKey(b.series);
    }
    return undefined;
  }, [shownId, everything]);
  const books = useMemo(() => {
    if (shownTab === 'shelf') return items.shelf;
    if (shownTab === 'mine') return items.mine;
    return [];
  }, [shownTab, items]);
  const ownShared = useMemo(() => lib.records.filter((r) => r.shared && !lapsed.has(r.id) && !hidden.has(r.id)).length, [lib.records, lapsed, hidden]);
  /** The Shared tab's count, of the library it shows, also while one from the feed is open. */
  const shelfCount = useMemo(() => {
    if (!peek || tab !== 'public') return items.shelf.length;
    const which = sharing.showing;
    if (which === 'own') return lib.records.filter((r) => r.shared && !lapsed.has(r.id) && !hidden.has(r.id) && categoryOf(r) === category).length;
    return (sharing.libs[which]?.books ?? []).map(shelfRecord).filter((r) => categoryOf(r) === category).length;
  }, [peek, tab, items.shelf.length, sharing.showing, sharing.libs, lib.records, lapsed, hidden, category]);
  /** Public's count: the feed's libraries with any on this shelf, as the feed shows them. */
  const publicCount = sharing.feed.libraries.filter((l) => (category === 'manga' ? l.manga : l.books) > 0).length;
  /** The feed's own facts on the library opened from it. */
  const peeked = peek ? sharing.feed.libraries.find((l) => l.token === peek) : undefined;
  // The feed again each time Public opens; a library opened from it, fresh.
  useEffect(() => { if (tab === 'public') void refreshFeed(); }, [tab]);
  useEffect(() => { if (peek) void refreshLibrary(peek, true); }, [peek]);
  /** Saves the library opened from the feed to the reader's Shared list as their own copy, or takes it off again. */
  const flipSaved = useCallback((l: FeedLibrary) => {
    if (isSaved(sharing, l.token)) {
      unsaveLibrary(l.token);
      say(`Taken off ${labels.shelf}`);
      return;
    }
    let unnamed: string | undefined;
    if (!l.name) unnamed = feedName(l);
    saveLibrary(l.token, unnamed).then(
      () => say(`Saved to ${labels.shelf}`),
      (err: unknown) => say(err instanceof ApiError ? err.message : 'Couldn’t save it. Check your connection and try again.'),
    );
  }, [sharing, say, labels.shelf]);
  /** Renames a library opened from the feed, where it's the reader's: the same as renaming it in Shared's list. */
  const renameAs = (l: FeedLibrary): ((name: string) => void) | undefined => {
    const which = yoursAs(sharing, l);
    if (which === null) return undefined;
    return (name: string) => {
      renameLibrary(which, name).catch((err: unknown) => {
        say(err instanceof ApiError ? err.message : 'Couldn’t rename it. Check your connection and try again.');
      });
    };
  };
  /** The Add to sheet, for these books: every library they can go in, ticked where they are. */
  const [addingTo, setAddingTo] = useState<{ entries: BookRecord[]; shown: Shown[]; theirs: boolean; what: string; hands?: Hands } | null>(null);
  /** `outside`: books from a Public row, not among the reader's cards, taken as they are. */
  const openAddTo = useCallback((books: ShelfItem[], outside = false) => {
    const entries: BookRecord[] = [];
    const shown: Shown[] = [];
    for (const b of books) {
      let rec: BookRecord | undefined = recordById.get(b.id);
      if (outside) rec = b;
      if (!rec) continue;
      entries.push(rec);
      shown.push({ id: b.id, title: b.title, color: b.color });
    }
    if (entries.length === 0) return;
    const theirs = entries.every((e) => e.source === 'shelf');
    let what = countOf(entries.length, categoryOf(entries[0]));
    if (entries.length === 1) what = `“${shown[0].title}”`;
    setAddingTo({ entries, shown, theirs, what });
  }, [recordById]);
  const closeAddTo = useCallback((line: string | null) => {
    setAddingTo(null);
    if (line) say(line);
  }, [say]);
  // The sheet reads the reader's books as they are after each change, not as they were when it opened.
  const recordsNow = useRef(lib.records);
  recordsNow.current = lib.records;
  const { startShelfBook, setShared, setSharedOnly, removeBook: removeOwn, nextColor } = lib;
  const addToHands = useMemo<Hands>(() => ({
    records: () => recordsNow.current,
    shared: sharedNow,
    keep: async (entry, shared) => {
      await ensureKey();
      return startShelfBook(entry, shared);
    },
    setShared,
    setSharedOnly,
    remove: removeOwn,
    addOwn: addOwnBook,
    addTheirs: addShelfBook,
    fresh: (token) => refreshLibrary(token, true),
    takeOut: removeFromLibrary,
  }), [startShelfBook, setShared, setSharedOnly, removeOwn, ensureKey]);
  /**
   * A series from its page into any library, Personal a row too. One not in My manga yet goes in
   * as Personal or the reader's shared library is ticked; any other library takes it by its url.
   */
  const openSeriesAddTo = useCallback((about: About, picked: Picked, had: BookRecord | undefined) => {
    const url = withAlso(urlOf(picked.found, picked.group, picked.lang), picked.also);
    let entry = had;
    if (!entry) entry = seriesRecord(about, url, nextColor());
    const keep = async (_entry: BookRecord, shared: boolean) => {
      const rec = await addSeries(about, url);
      if (shared) setShared(rec.id, true);
      return rec;
    };
    setAddingTo({
      entries: [entry],
      shown: [{ id: entry.id, title: entry.title, color: entry.color }],
      theirs: true,
      what: `“${entry.title}”`,
      hands: { ...addToHands, keep },
    });
  }, [addSeries, setShared, nextColor, addToHands]);
  /** A book picked in a Public row: a manga series opens its page, any other book its window. */
  const [publicBook, setPublicBook] = useState<{ book: ShelfItem; from: string } | null>(null);
  const pickPublic = useCallback((b: ShelfItem, _rect: DOMRect, from: string) => {
    const found = foundOf(b);
    if (found) {
      openSeries(found, 'Public');
      return;
    }
    setPublicBook({ book: b, from });
  }, [openSeries]);
  /** The reader's own copy of a Public book, with how far they are in it, if they have one. */
  const shownMine = (b: ShelfItem): ShelfItem | undefined => {
    const mine = mineOf(lib.records, b);
    if (!mine) return undefined;
    return withReading(mine, lib.reads, lib.covers, lib.edits);
  };
  /** The libraries a book is in besides the reader's own books, for the chips in its popover. */
  const librariesOf = useCallback((b: ShelfItem) => {
    const rec = recordById.get(b.id);
    if (!rec) return [];
    const names: string[] = [];
    for (const t of targetsOf(sharing, rec.source === 'shelf', labels.mine)) {
      if (holds(sharing, lib.records, t.place, rec)) names.push(t.name);
    }
    return names;
  }, [recordById, sharing, labels.mine, lib.records]);
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
  /** The picked books that can go in a library: Add to opens for them. They stay picked. */
  const toAdd = pickedBooks.filter((b) => canShare(b));
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

  /** The token that changes the library showing, when the reader may: its key, or the owner's yes to them. */
  const changing = showing === 'own' ? null : changeToken(sharing, showing);
  /** In someone else's library the reader may change: takes the picked books out of it. */
  const takeOutPicked = async (fromKeyboard: boolean) => {
    if (!changing) return;
    const ids = pickedBooks.map((b) => b.id);
    setPicking(null);
    try {
      const n = await removeFromLibrary(changing, ids);
      say(`Took ${countOf(n, category)} out of ${libraryName(sharing, showing)}`, { focus: fromKeyboard });
      // Opened from the feed with a yes from its owner: the feed's own view of it, and its facts, fresh.
      if (changing !== showing) {
        void refreshLibrary(showing, true);
        void refreshFeed();
      }
    } catch (err) {
      say(err instanceof ApiError ? err.message : 'Couldn’t take them out. Check your connection and try again.');
    }
  };

  /** What can be done with the picked books, by the library they're in. */
  let actions: BulkAction[] = [];
  if (shownTab === 'mine') {
    actions = [
      { key: 'favourite', label: allFavourites ? 'Unfavourite' : 'Favourite', icon: <IconStar />, run: favouritePicked },
      { key: 'addto', label: 'Add to', icon: <IconPeople />, disabled: !toAdd.length, run: () => openAddTo(toAdd) },
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
    if (changing) actions.push({ key: 'remove', label: 'Remove', icon: <IconTrash />, danger: true, run: (k) => void takeOutPicked(k) });
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
  if (books.length > 0) startPicking = () => setPicking({ place: pickPlace, ids: new Set() });
  // The shared libraries' list goes with the tab it hangs from.
  if (tab !== 'shelf' && librariesOpen) setLibrariesOpen(false);

  /** Where the guide's Show me goes; nothing for what can't be gone to just now. */
  const showMe = (g: Go): (() => void) | undefined => {
    switch (g) {
      case 'add': return () => { setCategory('books'); setAdding({ mode: 'file' }); };
      case 'paste': return () => { setCategory('books'); setAdding({ mode: 'paste' }); };
      case 'browse': return mdOn === false ? undefined : () => { setCategory('manga'); setTab('browse'); };
      case 'login': return loggedIn ? undefined : () => setLogin({ mode: 'login' });
      case 'key': return () => setKeyOpen(true);
      case 'libraries': return () => { setTab('shelf'); setLibrariesOpen('key'); };
      case 'select': return startPicking;
    }
  };

  /*
   * Tips, once each (features/guide/Hint.tsx). In the library: books kept only in this browser
   * ask to log in; then that the guide is there. In a book, with a keyboard: that ? has the keys.
   */
  const mouse = useMemo(() => window.matchMedia('(hover: hover) and (pointer: fine)').matches, []);
  const ownCount = shelves.books.mine.length + shelves.manga.mine.length;
  const libraryHints: HintSpec[] = [];
  if (!loggedIn && !lib.key && ownCount > 0) {
    libraryHints.push({ id: 'keep-books', text: 'Your books are only in this browser. Log in to keep them on every device.', action: { label: 'Log in', run: () => setLogin({ mode: 'login' }) } });
  }
  if (ownCount > 0) {
    libraryHints.push({
      id: 'guide',
      text: mouse ? 'Everything Breader does is in the guide: press ?, or find it in settings.' : 'Everything Breader does is in the guide, in settings.',
      action: { label: 'Open it', run: () => openGuide() },
    });
  }
  const readerHints: HintSpec[] = mouse ? [{ id: 'reader-keys', text: 'Press ? to see the keys.', ms: 6000 }] : [];
  const busy = !!(choosing || adding || login || keyOpen || guide || whatsNew || newsDemo || implemented || feedbackOpen || asking || askingAll || askingWhere || freshKey || picking || opening || closing || librariesOpen !== false || dragOver || toast);
  // What's new waits for the library and for nothing else to be open, then asks the server
  // whether this account or address has been shown it already, and shows it once.
  useEffect(() => {
    if (newsAsked.current || busy || !lib.ready || route.name !== 'library') return;
    newsAsked.current = true;
    const notes = unseen();
    if (notes.length === 0) return;
    void firstOnServer(notes[0].id).then((first) => {
      if (first === null) return;
      if (first) {
        setNewsWaiting(notes);
        return;
      }
      markShown();
    });
  }, [busy, lib.ready, route.name]);
  useEffect(() => {
    if (!newsWaiting || busy || route.name !== 'library') return;
    markShown();
    setWhatsNew(newsWaiting);
    setNewsWaiting(null);
  }, [newsWaiting, busy, route.name]);
  // Feedback replies come after What's new, when nothing else is open: asking marks them told.
  useEffect(() => {
    if (repliesAsked.current || busy || newsWaiting || !newsAsked.current || !lib.ready || route.name !== 'library') return;
    repliesAsked.current = true;
    void askReplies().then((replies) => {
      if (replies.length) setRepliesWaiting(replies);
    });
  }, [busy, newsWaiting, lib.ready, route.name]);
  // Done first, in the dialog; then, once it's closed, the toast for any being worked on.
  useEffect(() => {
    if (!repliesWaiting || busy || newsWaiting || route.name !== 'library') return;
    const note = doneNote(repliesWaiting);
    if (note) {
      setImplemented(note);
      setRepliesWaiting(repliesWaiting.filter((r) => r.kind === 'working'));
      return;
    }
    if (anyWorking(repliesWaiting)) say(WORKING, { thin: true, ms: WORKING_MS });
    setRepliesWaiting(null);
  }, [repliesWaiting, busy, newsWaiting, route.name, say]);

  const flipCovers = () => {
    const next = !coversOnly;
    setCoversOnly(next);
    writeLocal(COVERS_ONLY, next);
  };
  /**
   * An empty shared library, of manga or books: the reader's own has the Add a book or Add a manga
   * button every empty library has; someone else's says why it's empty.
   */
  const emptyShelf = () => {
    if (showing === 'own') return undefined;
    if (others?.state === 'closed') {
      return (
        <div className="gallery-empty">
          <p>This key doesn’t open {libraryName(sharing, showing)} any more.</p>
        </div>
      );
    }
    if (others?.state === 'ready') return <div className="gallery-empty" />;
    return <div className="gallery-empty"><p>Opening…</p></div>;
  };
  // Every library seen, on every shelf seen: all but the one showing are hidden.
  const galleries: Array<{ c: Category; t: 'mine' | 'shelf' }> = [];
  for (const c of CATEGORIES) {
    if (!visited.has(c)) continue;
    for (const t of ['mine', 'shelf'] as const) {
      if (seen.has(t)) galleries.push({ c, t });
    }
  }
  /** An empty library's Add a book opens Add book; its Add a manga opens Browse, where the laptop has anywhere to look. */
  const addTo = (c: Category) => (c === 'manga' ? () => setTab('browse') : () => setAdding({ mode: 'file' }));
  /** An empty library: what it's for and how to fill it (features/guide/Welcome.tsx); someone else's says why it's empty. */
  const emptyOf = (c: Category, t: 'mine' | 'shelf'): ReactNode => {
    if (t === 'shelf') {
      if (showing !== 'own') return emptyShelf();
      return <WelcomeShared manga={c === 'manga'} onShare={addTo(c)} onOpen={() => setLibrariesOpen('key')} onGuide={() => openGuide('sharing')} />;
    }
    if (c === 'manga') {
      return <WelcomeManga onBrowse={mdOn === false ? null : () => setTab('browse')} onAdd={() => setAdding({ mode: 'file' })} onPublic={() => { setPeek(null); setTab('public'); }} onGuide={() => openGuide()} />;
    }
    return <WelcomeBooks onAdd={() => setAdding({ mode: 'file' })} onPaste={() => setAdding({ mode: 'paste' })} onPublic={() => { setPeek(null); setTab('public'); }} onGuide={() => openGuide()} />;
  };

  return (
    <MotionConfig reducedMotion="user">
      {/* Under a series' page, the library stays as it was left, for going back to. */}
      {route.name !== 'read' && (
        <div className="lib" inert={route.name === 'series'}>
          <Header
            audiobook={<AudiobookNav />}
            category={category}
            onCategory={setCategory}
            tab={tab}
            counts={{ mine: items.mine.length, shelf: shelfCount, public: publicCount }}
            labels={labels}
            onTab={(t: Tab) => { setPeek(null); setTab(t); }}
            onAdd={() => setChoosing(true)}
            libraries={(close) => (
              <Suspense key="libraries" fallback={null}>
                <LibraryMenu
                  sharing={sharing}
                  ownCount={ownShared}
                  focusKey={librariesOpen === 'key'}
                  onShow={(which: Showing) => { showLibrary(which); setTab('shelf'); }}
                  onClose={close}
                  say={say}
                />
              </Suspense>
            )}
            ownMenu={() => (
              <Suspense key="own" fallback={null}>
                <OwnLibraryMenu name={labels.mine} count={items.mine.length} category={category} />
              </Suspense>
            )}
            librariesOpen={librariesOpen !== false}
            onLibrariesOpen={(o) => setLibrariesOpen(o ? 'list' : false)}
            dark={dark}
            onTheme={() => {
              const next = dark ? 'light' : 'dark';
              setTheme(next);
              writeLocal(THEME, next);
            }}
            settings={(
              <SettingsMenu
                account={account}
                onLogin={() => setLogin({ mode: 'login' })}
                onLogOut={logOutAll}
                onKey={() => setKeyOpen(true)}
                // Only where there are covers to show.
                coversOnly={books.length > 0 || shownTab === 'public' ? coversOnly : undefined}
                onCoversOnly={flipCovers}
                onGuide={() => openGuide()}
                onFeedback={() => setFeedbackOpen(true)}
                news={news}
              />
            )}
            onSelect={startPicking}
            bulk={bulkBar}
          />
          <main className="lib-main" tabIndex={-1}>
          {lib.ready && galleries.map(({ c, t }) => (
            <Gallery
              key={`${c}-${t}-${preview}${t === 'shelf' ? `-${showing}` : ''}`}
              books={shelves[c][t]}
              seriesNames={allSeries}
              place={t}
              // Shared libraries are browsed by genre; one's own books, by series.
              view={t === 'shelf' ? 'genre' : 'series'}
              manga={c === 'manga'}
              coversOnly={coversOnly}
              now={now}
              id={`library-${c}-${t}`}
              labelledBy={`tab-${t}`}
              hidden={t !== shownTab || c !== category}
              onOpen={(b, rect) => void onOpen(b, rect)}
              onAdd={addTo(c)}
              onEdit={(id, patch) => void editBook(id, patch)}
              // Reading shows only in My books.
              onFinish={t === 'mine' ? (b, finished) => lib.setFinished(b.id, finished, b) : undefined}
              onKeep={t === 'shelf' && showing !== 'own' ? (b) => openAddTo([b]) : undefined}
              onKeepAll={t === 'shelf' && showing !== 'own' ? (books, series) => void keepAll(books, series) : undefined}
              onChapters={chaptersOf}
              empty={emptyOf(c, t)}
              onRemove={(b, fromKeyboard) => askRemove(b.id, fromKeyboard)}
              onAddTo={(b) => openAddTo([b])}
              librariesOf={librariesOf}
              picked={picking && t === shownTab && c === category ? picking.ids : undefined}
              head={t === 'shelf' && peek && peeked ? (
                <LibraryHead
                  library={peeked}
                  yours={isYours(sharing, peeked)}
                  saved={isSaved(sharing, peeked.token)}
                  now={now}
                  onBack={() => setPeek(null)}
                  onSave={() => flipSaved(peeked)}
                  onRename={renameAs(peeked)}
                />
              ) : undefined}
              onPick={pick}
            />
          ))}
          {lib.ready && seen.has('public') && (
            <Suspense fallback={null}>
              <PublicFeed category={category} coversOnly={coversOnly} now={now} hidden={tab !== 'public' || !!peek} onLibrary={setPeek} onBook={pickPublic} />
            </Suspense>
          )}
          {lib.ready && mdOn !== false && seen.has('browse') && (
            <Suspense fallback={null}>
              <Browse
                hidden={!manga || tab !== 'browse'}
                have={haveSeries}
                prefs={mdPrefs}
                onPrefs={setMdPrefs}
                onPick={pickInBrowse}
              />
            </Suspense>
          )}
          </main>
        </div>
      )}

      <AnimatePresence>
        {sheet && route.name !== 'library' && (
          <Suspense key={`series-${seriesId(sheet)}`} fallback={null}>
          <MangaPage
            found={sheet.found}
            from={sheet.from}
            al={sheet.al}
            onOpen={(found, card) => openSeries(found, sheet.found[0].card.title, { al: card.id, fromSeries: true })}
            covered={route.name === 'read'}
            prefs={mdPrefs}
            recordOf={recordOf}
            placeOf={placeOf}
            onRead={(about, picked, had, from, rect) => readSeries(about, picked, had, from, rect)}
            onAddTo={openSeriesAddTo}
            onBack={leaveSeries}
          />
          </Suspense>
        )}
      </AnimatePresence>

      {shown && shownRec && (
        <div className={`rd-host${leaving ? ' is-leaving' : ''}`} ref={hostRef}>
          <Suspense fallback={<div className="loading"><Loader /> Opening…</div>}>
          <Reader
            key={shown.id}
            record={shownRec}
            title={lib.edits[shown.id]?.title}
            color={normColor(lib.edits[shown.id]?.color ?? shownRec.color, shownRec.title)}
            book={shown.book}
            // A chapter picked on its series' page: there, whatever place was kept.
            initial={startAt?.id === shown.id ? { ...(lib.reads[shown.id] ?? { progress: 0, line: '', lastOpened: now }), pos: startAt.pos } : lib.reads[shown.id]}
            latest={lib.reads[shown.id]}
            closing={!!leaving}
            onBack={back}
            onSave={onSave}
            onReadTime={(seconds) => lib.addReadTime(shown.id, seconds)}
            onRemove={canRemove(shownRec) ? removeOpen : undefined}
            ai={!!lib.edits[shown.id]?.ai}
            aiElsewhere={!!lib.edits[shown.id]?.aiElsewhere}
            onAi={(on) => on && void editBook(shown.id, { ai: true })}
            series={shownSeries}
            // A series opened a few chapters at a time, with the next few added as it's read on.
            onBook={(grown) => setLoaded((l) => (l && l.id === shown.id ? { id: l.id, book: grown } : l))}
          />
          </Suspense>
        </div>
      )}
      {route.name === 'read' && !reading && !opening && (
        <div className="loading">
          <OpeningBack onBack={leaveLoading} />
          <Loader /> Opening…
        </div>
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
              // Its fading out ends too, once the reader's open: that isn't the card having grown.
              if (openAnimDone.current) return;
              openAnimDone.current = true;
              if (loadedId.current === opening.id) finishOpen(opening.id);
            }}
          >
            {loaded?.id !== opening.id && (
              <>
                <OpeningBack onBack={stopOpening} />
                <span className="opening-note"><Loader /> Opening…</span>
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {dragOver && (
          <motion.div key="drop" className="drop-over" aria-hidden="true" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }} />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {choosing && (
          <AddWhat
            key="add-what"
            onBooks={() => { setChoosing(false); setCategory('books'); setAdding({ mode: 'file' }); }}
            onManga={mdOn === false ? null : () => { setChoosing(false); setCategory('manga'); setTab('browse'); }}
            onClose={() => setChoosing(false)}
          />
        )}
        {adding && (
          <Suspense key="add" fallback={null}>
          <AddBook
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
            whereTo={whereTo}
            onKey={lib.setKey}
            onLogin={loggedIn ? undefined : loginInstead}
          />
          </Suspense>
        )}
        {askingWhere && <Suspense key="add-where" fallback={null}><AddWhere onChoose={chooseWhere} onCreated={madeLibrary} /></Suspense>}
        {publicBook && (
          <Suspense key="public-book" fallback={null}>
            <PublicBook
              book={publicBook.book}
              from={publicBook.from}
              mine={shownMine(publicBook.book)}
              personal={labels.mine}
              onRead={(rect) => {
                const b = publicBook.book;
                setPublicBook(null);
                void onOpen(b, rect, b);
              }}
              onAddTo={() => openAddTo([publicBook.book], true)}
              onClose={() => setPublicBook(null)}
            />
          </Suspense>
        )}
        {addingTo && (
          <Suspense key="add-to" fallback={null}>
            <AddTo
              entries={addingTo.entries}
              shown={addingTo.shown}
              records={lib.records}
              theirs={addingTo.theirs}
              personal={labels.mine}
              what={addingTo.what}
              hands={addingTo.hands ?? addToHands}
              onMade={madeLibrary}
              onClose={closeAddTo}
            />
          </Suspense>
        )}
        {asking && <Suspense key="remove" fallback={null}><RemoveDialog title={asking.title} from={asking.from} manga={asking.category === 'manga'} onChoose={chooseRemove} onClose={() => setAsking(null)} /></Suspense>}
        {askingAll && (
          <Suspense key="remove-all" fallback={null}>
            <RemoveDialog
              title={askingAll.title}
              count={askingAll.shared.length}
              from="mine"
              manga={askingAll.category === 'manga'}
              onChoose={chooseRemoveAll}
              onClose={() => setAskingAll(null)}
            />
          </Suspense>
        )}
        {keyOpen && <Suspense key="key" fallback={null}><KeyDialog libraryKey={lib.key} loggedIn={loggedIn} onClose={() => setKeyOpen(false)} onShared={openShared} onOpen={openKey} /></Suspense>}
        {/* A key made as a series was read waits for the reader to close. */}
        {freshKey && route.name !== 'read' && <Suspense key="fresh-key" fallback={null}><KeyDialog libraryKey={freshKey} fresh onLogin={loggedIn ? undefined : loginInstead} onClose={() => setFreshKey(null)} /></Suspense>}
        {whatsNew && (
          <Suspense key="news" fallback={null}>
            <News notes={whatsNew} onClose={() => setWhatsNew(null)} onFeedback={() => { setWhatsNew(null); setFeedbackOpen(true); }} onDemo={(id) => { setWhatsNew(null); setNewsDemo(id); }} />
          </Suspense>
        )}
        {newsDemo && (
          <Suspense key="news-demo" fallback={null}>
            <Demo id={newsDemo} act={demoAct(newsDemo)} onClose={() => setNewsDemo(null)} />
          </Suspense>
        )}
        {implemented && (
          <Suspense key="implemented" fallback={null}>
            <News notes={[implemented]} onClose={() => setImplemented(null)} onFeedback={() => { setImplemented(null); setFeedbackOpen(true); }} onDemo={(id) => { setImplemented(null); setNewsDemo(id); }} />
          </Suspense>
        )}
        {feedbackOpen && (
          <Suspense key="feedback" fallback={null}>
            <Feedback onClose={() => setFeedbackOpen(false)} onSent={() => { setFeedbackOpen(false); say('Thanks! It’s sent.'); }} />
          </Suspense>
        )}
        {guide && (
          <Suspense key="guide" fallback={null}>
            <Guide seenAt={guide.seenAt} initial={guide.q} go={showMe} onClose={() => setGuide(null)} />
          </Suspense>
        )}
        {login && (
          <Suspense key="login" fallback={null}>
            <LoginDialog
              start={login}
              google={account.google}
              ready={lib.ready}
              localKey={lib.key}
              enter={lib.joinAccount}
              onDone={onLoggedIn}
              onClose={() => setLogin(null)}
            />
          </Suspense>
        )}
      </AnimatePresence>

      <Toast toast={toast} onDone={dismissToast} />
      {route.name === 'library' && <Hint key="library" place="library" hints={libraryHints} quiet={busy} />}
      {route.name === 'read' && <Hint key="reader" place="reader" hints={readerHints} quiet={!reading || !!opening} />}
      <AudiobookHost />
      {devTools && route.name === 'library' && (
        <PreviewBar
          mode={preview}
          onMode={setPreview}
          theme={theme}
          onTheme={setTheme}
          onReset={() => void lib.reset()}
        />
      )}
      {devTools && <Suspense fallback={null}><DesignBar /></Suspense>}
    </MotionConfig>
  );
}
