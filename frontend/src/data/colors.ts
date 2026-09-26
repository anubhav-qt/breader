import type { CSSProperties } from 'react';

/** Solid book colours. Each has a light and a dark shade in tokens.css, plus a legible ink. */
export const BOOK_COLORS = [
  { key: 'rose', label: 'Rose' },
  { key: 'clay', label: 'Clay' },
  { key: 'ochre', label: 'Ochre' },
  { key: 'sand', label: 'Sand' },
  { key: 'sage', label: 'Sage' },
  { key: 'moss', label: 'Moss' },
  { key: 'green', label: 'Lamp green' },
  { key: 'teal', label: 'Teal' },
  { key: 'sky', label: 'Sky' },
  { key: 'indigo', label: 'Indigo' },
  { key: 'lilac', label: 'Lilac' },
  { key: 'plum', label: 'Plum' },
  { key: 'blush', label: 'Blush' },
  { key: 'graphite', label: 'Graphite' },
] as const;

export type BookColor = (typeof BOOK_COLORS)[number]['key'];

const KEYS = new Set<string>(BOOK_COLORS.map((c) => c.key));

/** Hex colours saved by earlier builds, mapped to the nearest palette colour. */
const LEGACY: Record<string, BookColor> = {
  '#B4545E': 'rose', '#1F5F63': 'teal', '#2B3A67': 'indigo', '#C9A227': 'ochre', '#3F4652': 'graphite',
  '#4F6B3A': 'moss', '#5B2A4B': 'plum', '#8A4B2A': 'clay', '#2F6F8F': 'sky', '#6B5B95': 'lilac',
  '#9C3D54': 'rose', '#355C4B': 'green', '#A0673A': 'clay', '#D8C9A8': 'sand',
};

/** A stable default colour picked from the title. */
export function colorKeyFor(title: string): BookColor {
  let h = 0;
  for (let i = 0; i < title.length; i++) h = (h * 31 + title.charCodeAt(i)) | 0;
  return BOOK_COLORS[Math.abs(h) % BOOK_COLORS.length].key;
}

export function normColor(value: string | undefined, title: string): BookColor {
  if (value && KEYS.has(value)) return value as BookColor;
  if (value && LEGACY[value.toUpperCase()]) return LEGACY[value.toUpperCase()];
  return colorKeyFor(title);
}

export function colorVars(key: string): CSSProperties {
  return { '--bc': `var(--bc-${key})`, '--bc-ink': `var(--bc-${key}-ink)` } as CSSProperties;
}
