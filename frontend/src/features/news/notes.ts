/*
 * What changed, for readers, newest first. Every line is asked of the owner before it goes in;
 * never add one without that. Each shows once, in a dialog (News.tsx), to readers who had Breader
 * before it came. A title and one or two lines, each short and plain enough for a child.
 *
 * `id` is the day it ships, with -2, -3 for a second or third release that day.
 */

export interface Note {
  id: string;
  title: string;
  lines: string[];
}

/** No note up to this day is shown to anyone. Only notes after it, each line approved by the owner. */
export const QUIET_THROUGH = '2026-11-23';

export const NOTES: Note[] = [
  {
    id: '2026-11-18',
    title: 'Replies to your feedback',
    lines: [
      'When we start on something you asked for, or finish it, Breader tells you once.',
      'Words one person quotes inside another’s line are now read in their own voice.',
    ],
  },
  {
    id: '2026-11-15',
    title: 'Neater manga panels',
    lines: [
      'Manga panels in the Panels mode now fit better and don’t get unnecessary slants.',
    ],
  },
  {
    id: '2026-11-10-3',
    title: 'New how-to videos',
    lines: [
      'The short videos on the start page now look just like Breader, in light or dark.',
    ],
  },
  {
    id: '2026-11-10-2',
    title: 'Panels on server',
    lines: [
      'Breader’s computer finds manga panels again, and only with the new model.',
      'Turn on Panels on server in Aa to let it find them for you.',
    ],
  },
  {
    id: '2026-11-10',
    title: 'Better manga panels',
    lines: [
      'Reading manga panel by panel now finds almost every panel.',
      'It finds them faster too.',
    ],
  },
  {
    id: '2026-11-09',
    title: 'Breader is optimized!',
    lines: [
      'Breader opens faster, and your books show up right away.',
      'On a phone, Breader’s computer reads aloud for you. Turn it off in Read aloud.',
    ],
  },
];
