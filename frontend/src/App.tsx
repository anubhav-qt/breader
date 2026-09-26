import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { animate } from 'motion';
import { AnimatePresence, MotionConfig, motion, useReducedMotion } from 'motion/react';
import { Header, type Tab } from './components/Header';
import { PreviewBar, type AppTheme } from './components/PreviewBar';
import { Toast, type ToastMessage } from './components/Toast';
import { detectFormat, forget, loadRecord, parseSource, titleFromName } from './books/load';
import { recordFromBook } from './books/record';
import type { BookRecord, LoadedBook, ReadState } from './books/types';
import { normColor } from './data/colors';
import { canRemove, placeholderRecords, sampleRecords, shelfRecords, type PreviewMode } from './data/library';
import { openWithKey } from './data/sync';
import { useLibrary, withReading, type ShelfItem } from './data/useLibrary';
import { AddBook } from './features/add/AddBook';
import { KeyDialog } from './features/add/KeyDialog';
import { Gallery } from './features/gallery/Gallery';
import { Reader } from './features/reader/Reader';
import { newLibraryKey } from './lib/key';
import { springs } from './lib/springs';
import { readLocal } from './lib/store';
import './app.css';

type Route = { name: 'library' } | { name: 'read'; id: string };

function parseHash(): Route {
  const m = window.location.hash.match(/^#\/read\/(.+)$/);
  return m ? { name: 'read', id: decodeURIComponent(m[1]) } : { name: 'library' };
}

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
const inset = (r: DOMRect) =>
  `inset(${r.top}px ${window.innerWidth - r.right}px ${window.innerHeight - r.bottom}px ${r.left}px round 20px)`;
const FULL = 'inset(0px 0px 0px 0px round 0px)';

/** Where a book's card is in the library, as it will settle (the library may still be rising in). */
function cardRect(id: string): DOMRect | null {
  const tile = document.querySelector<HTMLElement>(`.tile-hit[data-id="${CSS.escape(id)}"]`)?.parentElement;
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
  const [now] = useState(() => Date.now());
  const [route, setRoute] = useState<Route>(parseHash);
  const [tab, setTab] = useState<Tab>('mine');
  const [preview, setPreview] = useState<PreviewMode>(() => readParam('preview', ['live', 'empty', 'one', 'few', 'many'] as const, 'live'));
  const [theme, setTheme] = useState<AppTheme>(() => readParam('theme', ['auto', 'light', 'dark'] as const, 'auto'));
  const [adding, setAdding] = useState<{ file?: File | null; mode?: 'file' | 'paste' } | null>(null);
  const [keyOpen, setKeyOpen] = useState(false);
  const [freshKey, setFreshKey] = useState<string | null>(null);
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

  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  /* Data for the current view */
  const previewSets = useMemo(() => ({ all: [...sampleRecords(now), ...placeholderRecords(now)], shelf: shelfRecords(now) }), [now]);
  const recordById = useMemo(() => {
    const m = new Map<string, BookRecord>();
    for (const r of [...previewSets.all, ...previewSets.shelf, ...lib.records]) m.set(r.id, r);
    return m;
  }, [previewSets, lib.records]);

  const items = useMemo(() => {
    const view = (recs: BookRecord[]) =>
      recs.filter((r) => !hidden.has(r.id)).map((r) => withReading(r, lib.reads, lib.covers, lib.edits)).sort(byRecent);
    const liveMine = view(lib.records.filter((r) => !r.shared));
    const shelf = view([...lib.records.filter((r) => r.shared), ...previewSets.shelf]);
    let mine: ShelfItem[];
    switch (preview) {
      case 'empty': mine = []; break;
      case 'one': mine = liveMine.slice(0, 1).length ? liveMine.slice(0, 1) : view(previewSets.all).slice(0, 1); break;
      case 'few': mine = view(previewSets.all).slice(0, 6); break;
      case 'many': mine = view(previewSets.all); break;
      default: mine = liveMine;
    }
    return { mine, shelf };
  }, [lib.records, lib.reads, lib.covers, lib.edits, previewSets, preview, hidden]);

  /* Opening a book: the reader grows out of the card, then takes over. */
  const finishOpen = useCallback((id: string) => {
    window.location.hash = `#/read/${encodeURIComponent(id)}`;
    setOpening(null);
  }, []);

  const startLoad = useCallback(async (id: string) => {
    const rec = recordById.get(id);
    if (!rec) return null;
    try {
      const book = await loadRecord(rec);
      loadedId.current = id;
      setLoaded({ id, book });
      if (book.kind === 'flow' && book.cover && !rec.hasCover && rec.source !== 'placeholder' && lib.records.some((r) => r.id === id)) {
        void lib.setCover(id, book.cover);
      }
      return book;
    } catch (e) {
      console.error(e);
      say(e instanceof Error ? e.message : 'Couldn’t open this book.');
      return null;
    }
  }, [recordById, lib, say]);

  const onOpen = useCallback((book: ShelfItem, rect: DOMRect) => {
    openAnimDone.current = false;
    loadedId.current = null;
    setOpening({ id: book.id, rect });
    void startLoad(book.id).then((b) => {
      if (!b) setOpening(null);
      else if (openAnimDone.current) finishOpen(book.id);
    });
  }, [startLoad, finishOpen]);

  // A reader URL opened directly (or reloaded) loads without the transition.
  useEffect(() => {
    if (route.name === 'read' && loaded?.id !== route.id && !opening && lib.ready) void startLoad(route.id);
  }, [route, loaded, opening, lib.ready, startLoad]);

  const back = useCallback(() => {
    if (route.name === 'read' && loadedId.current === route.id) setClosing({ id: route.id });
    window.location.hash = '';
    setRoute({ name: 'library' });
  }, [route]);

  // Closing waits two frames, so the library underneath has laid out the card to land on.
  useEffect(() => {
    if (!closing) return;
    let live = true;
    let raf = requestAnimationFrame(() => {
      raf = requestAnimationFrame(() => {
        const host = hostRef.current;
        void (host ? closeReader(host, closing.id, reduced) : Promise.resolve()).then(() => {
          if (!live) return;
          host?.removeAttribute('style');
          host?.querySelectorAll<HTMLElement>('.rd-body').forEach((el) => { el.style.opacity = ''; });
          setClosing(null);
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
          document.querySelector<HTMLElement>(`.tile-hit[data-id="${CSS.escape(id)}"]`)?.focus();
        }));
      }
    };
    say(`Removed “${title}”`, { action: { label: 'Undo', run: () => void undo() }, focus: fromKeyboard });
  }, [recordById, lib, say]);

  const removeOpen = useCallback(async () => {
    if (route.name !== 'read') return;
    await removeBook(route.id);
    back();
  }, [route, removeBook, back]);

  /* Drop files anywhere on the library and they're added straight to the tab you're on. */
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const addFiles = useCallback(async (files: File[]) => {
    const shared = tabRef.current === 'shelf';
    let needKey = !lib.key;
    for (const file of files) {
      const format = detectFormat(file);
      if (!format) { say(`Breader can’t open “${file.name}”`); continue; }
      try {
        const book = await parseSource(file, format, titleFromName(file.name));
        const rec = recordFromBook(book, format, shared);
        const cover = book.kind === 'flow' ? book.cover : undefined;
        book.cleanup?.();
        await lib.addBook(rec, file, cover);
        setPreview('live');
        say(`Added “${rec.title}”`);
        if (!shared && needKey) {
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
  }, [lib, say]);

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

  const onAdded = useCallback(async (rec: BookRecord, data: Blob | string, cover?: Blob) => {
    await lib.addBook(rec, data, cover);
    setPreview('live');
    setTab(rec.shared ? 'shelf' : 'mine');
    say(`Added “${rec.title}” to ${rec.shared ? 'the Shared Library' : 'My books'}`);
  }, [lib, say]);

  /* The Key dialog's "Open library": this browser switches to the library behind that key. */
  const openKey = useCallback(async (key: string) => {
    await openWithKey(key);
    setPreview('live');
    setTab('mine');
    say('Opened the library for that key');
  }, [say]);

  const reading = route.name === 'read' && loaded?.id === route.id ? loaded : null;
  // A reader on its way back into its card stays on screen until it gets there.
  const leaving = !reading && closing && loaded?.id === closing.id ? loaded : null;
  const shown = reading ?? leaving;
  const shownRec = shown ? recordById.get(shown.id) : undefined;
  const books = tab === 'mine' ? items.mine : items.shelf;

  return (
    <MotionConfig reducedMotion="user">
      {route.name === 'library' && (
        <div className="lib">
          <Header
            tab={tab}
            counts={{ mine: items.mine.length, shelf: items.shelf.length }}
            canAdd={books.length > 0}
            onTab={setTab}
            onAdd={() => setAdding({ mode: 'file' })}
            onKey={() => setKeyOpen(true)}
          />
          {lib.ready && (
            <Gallery
              key={`${tab}-${preview}`}
              books={books}
              now={now}
              labelledBy={`tab-${tab}`}
              onOpen={onOpen}
              onAdd={() => setAdding({ mode: 'file' })}
              onEdit={lib.editBook}
              onRemove={(b, fromKeyboard) => void removeBook(b.id, fromKeyboard)}
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
            initial={lib.reads[shown.id]}
            closing={!!leaving}
            onBack={back}
            onSave={onSave}
            onRemove={canRemove(shownRec) ? () => void removeOpen() : undefined}
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
            hasKey={!!lib.key}
            defaultShared={tab === 'shelf'}
            onClose={() => setAdding(null)}
            onAdded={onAdded}
            onKey={lib.setKey}
          />
        )}
        {keyOpen && <KeyDialog key="key" libraryKey={lib.key} onClose={() => setKeyOpen(false)} onOpen={openKey} />}
        {freshKey && <KeyDialog key="fresh-key" libraryKey={freshKey} fresh onClose={() => setFreshKey(null)} />}
      </AnimatePresence>

      <Toast toast={toast} onDone={dismissToast} />
      {route.name === 'library' && (
        <PreviewBar mode={preview} onMode={setPreview} theme={theme} onTheme={setTheme} onReset={() => void lib.reset()} />
      )}
    </MotionConfig>
  );
}
