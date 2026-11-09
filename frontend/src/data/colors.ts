import type { CSSProperties } from 'react';

/** Solid book colours. Each has a deeper shade for light pages and a brighter one for dark pages in tokens.css, each with a legible ink. */
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

/**
 * A colour for a new book: a random one of those the library has given out least. So each colour
 * leaves the pool once used, and the pool refills only when every colour has been used. `given`
 * is the colour each book was first given; recolouring a book later doesn't count.
 */
export function pickColor(given: string[]): BookColor {
  const counts = new Map<string, number>(BOOK_COLORS.map((c) => [c.key, 0]));
  for (const g of given) if (counts.has(g)) counts.set(g, counts.get(g)! + 1);
  const least = Math.min(...counts.values());
  const pool = [...counts].filter(([, n]) => n === least).map(([k]) => k as BookColor);
  return pool[Math.floor(Math.random() * pool.length)];
}

/**
 * A book's colour: one of the palette's, or one picked exactly, as `#rrggbb`. Picked ones are kept in
 * lower case; LEGACY's are matched only as earlier builds saved them, in upper case, so a colour
 * picked now is never swapped for the palette's nearest.
 */
export type Tint = BookColor | `#${string}`;

const HEX = /^#[0-9a-f]{6}$/;

/** A colour typed or pasted, as `#rrggbb`: with or without its #, in 3 digits or 6. Null if it isn't one. */
export function toHex(typed: string): `#${string}` | null {
  let h = typed.trim().toLowerCase().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/.test(h)) h = h.replace(/./g, (c) => c + c);
  return /^[0-9a-f]{6}$/.test(h) ? `#${h}` : null;
}

export function normColor(value: string | undefined, title: string): Tint {
  if (value && KEYS.has(value)) return value as BookColor;
  if (value && LEGACY[value]) return LEGACY[value];
  if (value && HEX.test(value)) return value as Tint;
  return colorKeyFor(title);
}

export const isPicked = (key: string) => HEX.test(key);

/** A colour as the browser gives it, `rgb(r, g, b)`, as `#rrggbb`. Null if it isn't one. */
export function rgbToHex(rgb: string): `#${string}` | null {
  const m = rgb.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!m) return null;
  return `#${m.slice(1, 4).map((n) => Number(n).toString(16).padStart(2, '0')).join('')}`;
}

/** How bright a colour looks (WCAG's relative luminance), 0 to 1. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const LIGHT_INK = '#ffffff';
const DARK_INK = '#141414';

/** The words on a picked colour: white or near black, whichever stands out more. */
export function inkOn(hex: string): string {
  const l = luminance(hex);
  const onWhite = 1.05 / (l + 0.05);
  const onDark = (l + 0.05) / (luminance(DARK_INK) + 0.05);
  return onWhite >= onDark ? LIGHT_INK : DARK_INK;
}

/** A book colour, and its ink: the palette's shade for this theme, or the colour picked, as it is. */
export const tintOf = (key: string) => (isPicked(key) ? key : `var(--bc-${key})`);
export const tintInkOf = (key: string) => (isPicked(key) ? inkOn(key) : `var(--bc-${key}-ink)`);

export function colorVars(key: string): CSSProperties {
  return { '--bc': tintOf(key), '--bc-ink': tintInkOf(key) } as CSSProperties;
}
