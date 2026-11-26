import { countOf, type Category } from '../books/category';
import type { LibraryLabels } from '../data/labels';

/** The libraries the header switches between (LibrarySwitch, LibraryPick on phones). */
export type Half = 'mine' | 'shelf' | 'public';
export const HALVES: Half[] = ['mine', 'shelf', 'public'];

/** A half's name: the reader's own two names, then Public. */
export function nameOf(t: Half, labels: LibraryLabels): string {
  if (t === 'public') return 'Public';
  return labels[t];
}

/** What a half says to screen readers after its name: how many it holds. */
export function countFor(t: Half, n: number, category: Category): string {
  if (t !== 'public') return countOf(n, category);
  if (n === 1) return '1 library';
  return `${n} libraries`;
}
