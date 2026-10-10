import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Type } from '../pi/pi-ai/src/index.ts';
import type { Balancer } from './balancer.ts';
import { brain, runAgent, tool, type Brain } from './harness.ts';
import { context, longName, mins, text, type Done, type Ledger } from './kimi.ts';
import { blockAt, bookDir, cmp, count, hasText, inPart, partName, parsePos, posText, readJson, slug, writeJson, type Book, type Part, type Pos, type QueueBook } from './lib.ts';
import type { Msg } from './nim.ts';
import { noHarness } from './proxy.ts';
import { oneAtATime, seriesName, seriesResearch } from './research.ts';
import { describe, profile, type Profile } from './sound.ts';
import { readPageTool, webSearchTool } from './web.ts';
import { audioFile, LONGEST_S, MUSIC, search, SHORTEST_S, store, video } from './youtube.ts';

/*
 * A book's background music, scored the way an anime is (shared/src/music.ts). Two steps:
 *
 * 1. The soundtrack, once per series, by the harness (harness.ts): Gemini looks for the series'
 *    official music first, every season and film of its adaptations, by its English and Japanese
 *    names, finds each track on YouTube, and when there's none, or too little, the best
 *    alternates. Every track it adds is downloaded and measured (sound.ts) and described: its feel
 *    and the scenes it fits. A series keeps its soundtrack from one volume to the next and brings
 *    it up to date once it's a month old, as new seasons come out. Gemini gets the series' names
 *    and its research from the web (research.ts), never the book.
 *
 * 2. The score, by the NVIDIA models, who read the whole book (kimi.ts): one call plans it (whose
 *    themes are which, the biggest moments and what's saved for them), then every part at once
 *    gets a track or silence from each scene's first paragraph, then check, and a call to fix any
 *    part with problems. The cues go in music.json, the tracks they use into the file store, and
 *    who did what in music-by.json, so a stopped run picks up where it was.
 *
 * Nothing it prints has the book's text in it.
 */

const SOUNDTRACKS = join(MUSIC, 'series');
const SOUNDS = join(MUSIC, 'sound');
/** A soundtrack needs this many tracks to score every kind of scene, and takes no more than the most. */
const MIN_TRACKS = 12;
const MAX_TRACKS = 120;
/** A soundtrack older than this is brought up to date before the next volume is scored. */
const FRESH_DAYS = 30;
/** Calls for a new soundtrack, and for bringing one up to date. */
const FIRST_CALLS = 150;
const UPDATE_CALLS = 60;
/** The longest a track's use can be: the app shows it as the track's role. */
const USE_CHARS = 200;
/** Fix calls for parts with problems. */
const FIX_ROUNDS = 1;

/** A track in a series' soundtrack. */
export interface CatalogTrack {
  /** Its YouTube id. */
  id: string;
  title: string;
  /** The YouTube channel it's from, for credit. */
  source: string;
  seconds: number;
  album: string;
  /** Its feel, and the scenes it fits. */
  use: string;
  /** From the series' own music, not an alternate. */
  official: boolean;
  /** How it sounds, measured (sound.ts). */
  sound: string;
}

export interface Soundtrack {
  name: string;
  made: string;
  /** What Gemini found: the official music and its seasons, or why it's alternates. */
  summary: string;
  tracks: CatalogTrack[];
}

/** Who did each step of a book's music: music-by.json. */
export interface MusicLedger {
  plan?: Done;
  parts: Ledger;
  fixed?: Done;
  /** The tracks the score uses are in the file store. */
  stored?: string;
}

/** What a book's score comes to: the tracks it plays and its cues, as they go in its file. */
export interface Score {
  made: string;
  tracks: Array<{ id: string; title: string; source: string; seconds: number; role: string }>;
  cues: Array<[number, number, number, 0 | 1]>;
}

/** What each book is on right now, for the marker's live view. */
export const musicStage = new Map<string, string>();
/** The step where the harness gathers the series' soundtrack, which leaves NVIDIA free. */
export const GATHERING = 'Gathering the soundtrack';

/** Whether a program runs here, asked for its version. */
function runs(bin: string, versionArg: string): boolean {
  const r = spawnSync(bin, [versionArg], { stdio: 'ignore', timeout: 30_000 });
  return r.status === 0;
}

