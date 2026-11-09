/*
 * The keys a video player has, for the voice and Immersive's light (Reader.tsx). Space and K play
 * and pause, J and L go back and on ten seconds, the arrows five, and so on. Seconds are words at
 * the pace it reads. Previous and next (Shift+P, Shift+N) aren't here: a book has no playlist.
 */

export type PlayerKey =
  | { do: 'toggle' }
  | { do: 'seek'; seconds: number }
  | { do: 'step'; dir: 1 | -1 }
  | { do: 'volume'; by: number }
  | { do: 'mute' }
  | { do: 'speed'; dir: 1 | -1 }
  | { do: 'full' }
  | { do: 'chapter'; at: number }
  | { do: 'size'; dir: 1 | -1 }
  | { do: 'find' }
  | { do: 'keys' };

const BY_KEY: Record<string, PlayerKey> = {
  ' ': { do: 'toggle' },
  k: { do: 'toggle' },
  j: { do: 'seek', seconds: -10 },
  l: { do: 'seek', seconds: 10 },
  ArrowLeft: { do: 'seek', seconds: -5 },
  ArrowRight: { do: 'seek', seconds: 5 },
  ArrowUp: { do: 'volume', by: 0.05 },
  ArrowDown: { do: 'volume', by: -0.05 },
  m: { do: 'mute' },
  f: { do: 'full' },
  ',': { do: 'step', dir: -1 },
  '.': { do: 'step', dir: 1 },
  '<': { do: 'speed', dir: -1 },
  '>': { do: 'speed', dir: 1 },
  Home: { do: 'chapter', at: 0 },
  End: { do: 'chapter', at: 1 },
  '+': { do: 'size', dir: 1 },
  '=': { do: 'size', dir: 1 },
  '-': { do: 'size', dir: -1 },
  '/': { do: 'find' },
  '?': { do: 'keys' },
};

/** Keys the page has its own use for: they turn or scroll it until there's a voice or a light to move. */
export const PAGE_KEYS = new Set([' ', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']);

/** What a key press does, if it's one of these. Never with Cmd, Ctrl or Alt held: those are the browser's. */
export function playerKey(e: KeyboardEvent): PlayerKey | null {
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  if (/^[0-9]$/.test(e.key)) return { do: 'chapter', at: Number(e.key) / 10 };
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  return BY_KEY[key] ?? null;
}

/** The keys sheet's list. */
export const KEY_LIST: Array<[string, string]> = [
  ['Space  K', 'Play or pause'],
  ['←  →', 'Back or on 5 seconds'],
  ['J  L', 'Back or on 10 seconds'],
  [',  .', 'The sentence before or after'],
  ['0 to 9', 'That far into the chapter'],
  ['Home  End', 'The chapter’s start or its last sentence'],
  ['↑  ↓', 'Voice louder or softer'],
  ['M', 'Mute the voice'],
  ['<  >', 'Slower or faster'],
  ['F', 'Full screen'],
  ['+  −', 'Bigger or smaller text'],
  ['/', 'Find in the book'],
  ['?', 'These keys'],
];
