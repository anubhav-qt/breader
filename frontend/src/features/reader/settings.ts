import { useCallback, useEffect, useRef, useState } from 'react';
import { record } from '../../data/sync';
import type { BookColor } from '../../data/colors';
import { readLocal, writeLocal } from '../../lib/store';

export type Style = 'book' | 'modern';
export type ThemeName = 'auto' | 'day' | 'warm' | 'dusk' | 'night';
export type FontKey = 'dongle' | 'oxanium' | 'literata' | 'garamond' | 'atkinson';
export type Layout = 'pages' | 'scroll';

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

/** Light pink and light blue on dark pages; their deeper shades on light ones. */
export const TWO_COLORS: { F: BookColor; M: BookColor } = { F: 'rose', M: 'sky' };

const DEFAULTS: ReaderSettings = {
  style: 'book',
  theme: 'auto',
  book: { font: 'dongle', size: 22, lh: 1.45, measure: 620, layout: 'pages', justify: false },
  modern: { font: 'dongle', size: 22, lh: 1.65, measure: 620, layout: 'scroll', justify: false },
  pdfLayout: 'pages',
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