/** Why the marker can't score music here, or null when it can: it needs the harness, yt-dlp and ffmpeg. */
export function noMusic(): string | null {
  const why = noHarness();
  if (why) return why;
  if (!runs(process.env.YT_DLP || 'yt-dlp', '--version')) return 'yt-dlp isn’t installed';
  if (!runs(process.env.FFMPEG || 'ffmpeg', '-version')) return 'ffmpeg isn’t installed';
  return null;
}

/* ---- The soundtrack ---- */

const soundtrackFile = (name: string) => join(SOUNDTRACKS, `${slug(name)}.json`);

export function loadSoundtrack(name: string): Soundtrack | null {
  const file = soundtrackFile(name);
  if (!existsSync(file)) return null;
  return readJson<Soundtrack>(file);
}

function saveSoundtrack(s: Soundtrack) {
  mkdirSync(SOUNDTRACKS, { recursive: true });
  writeJson(soundtrackFile(s.name), s);
}

const isFresh = (s: Soundtrack) => Date.now() - Date.parse(s.made) < FRESH_DAYS * 86_400_000;

const clock = (secs: number) => `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;

/** How a track sounds, measured once: downloaded, metered and the audio let go again. */
async function soundOf(id: string): Promise<Profile> {
  const file = join(SOUNDS, `${id}.json`);
  if (existsSync(file)) return readJson<Profile>(file);
  const v = await video(id);
  if (v.seconds > LONGEST_S) throw new Error(`${id} is ${clock(v.seconds)} long, too long for a scene (up to ${clock(LONGEST_S)}): find the track's own upload.`);
  const audio = await audioFile(id);
  const p = await profile(audio);
  mkdirSync(SOUNDS, { recursive: true });
  writeJson(file, p);
  rmSync(audio, { force: true });
  return p;
}

function trackLine(t: CatalogTrack, n: number): string {
  let kind = 'alternate';
  if (t.official) kind = 'official';
  return `${n} | ${t.title} | ${t.album} | ${kind} | ${clock(t.seconds)} | use: ${t.use} | sound: ${t.sound}`;
}

const SOUNDTRACK_SYSTEM = `You gather the soundtrack for a book series in the Breader e-reader. While Breader reads a book aloud, it plays music under the scenes the way an anime is scored. Another model then picks a track, or silence, for every scene of each book from the list you make. It reads the book; you can't. So your list has to cover every kind of scene a story like this has, and each track's use has to say its feel and the scenes it fits well enough to choose by.

How to go about it:
1. Find out whether the series has official music: an anime, film, drama or game adaptation with a soundtrack, or an image album or drama CD. Search by its English and Japanese names. If it has, gather it: every season and film, the background music above all, since that's what scores scenes; openings and endings only a few, and their instrumental versions before the sung ones.
2. Find each track on YouTube on its own upload: the label's or composer's channel, or a "- Topic" channel, before fan uploads. A whole album in one video can't be used (a track is ${clock(SHORTEST_S)} to ${clock(LONGEST_S)}): look for its tracks one by one.
3. Where there's no official music, or too little to score every kind of scene, add the best alternates: instrumental tracks that suit the series' genre, setting and era, from the soundtracks of similar anime, films and games, or composers who write that way. Look for them with web_search and YouTube.
4. Every track's use says its feel and the scenes it fits, from what the sources say about where it plays and from how it sounds: "Tense, low strings building to drums: chases, ambushes, a fight about to start." For an official track, say where it plays in the adaptation when the sources say.

Cover everyday calm, comedy, warmth, romance, sorrow, tension, mystery, dread, battle, triumph, wonder, farewell, and the main theme, with several tracks for the kinds a story like this has most. Listen to a track before adding it when you're unsure what it sounds like: you get its loudness, how it swells and falls, and its energy through each tenth.`;

function soundtrackBrief(name: string, s: Soundtrack): string {
  const lines = [`The series: ${name}`];
  const r = seriesResearch(name);
  if (r?.sections.series) lines.push('', '# What the research found about the series', '', r.sections.series);
  if (r?.sections.adaptations) lines.push('', '# Its adaptations', '', r.sections.adaptations);
  lines.push('');
  if (s.tracks.length) {
    lines.push(`Its soundtrack was gathered on ${s.made.slice(0, 10)}: ${s.summary}`, '', `Bring it up to date: look for seasons, films and albums that have come out since, add their tracks, and fill any kind of scene it has too few tracks for. Keep what's there unless it's wrong. It has ${s.tracks.length} tracks; see them with soundtrack.`);
  } else {
    lines.push(`Gather its soundtrack: at least ${MIN_TRACKS} tracks and up to ${MAX_TRACKS}, as many as it takes to score every kind of scene well. When you finish, the summary says what you found: the official music and which seasons and films it's from, or why it's alternates.`);
  }
  return lines.join('\n');
}

