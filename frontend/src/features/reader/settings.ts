import { useCallback, useEffect, useRef, useState } from 'react';
import { record } from '../../data/sync';
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
  style: Style;
  theme: ThemeName;
  book: StyleSettings;
  modern: StyleSettings;
  pdfLayout: Layout;
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

const DEFAULTS: ReaderSettings = {
  style: 'book',
  theme: 'auto',
  book: { font: 'dongle', size: 22, lh: 1.45, measure: 620, layout: 'pages', justify: true },
  modern: { font: 'dongle', size: 22, lh: 1.65, measure: 620, layout: 'scroll', justify: false },
  pdfLayout: 'pages',
};

const KEY = 'breader.reader.v1';

function loadSettings(): ReaderSettings {
  const saved = readLocal<Partial<ReaderSettings>>(KEY, {});
  return {
    ...DEFAULTS,
    ...saved,
    book: { ...DEFAULTS.book, ...saved.book },
    modern: { ...DEFAULTS.modern, ...saved.modern },
  };
}

/** Reader settings follow the reader between browsers once the library syncs. */
export function useReaderSettings() {
  const [settings, setSettings] = useState<ReaderSettings>(loadSettings);
  useEffect(() => {
    const pulled = () => setSettings(loadSettings());
    window.addEventListener('breader:settings', pulled);
    return () => window.removeEventListener('breader:settings', pulled);
  }, []);
  const changed = useRef(false);
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

export const fontFamily = (key: FontKey) => FONTS.find((f) => f.key === key)?.family ?? 'var(--read)';
