import { useCallback, useEffect, useRef, useState } from 'react';
import { record } from '../../data/sync';
import type { BookColor } from '../../data/colors';
import { readLocal, writeLocal } from '../../lib/store';

export type Style = 'book' | 'modern';
export type ThemeName = 'auto' | 'day' | 'warm' | 'dusk' | 'night';
export type FontKey = 'dongle' | 'oxanium' | 'literata' | 'garamond' | 'atkinson';
export type Layout = 'pages' | 'scroll';
/** Which way a manga's pages turn: right to left as manga is read, or left to right as comics are. */
export type MangaDir = 'rtl' | 'ltr';

export interface StyleSettings {
  font: FontKey;
  size: number;
  lh: number;
  measure: number;
  layout: Layout;
  justify: boolean;
}

export interface ReaderSettings {
  /** Pages read as Book and scroll as Modern: the layout picks it (styleFor). */
  style: Style;
  theme: ThemeName;
  book: StyleSettings;
  modern: StyleSettings;
  pdfLayout: Layout;
  /** Manga: scrolled down a column of pages, or turned a page (or two, side by side) at a time. */
  mangaLayout: Layout;
  mangaDir: MangaDir;
  /**
   * Each manga's own layout and direction, by its id: `layout` on a wide screen, `narrow` on a narrow
   * one (NARROW). Those without start as the last picked there.
   */
  mangaOwn?: Record<string, { layout: Layout; dir: MangaDir; narrow?: Layout }>;
  /** The layout last picked for a manga on a narrow screen; scrolled until one is. */
  mangaNarrow?: Layout;
  /** Manga scrolled on a wide screen: how wide the column of pages is (MANGA_WIDTHS). */
  mangaWidth?: number;
  /** 2 voices: the colour her lines light in, and his (book colours, data/colors.ts). */
  twoColors?: { F: BookColor; M: BookColor };
  /** Which of the changes below (loadSettings) these have been through. */
  v?: number;
}

/** Reading typefaces. New faces get added here as they arrive. */
export const FONTS: Array<{ key: FontKey; label: string; family: string; note?: string }> = [
  { key: 'dongle', label: 'Dongle', family: 'var(--read)', note: 'default' },
  { key: 'oxanium', label: 'Oxanium', family: 'var(--oxanium)' },
  { key: 'literata', label: 'Literata', family: 'var(--serif)' },
  { key: 'garamond', label: 'EB Garamond', family: 'var(--garamond)' },
  { key: 'atkinson', label: 'Atkinson Hyperlegible', family: 'var(--atkinson)' },
];

export const THEMES: Array<{ key: ThemeName; label: string }> = [
  { key: 'auto', label: 'Auto' },
  { key: 'day', label: 'Day' },
  { key: 'warm', label: 'Warm' },
  { key: 'dusk', label: 'Dusk' },
  { key: 'night', label: 'Night' },
];

export const SIZE_MIN = 15;
export const SIZE_MAX = 32;
export const SPACING = [
  { v: 1.3, label: 'Tight spacing' },
  { v: 1.45, label: 'Normal spacing' },
  { v: 1.65, label: 'Loose spacing' },
];
export const MEASURES = [
  { v: 720, label: 'Narrow margins' },
  { v: 620, label: 'Medium margins' },
  { v: 540, label: 'Wide margins' },
];

/** Scrolled manga: the column of pages, narrow to wide. */
export const MANGA_WIDTHS = [
  { v: 640, label: 'Narrow' },
  { v: 860, label: 'Medium' },
  { v: 1200, label: 'Wide' },
];
export const MANGA_WIDTH = 860;

/**
 * Narrower than this, a manga opens scrolled, as a page turned at a time is small to read, and keeps
 * a layout for screens this narrow apart from the one it has on wider ones.
 */
export const NARROW = '(max-width: 899px)';

/** Light pink and light blue on dark pages; their deeper shades on light ones. */
export const TWO_COLORS: { F: BookColor; M: BookColor } = { F: 'rose', M: 'sky' };

const DEFAULTS: ReaderSettings = {
  style: 'book',
  theme: 'auto',
  book: { font: 'dongle', size: 22, lh: 1.45, measure: 620, layout: 'pages', justify: false },
  modern: { font: 'dongle', size: 22, lh: 1.65, measure: 620, layout: 'scroll', justify: false },
  pdfLayout: 'pages',
  mangaLayout: 'scroll',
  mangaDir: 'rtl',
  v: 3,
};

/** The style a layout reads in: pages are a book's, scrolling is modern. */
export const styleFor = (layout: Layout): Style => (layout === 'pages' ? 'book' : 'modern');

const KEY = 'breader.reader.v1';

/** Settings changed on the way in, to keep and send on once the reader is open. */
let changedOnLoad: ReaderSettings | null = null;