function soundtrackTools(b: Brain, s: Soundtrack) {
  const has = (id: string) => s.tracks.some((t) => t.id === id);

  const youtubeSearch = tool(
    'youtube_search',
    'Searches YouTube for videos: each with its id, title, channel, length and views. Search by the track’s or album’s name, in English or Japanese.',
    Type.Object({
      query: Type.String(),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: 'How many, 10 if left out.' })),
    }),
    async (args) => {
      const found = await search(args.query, args.limit ?? 10);
      if (!found.length) return 'Nothing found: try other words, or the Japanese name.';
      return found.map((f) => {
        let note = '';
        if (has(f.id)) note = ' (in the soundtrack)';
        else if (f.seconds && f.seconds < SHORTEST_S) note = ' (too short)';
        else if (f.seconds > LONGEST_S) note = ' (too long)';
        let views = '';
        if (f.views !== null) views = ` | ${count(f.views)} views`;
        return `${f.id} | ${f.title} | ${f.channel} | ${clock(f.seconds)}${views}${note}`;
      }).join('\n');
    },
  );

  const youtubeVideo = tool(
    'youtube_video',
    'A YouTube video’s details: its title, channel, length, description, tags and chapters.',
    Type.Object({ id: Type.String({ description: 'The video’s id: 11 letters, digits, - or _.' }) }),
    async (args) => {
      const v = await video(args.id);
      const lines = [`${v.title}`, `Channel: ${v.channel}`, `Length: ${clock(v.seconds)}`];
      if (v.views !== null) lines.push(`Views: ${count(v.views)}`);
      if (v.tags.length) lines.push(`Tags: ${v.tags.join(', ')}`);
      if (v.chapters.length) lines.push(`Chapters: ${v.chapters.map((c) => `${clock(c.at)} ${c.title}`).join('; ')}`);
      if (v.description) lines.push('', v.description);
      return lines.join('\n');
    },
  );

  const listen = tool(
    'listen',
    'How a track sounds, measured: its loudness, how much it swells and falls, its energy through each tenth, and how long it takes to come in and fade out.',
    Type.Object({ id: Type.String({ description: 'The video’s id.' }) }),
    async (args) => describe(await soundOf(args.id)),
  );

  const list = tool('soundtrack', 'The soundtrack as it stands: every track with its number, album, use and sound.', Type.Object({}), () => {
    if (!s.tracks.length) return 'No tracks yet.';
    return s.tracks.map((t, i) => trackLine(t, i + 1)).join('\n');
  });

  const add = tool(
    'add_track',
    'Adds a YouTube video to the soundtrack: it’s downloaded and measured, which takes a little while.',
    Type.Object({
      id: Type.String({ description: 'The video’s id.' }),
      title: Type.String({ description: 'The track’s own name, as its album lists it.' }),
      album: Type.String({ description: 'Its album or season, e.g. "Season 2 Original Soundtrack", or the alternate’s source.' }),
      use: Type.String({ description: `Its feel and the scenes it fits, up to ${USE_CHARS} characters.` }),
      official: Type.Boolean({ description: 'True if it’s from this series’ own music.' }),
    }),
    async (args) => {
      if (has(args.id)) return `${args.id} is in the soundtrack already.`;
      if (s.tracks.length >= MAX_TRACKS) throw new Error(`The soundtrack has ${MAX_TRACKS} tracks, the most it takes: remove one first.`);
      const use = args.use.trim();
      if (!use) throw new Error('Say what it’s for: its feel and the scenes it fits.');
      if (use.length > USE_CHARS) throw new Error(`Its use is ${use.length} characters; keep it to ${USE_CHARS}.`);
      const v = await video(args.id);
      if (v.seconds < SHORTEST_S) throw new Error(`It's ${clock(v.seconds)} long, too short to carry a scene.`);
      if (v.seconds > LONGEST_S) throw new Error(`It's ${clock(v.seconds)} long, longer than a track can be (${clock(LONGEST_S)}): find the track's own upload.`);
      const sound = describe(await soundOf(args.id));
      s.tracks.push({
        id: args.id,
        title: args.title.trim().slice(0, 300) || v.title.slice(0, 300),
        source: v.channel.slice(0, 200),
        seconds: v.seconds,
        album: args.album.trim().slice(0, 200),
        use,
        official: args.official,
        sound,
      });
      saveSoundtrack(s);
      return `Added as track ${s.tracks.length}. ${sound}`;
    },
  );

  const remove = tool(
    'remove_track',
    'Takes a track out of the soundtrack.',
    Type.Object({ id: Type.String({ description: 'The video’s id.' }) }),
    (args) => {
      const before = s.tracks.length;
      s.tracks = s.tracks.filter((t) => t.id !== args.id);
      if (s.tracks.length === before) return `${args.id} isn’t in the soundtrack.`;
      saveSoundtrack(s);
      return `Removed. ${s.tracks.length} tracks left.`;
    },
  );

  return [webSearchTool(b), readPageTool(), youtubeSearch, youtubeVideo, listen, list, add, remove];
}

