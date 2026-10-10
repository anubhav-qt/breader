import { z } from 'zod';
import { TRACK_ID } from './music.ts';

/*
 * What an AI made from one book file, read through once offline (ai/procedure.md): Revisit notes
 * and voice marks, as ai/tools/pack.ts writes ai/out/<sha256>.json. `npm --prefix ai run import`
 * checks each file against this and loads it whole into ai_notes. The server then gives each
 * reader only what's safe for them: the notes up to their mark, and voice marks with no names.
 *
 * A position is [section, block], the numbers the reader gives a chapter and its paragraphs
 * (reader/dom.ts collectBlocks). A span counts characters [start, end) of that block's text.
 */

const N = z.number().int().nonnegative();
export const AiGender = z.enum(['M', 'F', 'N']);
export type AiGender = z.infer<typeof AiGender>;
const Text = z.string().min(1).max(2000);

/** [section, block, what]: from that paragraph on. */
const Pinned = z.tuple([N, N, Text]);

export const AiEntry = z.strictObject({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  /** The name the book uses from each point on; the first is where the entry appears. */
  names: z.array(Pinned).min(1),
  /** What's known from each point on; the latest at or before the reader wins. */
  about: z.array(Pinned).min(1),
  /** What happens there (people, mostly). */
  events: z.array(Pinned),
  /** From there on this entry is another one: [section, block, that entry's id]. */
  merge: z.tuple([N, N, z.string().min(1)]).optional(),
});
export type AiEntry = z.infer<typeof AiEntry>;

export const AI_KINDS = ['people', 'places', 'terms'] as const;
export type AiKind = (typeof AI_KINDS)[number];

/** A book's soundtrack (shared/src/music.ts), as its file has it. */
const AiMusic = z.strictObject({
  /** The tracks the book plays, by their YouTube id, and what each is for in the series: a theme, a mood. */
  tracks: z.array(z.strictObject({
    id: z.string().regex(TRACK_ID),
    title: z.string().max(300),
    /** The YouTube channel it came from, for credit. */
    source: z.string().max(200),
    seconds: N,
    role: z.string().max(200),
  })),
  /** From each paragraph on: [section, block, track (an index) or -1 for silence]. A track plays once, and silence follows it until the next cue. */
  cues: z.array(z.tuple([N, N, z.number().int().min(-1)])),
});

/** Each chapter's block count and text hash ("count:fnv1a"), to tell the app parsed the same text. */
const Sections = z.array(z.string().regex(/^\d+:[0-9a-f]{8}$/));