function loadSettings(): ReaderSettings {
  const saved = readLocal<Partial<ReaderSettings>>(KEY, {});
  const s = {
    ...DEFAULTS,
    ...saved,
    book: { ...DEFAULTS.book, ...saved.book },
    modern: { ...DEFAULTS.modern, ...saved.modern },
  };
  // 2: Justify was on by default for Book, so nearly everyone had it without choosing it. Off.
  if ((saved.v ?? 1) < 2) {
    s.book.justify = false;
    s.modern.justify = false;
    s.v = 2;
    if (saved.book || saved.modern) changedOnLoad = s;
  }
  // 3: No Style switch any more; the layout picks it. Book scrolling or Modern in pages becomes the
  // other style, with the type it was read in, so the page looks as it did.
  if ((saved.v ?? 1) < 3) {
    const was = s[s.style];
    const style = styleFor(was.layout);
    if (style !== s.style) s[style] = { ...was };
    s.style = style;
    s.book = { ...s.book, layout: 'pages' };
    s.modern = { ...s.modern, layout: 'scroll' };
    s.v = 3;
    if (saved.book || saved.modern || saved.style) changedOnLoad = s;
  }
  return s;
}

/** Reader settings follow the reader between browsers once the library syncs. */
export function useReaderSettings() {
  const [settings, setSettings] = useState<ReaderSettings>(loadSettings);
  useEffect(() => {
    const pulled = () => setSettings(loadSettings());
    // Changed in another tab: take them, so a change here doesn't write the old ones back.
    const elsewhere = (e: StorageEvent) => { if (e.key === KEY) pulled(); };
    window.addEventListener('breader:settings', pulled);
    window.addEventListener('storage', elsewhere);
    return () => {
      window.removeEventListener('breader:settings', pulled);
      window.removeEventListener('storage', elsewhere);
    };
  }, []);
  const changed = useRef(false);
  useEffect(() => {
    if (!changedOnLoad) return;
    writeLocal(KEY, changedOnLoad);
    record({ type: 'settings.put', prefs: changedOnLoad as unknown as Record<string, unknown> });
    changedOnLoad = null;
  }, [settings]);
  const update = useCallback((fn: (s: ReaderSettings) => ReaderSettings) => {
    changed.current = true;
    setSettings((s) => {
      const next = fn(s);
      writeLocal(KEY, next);
      return next;
    });
  }, []);
  // Only the reader's own changes are sent (not settings that just arrived from another browser),
  // and outside the state updater, which React may run twice.
  useEffect(() => {
    if (!changed.current) return;
    changed.current = false;
    record({ type: 'settings.put', prefs: settings as unknown as Record<string, unknown> });
  }, [settings]);
  return [settings, update] as const;
}

/** Reader settings kept by something other than the reader's controls (voice/sayas.ts). */
export const readSetting = (name: string): unknown => readLocal<Record<string, unknown>>(KEY, {})[name];

/** Changes one of those, here, in the reader's controls, in other tabs and on the reader's other browsers. */
export function writeSetting(name: string, value: unknown) {
  const next = { ...readLocal<Record<string, unknown>>(KEY, {}), [name]: value };
  writeLocal(KEY, next);
  window.dispatchEvent(new Event('breader:settings'));
  record({ type: 'settings.put', prefs: next });
}

export const fontFamily = (key: FontKey) => FONTS.find((f) => f.key === key)?.family ?? 'var(--read)';

/** Whether the screen is narrow (NARROW), as it's resized or turned. */
export function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => typeof matchMedia === 'function' && matchMedia(NARROW).matches);
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const m = matchMedia(NARROW);
    const changed = () => setNarrow(m.matches);
    m.addEventListener('change', changed);
    return () => m.removeEventListener('change', changed);
  }, []);
  return narrow;
}

/** How a manga reads: `narrow`, the screen is, so it's in the layout picked for narrow screens. */
export interface MangaLook {
  layout: Layout;
  dir: MangaDir;
  width: number;
  narrow: boolean;
}

/** As this manga was last read on a screen this wide or narrow, or as the last one picked there; on a narrow screen, scrolled until one is. */
export function mangaLookOf(s: ReaderSettings, id: string, narrow: boolean): MangaLook {
  const own = s.mangaOwn?.[id];
  let layout = own?.layout ?? s.mangaLayout;
  if (narrow) layout = own?.narrow ?? s.mangaNarrow ?? 'scroll';
  return { layout, dir: own?.dir ?? s.mangaDir, width: s.mangaWidth ?? MANGA_WIDTH, narrow };
}

/**
 * A manga's own layout (on a screen as `narrow` as this, or not) and direction, changed by `patch`;
 * the next new one starts with them too.
 */
export function withMangaLook(s: ReaderSettings, id: string, patch: { layout?: Layout; dir?: MangaDir }, narrow = false): ReaderSettings {
  const own = s.mangaOwn?.[id] ?? { layout: s.mangaLayout, dir: s.mangaDir };
  const next = { ...own, dir: patch.dir ?? own.dir };
  if (patch.layout && narrow) next.narrow = patch.layout;
  else if (patch.layout) next.layout = patch.layout;
  return {
    ...s,
    mangaLayout: next.layout,
    mangaDir: next.dir,
    ...(narrow && patch.layout ? { mangaNarrow: patch.layout } : {}),
    mangaOwn: { ...s.mangaOwn, [id]: next },
  };
}