/**
 * A series' soundtrack, gathered or brought up to date by the harness when it's missing or old.
 * An old one that can't be brought up to date is used as it is.
 */
export async function soundtrackFor(name: string, given?: Brain): Promise<Soundtrack> {
  return oneAtATime(`music:${slug(name)}`, async () => {
    const had = loadSoundtrack(name);
    if (had && isFresh(had) && had.tracks.length >= MIN_TRACKS) return had;
    const s: Soundtrack = had ?? { name, made: '', summary: '', tracks: [] };
    let maxCalls = FIRST_CALLS;
    if (s.tracks.length) maxCalls = UPDATE_CALLS;
    const unfinished = () => {
      if (s.tracks.length >= MIN_TRACKS) return null;
      return `The soundtrack has ${s.tracks.length} tracks; it needs at least ${MIN_TRACKS}, enough for every kind of scene.`;
    };
    const started = Date.now();
    try {
      let using = given;
      if (!using) using = await brain();
      const summary = await runAgent({
        system: SOUNDTRACK_SYSTEM,
        brief: soundtrackBrief(name, s),
        tools: soundtrackTools(using, s),
        maxCalls,
        unfinished,
        label: { soundtrack: slug(name) },
      }, using);
      s.summary = summary.slice(0, 1000);
    } catch (e) {
      if (!had || had.tracks.length < MIN_TRACKS) throw e;
      console.log(`${name}: the soundtrack couldn’t be brought up to date (${e instanceof Error ? e.message : String(e)}), so it stays as it was`);
      return had;
    }
    s.made = new Date().toISOString();
    saveSoundtrack(s);
    const official = s.tracks.filter((t) => t.official).length;
    console.log(`${name}: soundtrack of ${s.tracks.length} tracks (${official} official), in ${mins((Date.now() - started) / 1000)}`);
    return s;
  });
}

/* ---- The score ---- */

const dirOf = (book: Book) => join(bookDir(book.key), 'music');
const tracksFile = (book: Book) => join(dirOf(book), 'tracks.json');
const planFile = (book: Book) => join(dirOf(book), 'plan.txt');
const partFile = (book: Book, n: number) => join(dirOf(book), `${partName(n)}.txt`);
export const scoreFile = (book: { key: string }) => join(bookDir(book.key), 'music.json');
export const musicLedgerFile = (book: { key: string }) => join(bookDir(book.key), 'music-by.json');
export const musicLedger = (book: { key: string }): MusicLedger => {
  if (existsSync(musicLedgerFile(book))) return readJson<MusicLedger>(musicLedgerFile(book));
  return { parts: {} };
};
const saveLedger = (book: Book, l: MusicLedger) => writeJson(musicLedgerFile(book), l);
const done = (model: string, secs: number): Done => ({ model, rounds: 1, secs: Math.round(secs), at: new Date().toISOString() });