export const AiFile = z.strictObject({
  v: z.literal(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  title: z.string(),
  author: z.string(),
  format: z.string(),
  words: N,
  /** When it was packed, and by which model. */
  made: z.iso.datetime(),
  by: z.string().min(1).max(200),
  /** Each chapter's block count and text hash ("count:fnv1a"), to tell the app parsed the same text. */
  sections: Sections,
  revisit: z.strictObject({ people: z.array(AiEntry), places: z.array(AiEntry), terms: z.array(AiEntry) }),
  voices: z.strictObject({
    cast: z.array(z.strictObject({
      id: z.string().min(1),
      name: z.string(),
      g: AiGender,
      /** How they sound from a reveal on. */
      changes: z.array(z.tuple([N, N, AiGender])).optional(),
    })),
    /** From each paragraph on: the narrator (a cast index, or -1 for third person) and whose eyes (-1 for nobody's). */
    narration: z.array(z.tuple([N, N, z.number().int().min(-1), z.number().int().min(-1)])),
    /** Every spoken line: [section, block, start, end, voice, speaker (cast index), a thought 1 or 0]. */
    spans: z.array(z.tuple([N, N, N, N, AiGender, N, z.union([z.literal(0), z.literal(1)])])),
  }),
  /** The book's soundtrack (shared/src/music.ts), once the marker has scored it. */
  music: AiMusic.optional(),
});
export type AiFile = z.infer<typeof AiFile>;

/** Dashes that don't belong in Revisit notes: em, en, and a hyphen standing in for one. */
const DASHES = /[\u2014\u2013]| - /;

/**
 * What the schema can't say: every position is a real paragraph, every index points at someone,
 * spans sit inside their paragraph in order, merges land on an entry, and notes have no dashes.
 * Returns the problems found, none when it's sound.
 */
export function aiProblems(f: AiFile): string[] {
  const out: string[] = [];
  const blocks = f.sections.map((s) => Number(s.split(':')[0]));
  const real = (s: number, b: number) => s < blocks.length && b < blocks[s];
  const where = (s: number, b: number) => `${s}:${b}`;

  for (const kind of AI_KINDS) {
    const ids = new Set<string>();
    for (const e of f.revisit[kind]) {
      if (ids.has(e.id)) out.push(`${kind} ${e.id}: listed twice`);
      ids.add(e.id);
      for (const [label, list] of [['names', e.names], ['about', e.about], ['events', e.events]] as const) {
        for (const [s, b, text] of list) {
          if (!real(s, b)) out.push(`${kind} ${e.id}: ${label} at ${where(s, b)}, which isn’t a paragraph`);
          if (DASHES.test(text)) out.push(`${kind} ${e.id}: ${label} at ${where(s, b)} has a dash`);
        }
      }
      if (e.merge && !real(e.merge[0], e.merge[1])) out.push(`${kind} ${e.id}: merges at ${where(e.merge[0], e.merge[1])}, which isn’t a paragraph`);
    }
    for (const e of f.revisit[kind]) {
      if (e.merge && (!ids.has(e.merge[2]) || e.merge[2] === e.id)) out.push(`${kind} ${e.id}: merges into ${e.merge[2]}, which isn’t another ${kind} entry`);
    }
  }

  const cast = f.voices.cast.length;
  for (const [i, c] of f.voices.cast.entries()) {
    for (const [s, b] of c.changes ?? []) if (!real(s, b)) out.push(`cast ${i}: changes at ${where(s, b)}, which isn’t a paragraph`);
  }
  for (const [s, b, who, pov] of f.voices.narration) {
    if (!real(s, b)) out.push(`narration at ${where(s, b)}, which isn’t a paragraph`);
    if (who >= cast || pov >= cast) out.push(`narration at ${where(s, b)}: no one in the cast by that number`);
  }
  let last: [number, number, number] = [-1, -1, -1];
  for (const [s, b, start, end, , who] of f.voices.spans) {
    if (!real(s, b)) out.push(`a line at ${where(s, b)}, which isn’t a paragraph`);
    if (end <= start) out.push(`a line at ${where(s, b)} ends before it starts`);
    if (who >= cast) out.push(`a line at ${where(s, b)}: no one in the cast by that number`);
    if (s < last[0] || (s === last[0] && (b < last[1] || (b === last[1] && start < last[2])))) out.push(`a line at ${where(s, b)} is out of order`);
    last = [s, b, end];
  }
  if (f.music) out.push(...musicProblems(f.music, real));
  return out;
}

/** The soundtrack's own checks: each track once, and cues on real paragraphs, in order, playing tracks it has. */
function musicProblems(music: NonNullable<AiFile['music']>, real: (s: number, b: number) => boolean): string[] {
  const out: string[] = [];
  const ids = new Set<string>();
  for (const t of music.tracks) {
    if (ids.has(t.id)) out.push(`music: track ${t.id} is listed twice`);
    ids.add(t.id);
  }
  let last: [number, number] = [-1, -1];
  for (const [s, b, track] of music.cues) {
    const where = `${s}:${b}`;
    if (!real(s, b)) out.push(`music: a cue at ${where}, which isn’t a paragraph`);
    if (track >= music.tracks.length) out.push(`music: the cue at ${where} plays a track it doesn’t have`);
    if (s < last[0] || (s === last[0] && b <= last[1])) out.push(`music: the cue at ${where} is out of order`);
    last = [s, b];
  }
  return out;
}

/* ---- Music scored somewhere else, uploaded from the admin page ---- */

/** A track in a series' soundtrack, as the marker keeps it (ai/tools/music.ts). */
const SoundtrackTrack = z.strictObject({
  id: z.string().regex(TRACK_ID),
  title: z.string().max(300),
  source: z.string().max(200),
  seconds: N,
  album: z.string().max(200),
  /** Its feel, and the scenes it fits. */
  use: z.string().max(200),
  /** From the series' own music, not an alternate. */
  official: z.boolean(),
  /** How it sounds, measured. */
  sound: z.string().max(4000),
});

/**
 * A book's music, scored somewhere else (a trial on a Mac), uploaded from the admin page and put
 * into its file by the AI marker (ai/tools/marker.ts): the score, who made it, and the series'
 * whole soundtrack, so the marker never has to gather it again. No book text: only the sections'
 * prints, which have to match the file the server has.
 */
export const MusicImport = z.strictObject({
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  sections: Sections,
  /** Who scored it, for the file's "by". */
  by: z.string().min(1).max(200),
  score: AiMusic,
  soundtrack: z.strictObject({
    name: z.string().min(1).max(300),
    made: z.iso.datetime(),
    summary: z.string().max(1000),
    tracks: z.array(SoundtrackTrack).min(1),
  }),
});
export type MusicImport = z.infer<typeof MusicImport>;

/**
 * What the schema can't say about an upload: its cues sit on real paragraphs, in order, and play
 * tracks it has, and every track it plays is in its soundtrack. None when it's sound.
 */
export function musicImportProblems(m: MusicImport): string[] {
  const blocks = m.sections.map((s) => Number(s.split(':')[0]));
  const real = (s: number, b: number) => s < blocks.length && b < blocks[s];
  const out = musicProblems(m.score, real);
  const inSoundtrack = new Set(m.soundtrack.tracks.map((t) => t.id));
  for (const t of m.score.tracks) {
    if (!inSoundtrack.has(t.id)) out.push(`music: track ${t.id} isn’t in the soundtrack`);
  }
  return out;
}

/* ---- What the server hands a reader (server/src/routes/ai.ts) ---- */

/** [section, block]: a paragraph. */
export type AiAt = [number, number];

/** Whether a book has anything from the AI for this reader: its switch is on and the AI has read its file. */
export interface AiStatus {
  /** When the notes were made, or null when there are none. */
  made: string | null;
  revisit: boolean;
  voices: boolean;
  /** Background music (shared/src/music.ts). */
  music: boolean;
}

/** A person, place or word, as far as the reader has read and no further. */
export interface RevisitEntry {
  /** Tells entries apart; says nothing about them. */
  key: number;
  /** What the book calls them by now, and what it called them before. */
  name: string;
  also: string[];
  about: string;
  /** What's happened, in order: [section, block, what]. */
  events: Array<[number, number, string]>;
  /** Where they came in, and where they were last seen. */
  first: AiAt;
  last: AiAt;
  /** Every section they're in. */
  seen: number[];
}

export interface RevisitResponse {
  made: string;
  /** The paragraph the notes go up to, or null when the reader has read the book through. */
  upTo: AiAt | null;
  people: RevisitEntry[];
  places: RevisitEntry[];
  terms: RevisitEntry[];
}

/** Who reads what in 2 voices. No names: nobody sees these, they only pick a voice. */
export interface AiVoicesResponse {
  made: string;
  /** Each section's "blocks:hash", so the app can tell it parsed the same text the AI read. */
  sections: string[];
  /** From each paragraph on, whose voice the narration is in: her, his, or null for the reader's pick. */
  narration: Array<[number, number, 'F' | 'M' | null]>;
  /** Every line spoken by a woman or a man: [section, block, start, end, 'F' | 'M']. */
  spans: Array<[number, number, number, number, 'F' | 'M']>;
}

/**
 * A section's fingerprint, "blocks:hash": how many paragraphs it has, and FNV-1a over UTF-16 of
 * their text. The same as ai/tools/lib.ts `fingerprint`, so the app can tell a chapter it parsed
 * is the very text the AI read (AiFile.sections).
 */
export function printOf(texts: string[]): string {
  const text = texts.join('\u0001');
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${texts.length}:${(h >>> 0).toString(16).padStart(8, '0')}`;
}
