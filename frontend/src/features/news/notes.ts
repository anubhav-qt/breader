/*
 * What changed, for readers: one note for each release to breader.site, newest first. Each shows
 * once, in a dialog (News.tsx), to readers who had Breader before it came. A title and one or two
 * lines, each short and plain enough for a child. infra/ship.sh won't ship a release whose notes
 * are the same as the live one's, so every release says what it changed.
 *
 * `id` is the day it ships, with -2, -3 for a second or third release that day.
 */

export interface Note {
  id: string;
  title: string;
  lines: string[];
}

export const NOTES: Note[] = [
  {
    id: '2026-11-09',
    title: 'Breader is optimized!',
    lines: [
      'Breader opens faster, and your books show up right away.',
      'Manga now read left to right. Like right to left? Tap Aa while reading.',
    ],
  },
];