const DIRECT_SYSTEM = `You are the music director for a book in the Breader e-reader. While Breader reads a book aloud, or lights it up paragraph by paragraph, it plays music under the scenes the way an anime is scored. For every scene, from the paragraph where its music changes, you choose a track from the series' soundtrack, or silence. The music is the same for everyone who reads this book, so it has to be right: a full, cinematic score.

How a book is scored:
- Music comes in where a scene's feel is set or turns: a new place or time, an entrance, rising danger, a fight, a reveal, a farewell, the quiet after.
- Silence is part of the score. Most talk goes without music, unless something crucial is happening in it, or it's an easy slice-of-life moment that a light track carries. Some big moments hit harder in silence.
- A cue holds for a scene: don't change tracks every few paragraphs. A track plays from its start; one shorter than its scene can play again (loop) while the scene lasts; otherwise it plays once and silence follows.
- Themes come back: the main theme at the big turns, a person's or a place's track where they matter, the same track for the same kind of moment. Save the strongest tracks for the biggest moments, and don't wear any track out.
- Official tracks first, where they fit: they're how the series sounds. Alternates fill in where none does.
- Match each track's sound to its scene: a soft one under a quiet scene, one that swells under a scene that builds, one that comes in slowly where the scene eases in.

The book is given with each paragraph's number in brackets: section:paragraph.`;

const PLAN_TASK = `Plan this book's score before it's scored part by part. Plain lines, under 500 words: which tracks are whose themes, and which moods' and places'; the book's biggest moments, at which paragraph (section:paragraph), and which tracks are saved for them; where long silences belong. Use the tracks' numbers.`;

const PART_TASK = `Score this part. Answer with lines like these and nothing else:
12:4 7 | the caravan sets out at dawn
12:30 7 loop | the long ride, easy talk
13:2 silence | the argument: the words carry it
- <paragraph> <track number> | why: that track plays from that paragraph on. loop after the number plays it again while the scene lasts.
- <paragraph> silence | why: the music stops there.
Whatever the part before ends with plays on into this part until your first line, so a line at its first paragraph is only for a change there. Every paragraph is exactly as the text shows it in brackets, inside this part, in order.`;

const FIX_TASK = `check found problems in your lines for this part. Send all of the part's lines back, fixed, and nothing else.`;

function catalogText(tracks: CatalogTrack[]): string {
  return tracks.map((t, i) => trackLine(t, i + 1)).join('\n');
}

const ask = (user: string[]): Msg[] => [{ role: 'system', content: DIRECT_SYSTEM }, { role: 'user', content: user.join('\n\n') }];

function base(book: Book, tracks: CatalogTrack[], focus: number | null, level: number): string[] {
  return [context(book, focus, level), `# The soundtrack (number | title | album | kind | length | use | sound)\n\n${catalogText(tracks)}`];
}

interface CueLine {
  at: string;
  /** The track's number in the list, or 0 for silence. */
  track: number;
  loop: boolean;
}

const LINE = /^(\d+:\d+)\s+(silence|\d+)(\s+loop)?\s*(?:\|.*)?$/i;

/** A part's lines in the model's answer, and how many of its lines fit no shape. */
export function parseCues(answer: string): { lines: CueLine[]; odd: number } {
  const lines: CueLine[] = [];
  let odd = 0;
  for (const raw of answer.split(/\r?\n/)) {
    const t = raw.trim().replace(/^[-*]\s+/, '');
    if (!t || t.startsWith('```')) continue;
    const m = t.match(LINE);
    if (!m) {
      odd++;
      continue;
    }
    let track = 0;
    if (m[2].toLowerCase() !== 'silence') track = Number(m[2]);
    // Silence has nothing to play again.
    const loop = track > 0 && !!m[3];
    lines.push({ at: m[1], track, loop });
  }
  return { lines, odd };
}

/** What's wrong with a part's lines, each a line for the model. */
export function cueProblems(book: Book, part: Part, lines: CueLine[], odd: number, tracks: number): string[] {
  const out: string[] = [];
  if (odd) out.push(`${odd} ${odd === 1 ? 'line fits' : 'lines fit'} no shape: each is <paragraph> <track number or silence> [loop] | why`);
  let last: Pos | null = null;
  for (const l of lines) {
    const at = parsePos(l.at)!;
    if (!inPart(part, at)) out.push(`${l.at} isn’t in this part (${posText(part.from)} to ${posText(part.to)})`);
    else if (!hasText(blockAt(book, at)?.text ?? '')) out.push(`${l.at} isn’t a paragraph with text`);
    if (l.track > tracks) out.push(`${l.at} plays track ${l.track}, and the soundtrack has ${tracks}`);
    if (last && cmp(at, last) <= 0) out.push(`${l.at} comes after ${posText(last)}: lines go in order, one per paragraph`);
    last = at;
  }
  return out;
}

