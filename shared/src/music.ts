/*
 * Background music: a soundtrack for each book, scored the way an anime is. The AI marker
 * (ai/tools/music.ts) first gathers the series' soundtrack: the official one from its anime,
 * film or other adaptation, every season of it, found on YouTube by its English or Japanese
 * names, or the best alternates when there's none. Then every scene, from the paragraph it starts
 * at, gets one of those tracks or silence, once per book file, shared by everyone who has that
 * file. A series keeps its soundtrack from one volume to the next, as a show does through its
 * seasons, with new tracks as new seasons come out.
 *
 * The tracks are downloaded once and kept in the file store (R2) as music/<YouTube id>.m4a, and
 * played from there.
 */

/** A YouTube video's id. */
export const TRACK_ID = /^[A-Za-z0-9_-]{11}$/;

/** Where a track is kept in the file store. */
export const trackKey = (id: string) => `music/${id}.m4a`;

/** A track, as the app gets it: its number in the book's list, how long it is, and where it's from. */
export interface MusicTrack {
  n: number;
  title: string;
  /** The YouTube channel it came from, for credit. */
  source: string;
  seconds: number;
}

/** A book's soundtrack, as the server hands it to a reader (server/src/routes/ai.ts). */
export interface AiMusicResponse {
  made: string;
  /** Each section's "blocks:hash", so the app can tell it parsed the same text the AI read. */
  sections: string[];
  tracks: MusicTrack[];
  /** From each paragraph on: [section, block, track number or -1 for silence]. A track plays once, and silence follows it until the next cue. */
  cues: Array<[number, number, number]>;
}

/** A track's address for a while: the file store's signed link. */
export interface MusicLink {
  url: string;
  expiresAt: number;
}
