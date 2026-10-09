import { useEffect, useState } from 'react';
import { readSetting, writeSetting } from '../features/reader/settings';

/*
 * The names on the two halves of the library switch: Personal and Shared until the reader renames
 * them. One pair for books and manga alike, kept in the synced reader settings, so every browser
 * the reader uses shows the same.
 */

export type LibraryLabels = Record<'mine' | 'shelf', string>;

const LABELS = 'libraryLabels';
export const LABEL_CHARS = 40;
export const DEFAULT_LABELS: LibraryLabels = { mine: 'Personal', shelf: 'Shared' };

/** What the reader saved, as an object, or an empty one. */
function savedLabels(): Record<string, unknown> {
  const saved = readSetting(LABELS);
  if (saved && typeof saved === 'object') return saved as Record<string, unknown>;
  return {};
}

/** One half's name: the reader's, or the default where they haven't given one. */
function labelOf(saved: Record<string, unknown>, which: keyof LibraryLabels): string {
  const v = saved[which];
  if (typeof v !== 'string' || !v.trim()) return DEFAULT_LABELS[which];
  return v.trim();
}

export function readLabels(): LibraryLabels {
  const saved = savedLabels();
  return { mine: labelOf(saved, 'mine'), shelf: labelOf(saved, 'shelf') };
}

/** Renames one half. A blank name brings the default back. */
export function renameLabel(which: keyof LibraryLabels, name: string) {
  const clean = name.trim().slice(0, LABEL_CHARS);
  writeSetting(LABELS, { ...savedLabels(), [which]: clean });
}

/** The names as they are, following changes made here and on the reader's other browsers. */
export function useLabels(): LibraryLabels {
  const [labels, setLabels] = useState(readLabels);
  useEffect(() => {
    const changed = () => setLabels(readLabels());
    window.addEventListener('breader:settings', changed);
    return () => window.removeEventListener('breader:settings', changed);
  }, []);
  return labels;
}