/** A part's good lines: in the part, at a paragraph with text, a track the soundtrack has, in order. */
function goodLines(book: Book, part: Part, lines: CueLine[], tracks: number): CueLine[] {
  const out: CueLine[] = [];
  let last: Pos | null = null;
  for (const l of lines) {
    const at = parsePos(l.at)!;
    if (!inPart(part, at) || !hasText(blockAt(book, at)?.text ?? '')) continue;
    if (l.track > tracks) continue;
    if (last && cmp(at, last) <= 0) continue;
    out.push(l);
    last = at;
  }
  return out;
}

/** What the model gets to score part n, the book cut down to `level` (kimi.ts, context). */
function partUser(book: Book, tracks: CatalogTrack[], plan: string, n: number, level: number): string[] {
  const part = book.parts[n - 1];
  return [
    ...base(book, tracks, n, level),
    `# The plan for the whole book\n\n${plan}`,
    `# Your task: part ${n}\n\nPart ${n} is paragraphs ${posText(part.from)} to ${posText(part.to)}. Here it is again:\n\n${text(book, n)}\n\n${PART_TASK}`,
  ];
}

/** One call plans the score for the whole book. Saved to music/plan.txt. */
async function makePlan(book: Book, tracks: CatalogTrack[], lb: Balancer, led: MusicLedger): Promise<string> {
  const { reply, rung } = await lb.chat((level) => ask([...base(book, tracks, null, level), `# Your task: the plan\n\n${PLAN_TASK}`]), { book: book.key, music: 'plan' });
  const plan = reply.text.trim();
  writeFileSync(planFile(book), `${plan}\n`);
  led.plan = done(rung.name, reply.secs);
  saveLedger(book, led);
  console.log(`  music plan: ${rung.name}, ${mins(reply.secs)}`);
  return plan;
}

/** Every part's lines, fixed once where check finds problems. */
async function scoreParts(book: Book, tracks: CatalogTrack[], plan: string, lb: Balancer, led: MusicLedger) {
  const todo = book.parts.filter((p) => p.words > 0 && !existsSync(partFile(book, p.n))).map((p) => p.n);
  if (todo.length) {
    console.log(`${book.title}: scoring parts ${todo.join(', ')}, all at once`);
    const results = await Promise.allSettled(todo.map(async (n) => {
      const { reply, rung } = await lb.chat((level) => ask(partUser(book, tracks, plan, n, level)), { book: book.key, music: n });
      writeFileSync(partFile(book, n), reply.text);
      led.parts[n] = done(rung.name, reply.secs);
      saveLedger(book, led);
      const said = parseCues(reply.text);
      console.log(`  music part ${n}: ${rung.name}, ${mins(reply.secs)}; ${said.lines.length} cues`);
    }));
    const failed = todo.filter((_, i) => results[i].status === 'rejected');
    results.forEach((r, i) => {
      if (r.status === 'rejected') console.log(`  music part ${todo[i]}: no answer (${r.reason instanceof Error ? r.reason.message : String(r.reason)})`);
    });
    if (failed.length) throw new Error(`${book.title}: music for parts ${failed.join(', ')} failed. Run music again to retry just those.`);
  }
  if (led.fixed) return;

  musicStage.set(book.key, 'Fixing what the check found');
  let model = '';
  let secs = 0;
  for (const part of book.parts) {
    if (part.words <= 0) continue;
    for (let round = 1; round <= FIX_ROUNDS; round++) {
      const answer = readFileSync(partFile(book, part.n), 'utf8');
      const said = parseCues(answer);
      const problems = cueProblems(book, part, said.lines, said.odd, tracks.length);
      if (!problems.length) break;
      const user = (level: number) => [
        ...partUser(book, tracks, plan, part.n, level),
        `# Your lines\n\n${answer.trim()}`,
        `# Fix them\n\n${FIX_TASK}\n\n${problems.join('\n')}`,
      ];
      try {
        const fixed = await lb.chat((level) => ask(user(level)), { book: book.key, music: `fix-${part.n}`, round });
        writeFileSync(partFile(book, part.n), fixed.reply.text);
        model = fixed.rung.name;
        secs += fixed.reply.secs;
        console.log(`  music part ${part.n}, fix: ${fixed.rung.name}, ${problems.length} problems before`);
      } catch (e) {
        console.log(`  music part ${part.n}, fix: no answer (${e instanceof Error ? e.message : String(e)}); its good lines stay`);
      }
    }
  }
  led.fixed = done(model || (led.plan?.model ?? ''), secs);
  saveLedger(book, led);
}

