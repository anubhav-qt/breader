import type { AiFeature } from './progress';

/*
 * What an AI reading along unlocks, each drawn in square dots on the 7-row grid the reader's icons
 * use (reader/chrome/icons.ts), so they sit with Doto's letters in the library and the reader alike.
 */

/** The AI itself: a four-pointed spark. */
export const SPARK = ['...x...', '...x...', '..xxx..', 'xxx.xxx', '..xxx..', '...x...', '...x...'];
/** The spark between beats, while it reads: only its heart. */
export const SPARK_DIM = ['.......', '.......', '...x...', '..x.x..', '...x...', '.......', '.......'];

/** 2 voices: two speech bubbles, one answering the other. */
const TWO = ['xxxx...', 'x..x...', 'xxxx...', '.x.xxxx', '...x..x', '...xxxx', '.....x.'];
/** Character voices: two people, side by side. */
const CAST = ['.x...x.', 'x.x.x.x', '.x...x.', '.......', 'xxx.xxx', 'xxx.xxx', '.......'];
/** Music: two notes, beamed. */
const MUSIC = ['..xxxxx', '..x...x', '..x...x', '..x...x', 'xxx.xxx', 'xxx.xxx', '.......'];
/** Revisit: an open book. */
const REVISIT = ['.......', 'xx...xx', 'x.x.x.x', 'x..x..x', 'x..x..x', 'xxxxxxx', '.......'];

export const FEATURE_ICON: Record<AiFeature, string[]> = { two: TWO, cast: CAST, music: MUSIC, revisit: REVISIT };

/** Each feature: its name, and what it does in a few words. */
export const FEATURE: Record<AiFeature, { name: string; about: string }> = {
  two: { name: '2 voices', about: 'A woman’s voice and a man’s, for every conversation' },
  cast: { name: 'Character voices', about: 'A voice of its own for each person in it' },
  music: { name: 'Music', about: 'Scored the way an anime is, scene by scene' },
  revisit: { name: 'Revisit', about: 'Who’s who and what happened, up to your page' },
};