/** The cues from every part's good lines, with a change only where the music changes, and the tracks they play. */
export function buildScore(book: Book, tracks: CatalogTrack[], answers: Map<number, string>): Score {
  const all: CueLine[] = [];
  for (const part of book.parts) {
    const answer = answers.get(part.n);
    if (answer === undefined) continue;
    all.push(...goodLines(book, part, parseCues(answer).lines, tracks.length));
  }
  const used: number[] = [];
  const cues: Score['cues'] = [];
  // Silence until the first track: no cue is needed for it.
  let playing = 0;
  let looping = false;
  for (const l of all) {
    if (l.track === playing && l.loop === looping) continue;
    if (l.track === 0 && playing === 0) continue;
    playing = l.track;
    looping = l.loop;
    const at = parsePos(l.at)!;
    let index = -1;
    if (l.track > 0) {
      index = used.indexOf(l.track);
      if (index < 0) {
        used.push(l.track);
        index = used.length - 1;
      }
    }
    cues.push([at[0], at[1], index, l.loop ? 1 : 0]);
  }
  return {
    made: new Date().toISOString(),
    tracks: used.map((n) => {
      const t = tracks[n - 1];
      return { id: t.id, title: t.title, source: t.source, seconds: t.seconds, role: t.use.slice(0, USE_CHARS) };
    }),
    cues,
  };
}

/** Who scored the book, for its file's "by": Gemini for the soundtrack, then the NVIDIA models by their long names. */
export function musicBy(book: { key: string }): string {
  const l = musicLedger(book);
  const steps = [l.plan, ...Object.values(l.parts), l.fixed].filter((d): d is Done => !!d && !!d.model);
  const models = [...new Set(steps.map((d) => d.model))].map(longName);
  return ['Gemini', ...models].join(' and ');
}

/**
 * Scores a book: its series' soundtrack first (gathered or brought up to date), then the plan,
 * every part, a fix where check finds problems, and the tracks it uses into the file store.
 * flags: again (start over).
 */
export async function scoreBook(b: QueueBook, book: Book, lb: Balancer, flags: Record<string, string | true> = {}): Promise<Score> {
  const tag = book.title;
  if (flags.again) {
    rmSync(dirOf(book), { recursive: true, force: true });
    rmSync(musicLedgerFile(book), { force: true });
    rmSync(scoreFile(book), { force: true });
  }
  if (existsSync(scoreFile(book))) {
    console.log(`${tag}: its music is done already`);
    return readJson<Score>(scoreFile(book));
  }
  mkdirSync(dirOf(book), { recursive: true });
  const led = musicLedger(book);

  // The soundtrack as it was when this book's score started, so its numbers keep their tracks.
  let tracks: CatalogTrack[];
  if (existsSync(tracksFile(book))) {
    tracks = readJson<CatalogTrack[]>(tracksFile(book));
  } else {
    musicStage.set(book.key, GATHERING);
    const s = await soundtrackFor(seriesName(b));
    tracks = s.tracks;
    writeJson(tracksFile(book), tracks);
  }

  musicStage.set(book.key, 'Planning the score');
  let plan: string;
  if (led.plan && existsSync(planFile(book))) plan = readFileSync(planFile(book), 'utf8').trim();
  else plan = await makePlan(book, tracks, lb, led);

  musicStage.set(book.key, 'Scoring, part by part');
  await scoreParts(book, tracks, plan, lb, led);

  const answers = new Map<number, string>();
  for (const p of book.parts) {
    if (existsSync(partFile(book, p.n))) answers.set(p.n, readFileSync(partFile(book, p.n), 'utf8'));
  }
  const score = buildScore(book, tracks, answers);

  if (flags['no-store']) {
    console.log(`${tag}: its tracks aren’t kept in the file store (--no-store)`);
  } else {
    musicStage.set(book.key, 'Keeping its tracks in the file store');
    for (const t of score.tracks) await store(t.id);
    led.stored = new Date().toISOString();
    saveLedger(book, led);
  }

  writeJson(scoreFile(book), score);
  musicStage.delete(book.key);
  const silences = score.cues.filter((c) => c[2] < 0).length;
  console.log(`${tag}: music done: ${score.cues.length} cues (${silences} of them silence), ${score.tracks.length} tracks`);
  return score;
}
