import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { format } from 'node:util';
import type pg from 'pg';
import { MARKER_TASKS, nextFirst, queueKey, type AdminState } from '../../shared/src/admin.ts';
import type { AiFile } from '../../shared/src/ai.ts';
import type { Command } from '../../server/src/lib/admin.ts';
import { recordError, recordLive, recordOk } from '../../server/src/jobs/runs.ts';
import { Balancer, jitter } from './balancer.ts';
import { castPass } from './cast.ts';
import { addSeriesVoices, seriesVoices, voicesIntoCast, type Voices } from './casting.ts';
import { control, controlLoop, readControl } from './control.ts';
import { prodClient, prodPool } from './env.ts';
import { castFromFile, fetchBook } from './fetch.ts';
import { waitingForLimits } from './harness.ts';
import { castsOnServer, checkFile, fileOnServer, live, loadOne, onServer, replace, upsert, wanted } from './import.ts';
import { current, newJob, note, pauses, paused, runIn, stopIfStopped, whilePaused, type JobCtx, type LogLine } from './jobs.ts';
import { castByFile, castOf, fitBy, LADDER, marksLedger, mins, notesBy, notesLedger, notesLedgerFile, PRIMARY, setFirst } from './kimi.ts';
import { bookDir, isFetched, loadBook, marksFiles, OUT, QUEUE, readJson, WORK, writeJson, type Book, type QueueBook } from './lib.ts';
import { listBooks } from './library.ts';
import { markBook, stageOf } from './mark.ts';
import { GATHERING, musicBy, musicLedger, musicLedgerFile, musicStage, noDownloads, noMusic, saveSoundtrack, scoreBook } from './music.ts';
import { nvidiaKey } from './nim.ts';
import { writeNotes } from './notes.ts';
import { revisitOf } from './pack.ts';
import { noHarness, servesGemini } from './proxy.ts';
import { researchBook, researched, seriesName } from './research.ts';
import { dropUpload, fits, readUpload, uploads } from './uploads.ts';
import { validate, type Notes } from './validate.ts';
import { store } from './youtube.ts';

/*
 * The marker: mark.ts, music.ts and notes.ts for every book whose AI switch is on, for good, with
 * no one at the keyboard. The server's worker runs it (server/src/jobs/marker.ts); npm --prefix ai
 * run marker runs it here. With no NVIDIA key it stays off.
 *
 * About once a minute it lists the books. A book with nothing on the server yet gets its voice
 * marks: fetched, researched on the web by the harness (research.ts) when Antigravity is here, its
 * cast read from the book with that research (cast.ts), every part marked, everyone given their
 * voices (casting.ts), packed and imported, up to 4 books at once (or what the admin page says), the books being read first.
 * A book marked before voices were picked gets them at random instead, first thing each round. Only when no book is being marked does
 * background music start, for books that have none (music.ts), when the harness, yt-dlp and ffmpeg
 * are all here. Only when no book's music is being scored do Revisit notes start, for books that
 * have none. Music and notes both go to books someone is reading first, the most recently read at
 * the top, then the rest, the oldest added first, and through a series from its earliest volume:
 * each volume's notes build on the ones before, and its soundtrack starts with the first. A book
 * marked before there was research gets it before its music or notes, and keeps the cast its marks
 * were made with. A book added later still comes first: while one is being marked, the other calls
 * wait.
 *
 * A book being researched on the web, or gathering its series' soundtrack, isn't using NVIDIA, so
 * nothing waits behind it. That matters most while every Antigravity account is out of Gemini and
 * the harness waits for the first to fill again (harness.ts), which can be days. With no Antigravity
 * account connected at all, no music starts: it waits for one, and the status page says so.
 *
 * Music scored somewhere else and uploaded from the admin page (uploads.ts) goes in whatever else
 * is running, since it needs no model: the series' soundtrack is kept, the tracks the score plays
 * are downloaded and stored, and the score goes into the book's file.
 *
 * A call that fails is asked again by the balancer, after a wait that doubles each time, with
 * jitter, for as long as it takes. A book that fails waits 2 minutes, then 4, 8 and so on up to an
 * hour (or what the admin page says), with jitter, and carries on where it stopped. How it goes is in job_runs as "ai-marker",
 * for the admin page, along with what it's on right now: each book, its task, its step and how
 * many of its parts are done, and the queue (liveLoop). Nothing it prints has a book's text in it.
 *
 * The admin page has its say (control.ts): it pauses the marker or one task, changes how many books
 * go at once, which model goes first and whether there's research, keeps books back or asks for
 * them next, and stops a book or has it do its step again. Each book's work runs as a job (jobs.ts),
 * so the page sees the step it's on, its parts, the model and account its calls are on, and what it
 * printed, every second while the page is open.
 */

/** How often it looks for work. How many books it marks, scores and writes notes for at once is the admin page's (control.ts). */
const POLL_S = 60;
/** A book that failed waits this long, doubling each time it fails again, up to the admin page's longest wait. */
const RETRY_FIRST_S = 120;
/** A volume that has failed this many times in a row stops holding up the volumes after it. */
const STUCK = 5;
/** Its name in job_runs, and how often it says it's alive there when there's nothing new. */
const JOB = 'ai-marker';
const ALIVE_S = 3600;
/** How often the status page's live view is brought up to date, and how often it's written anyway. */
const LIVE_S = 10;
const LIVE_ANYWAY_S = 60;
/** While the admin page is open (it says so every 20 s), the live view goes every second. */
const WATCHED_LIVE_S = 1;
const WATCHED_FOR_S = 45;
/** How many lines of a book's log the page gets. */
const LOG_SHOWN = 20;

export type Phase = 'marks' | 'music' | 'notes';

/**
 * What the server has for a book: when it was made, by whom, how many Revisit entries, whether it
 * has music, and whether everyone in its cast but the generic speakers has voices.
 */
export interface OnServer {
  made: string;
  by: string;
  notes: number;
  music?: boolean;
  voiced?: boolean;
}

interface Balancers {
  lb: Balancer;
  top: Balancer;
  music: Balancer;
  notes: Balancer;
  review: Balancer;
}

interface Failed {
  count: number;
  next: number;
  why?: string;
}

/** A book being worked on: what for, since when, and its parts once it's fetched. */
interface Job {
  b: QueueBook;
  phase: Phase;
  since: number;
  parts?: number[];
  /** What its calls are doing (jobs.ts). */
  ctx: JobCtx;
  /** The step it's on, by the admin page's key, and since when. */
  step: string;
  stepSince: number;
  /** Cut off from the admin page: stopped, or to do its step again. */
  cut?: 'stop' | 'redo';
}

/**
 * Books being worked on, by SHA-256; books that failed, with when to try them again and why; and
 * books finished since the last look at the server, which hasn't caught up with them yet.
 */
const running = new Map<string, Job>();
export const failures = new Map<string, Failed>();
/** Music's failures, apart, so a book whose music keeps failing still gets its notes. */
export const musicFailures = new Map<string, Failed>();
const ended = new Set<string>();
/** Books being researched on the web right now, by key. */
const researching = new Set<string>();
/**
 * What the marker can do here besides marks and notes, set when it starts: research needs the
 * harness; music the harness, yt-dlp and ffmpeg; uploaded music only yt-dlp and ffmpeg.
 */
export const can = { research: false, music: false, uploads: false };
/** Whether an Antigravity account serves Gemini, looked at each round: music waits for one. */
let accountHere = false;
/** Uploaded music going in, by book key: how many of its tracks are stored. */
const uploading = new Map<string, { done: number; of: number }>();
/** The last look at the books and the server. */
let seen: { books: QueueBook[]; server: Map<string, OnServer> } | null = null;
/** Until when the admin page is open, as it last said. */
let watchedUntil = 0;
/** Set when the admin page wants a round now, rather than at the next look. */
let woken = false;
let wakeUp: (() => void) | null = null;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clock = () => new Date().toISOString().slice(0, 16).replace('T', ' ');
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The marker's balancers: the pipeline (cli/pipeline.ts) uses them too. */
export function balancers(): Balancers {
  const patient = { waitForTopS: 300, strikesToFall: 3, maxTries: Infinity, patient: true };
  const kimiOnly = { waitForTopS: Infinity, strikesToFall: Infinity, patient: true };
  return {
    // The cast pass and the marks: Kimi K3, and Nemotron while Kimi is down (kimi.ts).
    lb: new Balancer(LADDER, patient),
    // Nemotron's parts again, by Kimi only. After 6 tries a part keeps Nemotron's marks.
    top: new Balancer(PRIMARY, { ...kimiOnly, maxTries: 6 }),
    // Music and notes, which wait while a book is being marked.
    music: new Balancer(LADDER, { ...patient, low: true }),
    notes: new Balancer(LADDER, { ...patient, low: true }),
    // The notes' read-through, Kimi's however long it takes.
    review: new Balancer(PRIMARY, { ...kimiOnly, maxTries: Infinity, low: true }),
  };
}

/** What a book still needs: marks (nothing on the server yet), notes, or nothing. */
export function needs(b: QueueBook, server: Map<string, OnServer>): Phase | null {
  const row = server.get(b.sha256);
  if (!row) return 'marks';
  if (row.notes > 0) return null;
  // Notes were written and came out empty (a book with no one to note): they're done.
  if (/\bnotes (and research )?by\b/.test(row.by)) return null;
  return 'notes';
}

/** Whether a book with marks on the server still needs its music, when music can be made here. */
export function needsMusic(b: QueueBook, server: Map<string, OnServer>): boolean {
  if (!can.music) return false;
  const row = server.get(b.sha256);
  if (!row) return false;
  return !row.music;
}

function failuresOf(phase: Phase): Map<string, Failed> {
  if (phase === 'music') return musicFailures;
  return failures;
}

/** Failed lately, and not due to be tried again yet. */
function resting(b: QueueBook, phase: Phase): boolean {
  const f = failuresOf(phase).get(b.sha256);
  if (!f) return false;
  return f.next > Date.now();
}

function stuck(b: QueueBook, phase: Phase): boolean {
  const f = failuresOf(phase).get(b.sha256);
  if (!f) return false;
  return f.count >= STUCK;
}

/** Whether o is an earlier volume of b's series. */
function earlier(o: QueueBook, b: QueueBook): boolean {
  if (o.sha256 === b.sha256) return false;
  if (!o.series || !b.series) return false;
  if (o.series.toLowerCase() !== b.series.toLowerCase()) return false;
  if (o.seriesIndex == null || b.seriesIndex == null) return false;
  return o.seriesIndex < b.seriesIndex;
}

/**
 * Books to start marking, in the queue's order (being read first). A later volume waits for an
 * earlier one's cast, so everyone keeps their id and voice, unless that one is stuck.
 */
export function toMark(books: QueueBook[], server: Map<string, OnServer>): QueueBook[] {
  const out: QueueBook[] = [];
  for (const b of books) {
    if (needs(b, server) !== 'marks' || running.has(b.sha256) || resting(b, 'marks')) continue;
    if (castFirst(b, books, server)) continue;
    out.push(b);
  }
  return out;
}

/** The earlier volume whose cast a book's marks wait for, or null. */
function castFirst(b: QueueBook, books: QueueBook[], server: Map<string, OnServer>): QueueBook | null {
  const first = books.find((o) => earlier(o, b) && needs(o, server) === 'marks' && !existsSync(castByFile(o)) && !stuck(o, 'marks'));
  return first ?? null;
}

/** Of the books that need a phase, the earliest volume of b's series that goes before it, or null. */
function seriesBefore(b: QueueBook, want: QueueBook[], phase: Phase): QueueBook | null {
  const before = want.filter((o) => earlier(o, b) && !stuck(o, phase)).sort((x, y) => x.seriesIndex! - y.seriesIndex!);
  return before[0] ?? null;
}

/** A volume as the admin page names it: Vol. 3, or its title when it has no number. */
function volumeOf(b: QueueBook): string {
  if (b.seriesIndex == null) return b.title;
  return `Vol. ${b.seriesIndex}`;
}

/** Being read first, the most recently read at the top, then the rest, the oldest added first. */
export function notesOrder(a: QueueBook, b: QueueBook): number {
  if (a.started !== b.started) return a.started ? -1 : 1;
  if (a.started) return b.lastRead.localeCompare(a.lastRead);
  return a.added.localeCompare(b.added);
}

/**
 * Of the books that need this phase, the ones to start, in notesOrder. A series goes from its
 * earliest volume that needs it, one volume at a time. A stuck volume is still tried, but no
 * longer holds up the ones after it.
 */
function seriesFirst(want: QueueBook[], phase: Phase): QueueBook[] {
  const inOrder = want.slice().sort(notesOrder);
  const out: QueueBook[] = [];
  for (const b of inOrder) {
    const first = seriesBefore(b, inOrder, phase) ?? b;
    if (running.has(first.sha256) || resting(first, phase) || out.includes(first)) continue;
    out.push(first);
  }
  return out;
}

/** Books to start notes for, a series from its earliest volume, since each volume's notes build on the ones before. */
export function toNote(books: QueueBook[], server: Map<string, OnServer>): QueueBook[] {
  return seriesFirst(books.filter((b) => needs(b, server) === 'notes'), 'notes');
}

/** Books to start music for, the same way: a series' soundtrack starts with its first volume. */
export function toMusic(books: QueueBook[], server: Map<string, OnServer>): QueueBook[] {
  return seriesFirst(books.filter((b) => needsMusic(b, server)), 'music');
}

/** Keeps ai/out the same as the server, so a later volume reads what earlier ones showed and starts from their cast. */
async function syncOut(db: pg.Client, server: Map<string, OnServer>) {
  for (const [sha256, row] of server) {
    const file = join(OUT, `${sha256}.json`);
    if (existsSync(file) && readJson<AiFile>(file).made >= row.made) continue;
    const data = await fileOnServer(db, sha256);
    if (data) writeJson(file, data);
  }
}

/** A book's new file from ai/out into ai_notes, while some library with the switch on holds it. */
async function importFile(sha256: string) {
  const f = loadOne(sha256);
  const db = await prodClient('breader-ai-marker');
  try {
    await db.query('BEGIN');
    const ok = await wanted(db, [sha256]);
    if (ok.has(sha256)) await upsert(db, f);
    await db.query('COMMIT');
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    await db.end();
  }
}

/** Whether NVIDIA is busy with marks: a book being marked that isn't being researched on the web, while marks aren't paused. */
function marking(): boolean {
  if (paused('marks')) return false;
  return [...running.values()].some((j) => j.phase === 'marks' && !researching.has(j.b.key));
}

/** Holds music's and notes' calls back while a book is being marked, so a new book's marks go first. */
function hold() {
  Balancer.holdLow = marking();
}

/**
 * A book's research from the web, when the harness is here and it has none. Research that fails
 * fails the book's job, to be tried again later, until the book is stuck (STUCK failures in a
 * row): then the job carries on without it, so an Antigravity sign-in that broke can't hold a book
 * up for good.
 */
async function research(b: QueueBook, phase: Phase) {
  if (!researchOn() || researched(b)) return;
  researching.add(b.key);
  hold();
  try {
    await researchBook(b);
  } catch (e) {
    if (!stuck(b, phase)) throw e;
    console.log(`${clock()} ${b.title}: research failed again, so its ${phase} carry on without it: ${message(e)}`);
  } finally {
    researching.delete(b.key);
    hold();
  }
}

/** Whether there's research from the web: the harness is here, and the admin page has it on. */
function researchOn(): boolean {
  return can.research && control.marker.research;
}

async function markJob(b: QueueBook, lbs: Balancers) {
  if (!isFetched(b.key)) await fetchBook(b);
  const book = loadBook(b.key);
  await research(b, 'marks');
  stopIfStopped();
  if (!existsSync(castByFile(book))) await castPass(book, lbs.lb);
  try {
    await markBook(b.key, lbs.lb, lbs.top, {});
    stopIfStopped();
    await importFile(b.sha256);
  } finally {
    stageOf.delete(b.key);
  }
}

/**
 * The cast the notes use has to be the one the marks were made with, so a person's id means the
 * same in both. A book marked here has it already; one marked elsewhere gets it from its file.
 */
export function matchCast(book: Book, row: AiFile) {
  const file = join(bookDir(book.key), 'cast.json');
  if (existsSync(file)) {
    const here = castOf(book).people.map((p) => p.id);
    const marked = row.voices.cast.map((p) => p.id);
    if (marked.every((id, i) => here[i] === id)) return;
  }
  writeJson(file, castFromFile(row));
}

/** The server's "by" with who did the notes or the music, before the credit for the research. */
export function byWith(by: string, kind: 'notes' | 'music', who: string): string {
  const parts = by.split('; ').filter((p) => !p.startsWith(`${kind} `));
  const research = parts.findIndex((p) => /^(research|cast) by /.test(p));
  const credit = `${kind} by ${who}`;
  if (research < 0) return fitBy([...parts, credit]);
  return fitBy([...parts.slice(0, research), credit, ...parts.slice(research)]);
}

export const byWithNotes = (by: string, who: string) => byWith(by, 'notes', who);

/** The server's file with this book's notes in it, and anyone the notes added to the cast. */
export function withNotes(row: AiFile, book: Book): AiFile {
  const errors = validate(book, false).errors.filter((e) => e.startsWith('notes.json'));
  if (errors.length) throw new Error(`its notes have ${errors.length} errors. The first: ${errors[0]}`);
  const notes = readJson<Notes>(join(bookDir(book.key), 'notes.json'));
  const known = new Set(row.voices.cast.map((p) => p.id));
  const added = castOf(book).people.filter((p) => !known.has(p.id)).map((p) => ({ id: p.id, name: p.name, g: p.gender }));
  return {
    ...row,
    made: new Date().toISOString(),
    by: byWithNotes(row.by, notesBy(book)),
    revisit: revisitOf(notes),
    voices: { ...row.voices, cast: [...row.voices.cast, ...added] },
  };
}

/** The server's file with this book's music in it, scored by `who`. */
export function withMusic(row: AiFile, music: NonNullable<AiFile['music']>, who: string): AiFile {
  return {
    ...row,
    made: new Date().toISOString(),
    by: byWith(row.by, 'music', who),
    music: { tracks: music.tracks, cues: music.cues },
  };
}

/** A book's whole file as the server has it. */
async function serverFile(b: QueueBook): Promise<AiFile> {
  const db = await prodClient('breader-ai-marker');
  let row: AiFile | null;
  try {
    row = await fileOnServer(db, b.sha256);
  } finally {
    await db.end();
  }
  if (!row) throw new Error('its file left the server');
  return row;
}

/** The book, fetched if it isn't, and checked to read the same as when it was marked, so what's added lands on the right paragraphs. */
async function sameBook(b: QueueBook, row: AiFile, what: string): Promise<Book> {
  if (!isFetched(b.key)) await fetchBook(b);
  const book = loadBook(b.key);
  if (book.sections.map((s) => s.print).join(' ') !== row.sections.join(' ')) {
    throw new Error(`it reads differently here than when it was marked, so its ${what} would land on the wrong paragraphs`);
  }
  return book;
}

/** A book's file, checked, into ai/out and onto the server in place of the one made at `was`. */
async function putBack(f: AiFile, was: string, what: string) {
  const c = checkFile(`${f.sha256}.json`, f);
  if (c.problems.length) throw new Error(`its file with ${what} has problems. The first: ${c.problems[0]}`);
  writeJson(join(OUT, `${f.sha256}.json`), f);
  const write = await prodClient('breader-ai-marker');
  try {
    const ok = await replace(write, f, was);
    if (!ok) throw new Error(`its file on the server changed meanwhile, so its ${what} go in next time`);
  } finally {
    await write.end();
  }
}

/** Each series' books as they were last looked at for voices, sha256@made, so it's looked at again only once one changes. */
const voicesSeen = new Map<string, string>();

/** The books by series, each in volume order; a book in none is a series of its own. */
export function bySeries(books: QueueBook[]): Map<string, QueueBook[]> {
  const out = new Map<string, QueueBook[]>();
  for (const b of books) {
    let key = `book:${b.sha256}`;
    if (b.series) key = `series:${b.series.toLowerCase()}`;
    const list = out.get(key) ?? [];
    list.push(b);
    out.set(key, list);
  }
  const volume = (b: QueueBook) => b.seriesIndex ?? 0;
  for (const list of out.values()) list.sort((x, y) => volume(x) - volume(y) || x.title.localeCompare(y.title));
  return out;
}

/**
 * Everyone's voices the same in every book of a series, as in the first volume to give them any
 * (casting.ts seriesVoices), and voices at random for anyone without: in books marked before the
 * marker picked them, or given people since by their notes. Into the server's file, ai/out and the
 * book's cast.json, so a later volume keeps them. A series is looked at again only once one of its
 * books changes. A book being worked on waits for the next round.
 */
async function voicesForOld(books: QueueBook[], server: Map<string, OnServer>) {
  const due: Array<{ key: string; list: QueueBook[]; seen: string }> = [];
  for (const [key, list] of bySeries(books.filter((b) => server.has(b.sha256)))) {
    const seen = list.map((b) => `${b.sha256}@${server.get(b.sha256)!.made}`).join(',');
    if (voicesSeen.get(key) !== seen) due.push({ key, list, seen });
  }
  if (!due.length) return;
  const db = await prodClient('breader-ai-marker');
  try {
    for (const { key, list, seen } of due) {
      if (await voicesThrough(db, list)) voicesSeen.set(key, seen);
    }
  } finally {
    await db.end();
  }
}

/** One series' voices made the same through it, volume by volume. True when nothing was left for later. */
export async function voicesThrough(db: pg.Client, list: QueueBook[]): Promise<boolean> {
  const casts = await castsOnServer(db, list.map((b) => b.sha256));
  const earlier = new Map<string, Voices>();
  let done = true;
  for (const b of list) {
    let cast = casts.get(b.sha256);
    if (!cast) continue;
    if (seriesVoices(cast, earlier).changed) {
      const put = await voicesInto(db, b, earlier);
      if (put) cast = put;
      else done = false;
    }
    addSeriesVoices(earlier, cast);
  }
  return done;
}

/** A book's voices as the series has them, into its file on the server and here: its cast then, or null when it has to wait. */
async function voicesInto(db: pg.Client, b: QueueBook, earlier: Map<string, Voices>): Promise<AiFile['voices']['cast'] | null> {
  if (running.has(b.sha256)) return null;
  const row = await fileOnServer(db, b.sha256);
  if (!row) return null;
  const { cast, changed } = seriesVoices(row.voices.cast, earlier);
  // A new time, so the app fetches the file again.
  const f = { ...row, voices: { ...row.voices, cast }, made: new Date().toISOString() };
  const c = checkFile(`${f.sha256}.json`, f);
  if (c.problems.length) {
    console.log(`${clock()} ${b.title}: its file with voices has problems, so its voices stay as they are. The first: ${c.problems[0]}`);
    return null;
  }
  const ok = await replace(db, f, row.made);
  if (!ok) return null;
  writeJson(join(OUT, `${f.sha256}.json`), f);
  voicesIntoCast(b, f);
  console.log(`${clock()} ${b.title}: voices for ${changed} people, as the series has them or at random`);
  return cast;
}

/** Notes for a book with marks on the server, made here or anywhere, into its file on the server. */
async function notesJob(b: QueueBook, lbs: Balancers) {
  const row = await serverFile(b);
  const book = await sameBook(b, row, 'notes');
  await research(b, 'notes');
  stopIfStopped();
  matchCast(book, row);
  await writeNotes(b.key, lbs.notes, lbs.review, { 'no-pack': true });
  stopIfStopped();
  await putBack(withNotes(row, book), row.made, 'notes');
}

/** Music for a book with marks on the server, made here or anywhere, into its file on the server. */
async function musicJob(b: QueueBook, lbs: Balancers) {
  const row = await serverFile(b);
  const book = await sameBook(b, row, 'music');
  await research(b, 'music');
  stopIfStopped();
  try {
    const score = await scoreBook(b, book, lbs.music);
    stopIfStopped();
    await putBack(withMusic(row, score, musicBy(book)), row.made, 'music');
  } finally {
    musicStage.delete(b.key);
  }
}

/**
 * Music uploaded from the admin page, into a book's file: the series' soundtrack kept under the
 * name this book's series goes by here, so it's never gathered again, every track the score plays
 * downloaded and stored, then the score into the file, which has to read as the one it was scored
 * on. The upload is let go once it's in.
 */
async function uploadJob(b: QueueBook) {
  const progress = { done: 0, of: 0 };
  uploading.set(b.key, progress);
  try {
    musicStage.set(b.key, 'Reading the uploaded music');
    const upload = await readUpload(b.sha256);
    const row = await serverFile(b);
    if (!fits(upload, row)) throw new Error('it reads differently here than where its uploaded music was scored, so the music would land on the wrong paragraphs');
    saveSoundtrack({ ...upload.soundtrack, name: seriesName(b) });
    progress.of = upload.score.tracks.length;
    for (const t of upload.score.tracks) {
      await whilePaused();
      musicStage.set(b.key, `Keeping its tracks in the file store, ${progress.done + 1} of ${progress.of}`);
      await store(t.id);
      progress.done++;
    }
    stopIfStopped();
    musicStage.set(b.key, 'Saving');
    await putBack(withMusic(row, upload.score, upload.by), row.made, 'music');
    await dropUpload(b.sha256);
  } finally {
    musicStage.delete(b.key);
    uploading.delete(b.key);
  }
}

/**
 * Starts a book's work without waiting for it, as its job (jobs.ts). When it ends, job_runs hears
 * how it went. A book the admin page stopped, or sent back to do its step again, hasn't failed.
 */
function start(b: QueueBook, phase: Phase, work: () => Promise<void>, pool: pg.Pool) {
  const job: Job = { b, phase, since: Date.now(), ctx: newJob(b.key, b.title, phase), step: '', stepSince: Date.now() };
  running.set(b.sha256, job);
  hold();
  const t0 = Date.now();
  const run = async () => {
    console.log(`${clock()} ${b.title}: ${phase} start`);
    await work();
  };
  runIn(job.ctx, run)
    .then(async () => {
      failuresOf(phase).delete(b.sha256);
      running.delete(b.sha256);
      ended.add(b.sha256);
      console.log(`${clock()} ${b.title}: ${phase} done, in ${mins((Date.now() - t0) / 1000)}`);
      wake();
      await recordOk(pool, JOB, liveNow()).catch(() => {});
    })
    .catch(async (e: unknown) => {
      if (job.cut === 'stop') {
        console.log(`${clock()} ${b.title}: ${phase} stopped from the admin page`);
        return;
      }
      if (job.cut === 'redo') {
        undoStep(b, phase, job.step);
        failuresOf(phase).delete(b.sha256);
        console.log(`${clock()} ${b.title}: ${phase} does its step again, from the admin page`);
        wake();
        return;
      }
      const why = message(e);
      const list = failuresOf(phase);
      const f = list.get(b.sha256) ?? { count: 0, next: 0 };
      f.count++;
      const cap = control.marker.retryCapMinutes * 60;
      const secs = jitter(Math.min(cap, RETRY_FIRST_S * 2 ** (f.count - 1)));
      f.next = Date.now() + secs * 1000;
      f.why = why.slice(0, 300);
      list.set(b.sha256, f);
      console.log(`${clock()} ${b.title}: ${phase} failed (${f.count} in a row), again in ${mins(secs)}: ${why}`);
      await recordError(pool, JOB, new Error(`${b.title}: ${phase}: ${why}`)).catch(() => {});
    })
    .finally(() => {
      running.delete(b.sha256);
      hold();
    });
}

/** The parts a book is marked and noted in (the ones with words), read once it's fetched. */
function partsOf(job: Job): number[] | null {
  if (!job.parts && isFetched(job.b.key)) {
    job.parts = loadBook(job.b.key).parts.filter((p) => p.words > 0).map((p) => p.n);
  }
  return job.parts ?? null;
}

export interface Progress {
  step: string;
  /** Parts done, of the book's parts. */
  parts: number;
  of: number;
  /** Of the whole task, counting the steps before and after the parts as one part each: 0 to 100. */
  percent: number;
}

/** How far a book's music has got, from what's on disk. */
function musicProgress(key: string, parts: number[]): Progress {
  const led = musicLedger({ key });
  const done = parts.filter((n) => led.parts[n]).length;
  let steps = done;
  if (led.plan) steps++;
  if (led.stored) steps++;
  const percent = Math.floor((100 * steps) / (parts.length + 2));
  let step = musicStage.get(key);
  if (!step) {
    if (led.stored) step = 'Saving';
    else step = 'Getting ready';
  }
  return { step, parts: done, of: parts.length, percent };
}

/** How far uploaded music has got: its tracks stored, of the ones it plays, and then saving it counts as one more. */
function uploadProgress(key: string): Progress {
  const u = uploading.get(key)!;
  let percent = 0;
  if (u.of) percent = Math.floor((100 * u.done) / (u.of + 1));
  const step = musicStage.get(key) ?? 'Reading the uploaded music';
  return { step, parts: 0, of: 0, percent };
}

/** How far a book's marks, music or notes have got, from what's on disk. `parts` is null until it's fetched. */
export function progressOf(key: string, phase: Phase, parts: number[] | null): Progress {
  if (uploading.has(key)) return uploadProgress(key);
  if (!parts) return { step: 'Fetching the book', parts: 0, of: 0, percent: 0 };
  if (researching.has(key)) return { step: 'Researching it on the web', parts: 0, of: parts.length, percent: 0 };
  if (phase === 'music') return musicProgress(key, parts);

  if (phase === 'marks') {
    const marked = new Set(marksFiles(key));
    const done = parts.filter((n) => marked.has(n)).length;
    const cast = existsSync(castByFile({ key }));
    let steps = done;
    if (cast) steps++;
    const percent = Math.floor((100 * steps) / (parts.length + 2));
    // Once every part has its marks, markBook says which of its last steps it's on.
    let step = stageOf.get(key) ?? 'Checking the marks';
    if (!cast) step = 'Reading the cast from the book';
    else if (done < parts.length) step = 'Marking who speaks, part by part';
    return { step, parts: done, of: parts.length, percent };
  }

  const led = notesLedger({ key });
  const done = parts.filter((n) => led.parts[n]).length;
  let steps = done;
  if (led.roster) steps++;
  if (led.fixed) steps++;
  if (led.reviewed) steps++;
  const percent = Math.floor((100 * steps) / (parts.length + 3));
  let step = 'Saving';
  if (!led.roster) step = 'Listing who’s who';
  else if (done < parts.length) step = 'Writing notes, part by part';
  else if (!led.fixed) step = 'Checking the notes';
  else if (!led.reviewed) step = 'Reading them through as a reader would';
  return { step, parts: done, of: parts.length, percent };
}

/** Each task's steps, by the admin page's keys (frontend/src/admin/types.ts, STEPS), in order. */
const STEP_KEYS: Record<Phase, string[]> = {
  marks: ['fetch', 'research', 'cast', 'mark', 'check', 'redo', 'settle', 'voices', 'save'],
  music: ['fetch', 'research', 'gather', 'plan', 'score', 'check', 'store', 'save'],
  notes: ['fetch', 'research', 'roster', 'write', 'check', 'review', 'save'],
};
/** Music uploaded from the admin page goes through steps of its own. */
const UPLOAD_KEYS = ['read', 'store', 'save'];
/** The steps done part by part, whose parts the page shows one by one. */
const PART_STEPS = new Set(['mark', 'redo', 'score', 'write']);

/** The admin page's key for the step progressOf says a book is on. */
export function stepKey(phase: Phase, step: string, upload: boolean): string {
  if (upload) {
    if (step.startsWith('Keeping')) return 'store';
    if (step === 'Saving') return 'save';
    return 'read';
  }
  if (step === 'Fetching the book') return 'fetch';
  if (step === 'Researching it on the web') return 'research';
  if (step === 'Saving') return 'save';
  if (phase === 'marks') {
    if (step.startsWith('Reading the cast')) return 'cast';
    if (step.startsWith('Marking who speaks')) return 'mark';
    if (step.startsWith('Marking again')) return 'redo';
    if (step.startsWith('Settling')) return 'settle';
    if (step.startsWith('Casting')) return 'voices';
    return 'check';
  }
  if (phase === 'music') {
    if (step === GATHERING) return 'gather';
    if (step.startsWith('Planning')) return 'plan';
    if (step.startsWith('Scoring')) return 'score';
    if (step.startsWith('Fixing')) return 'check';
    if (step.startsWith('Keeping')) return 'store';
    // Getting ready: its file from the server, and the book.
    return 'fetch';
  }
  if (step.startsWith('Listing')) return 'roster';
  if (step.startsWith('Writing')) return 'write';
  if (step.startsWith('Checking')) return 'check';
  return 'review';
}

/** A book's part as the admin page shows it: done, being done, done by the backup model, or still to do. */
export type PartState = 'done' | 'now' | 'backup' | 'wait';

/** Which of a book's parts are done, from what's on disk: for its marks, the model each was done by. */
function doneParts(key: string, phase: Phase): Map<number, string> {
  const out = new Map<number, string>();
  if (phase === 'marks') {
    const led = marksLedger({ key } as Book);
    for (const n of marksFiles(key)) out.set(n, led[n]?.model ?? '');
    return out;
  }
  let parts: Record<number, unknown> = notesLedger({ key }).parts;
  if (phase === 'music') parts = musicLedger({ key }).parts;
  for (const n of Object.keys(parts)) out.set(Number(n), '');
  return out;
}

/** Every part of a book on a step done part by part, in order. */
export function partStates(j: { b: { key: string }; phase: Phase; ctx: JobCtx }, parts: number[]): PartState[] {
  const done = doneParts(j.b.key, j.phase);
  const primaries = new Set(PRIMARY.map((r) => r.name));
  return parts.map((n) => {
    if (j.ctx.parts.has(n)) return 'now';
    const model = done.get(n);
    if (model === undefined) return 'wait';
    if (j.phase === 'marks' && model && !primaries.has(model)) return 'backup';
    return 'done';
  });
}

/** A book being worked on, as the admin page shows it, step by step. */
export interface Working {
  /** The book file's SHA-256. */
  id: string;
  title: string;
  task: Phase;
  /** Music uploaded from the admin page, going in. */
  upload?: boolean;
  step: string;
  /** Steps it doesn't take: research, while it's off. */
  skipped: string[];
  since: string;
  stepSince: string;
  parts: PartState[];
  model: string | null;
  account: string | null;
  calls: number;
  /** What it printed, newest first. */
  log: LogLine[];
}

function workingOf(j: Job): Working {
  const upload = uploading.has(j.b.key);
  const parts = partsOf(j);
  const step = stepKey(j.phase, progressOf(j.b.key, j.phase, parts).step, upload);
  if (step !== j.step) {
    j.step = step;
    j.stepSince = Date.now();
  }
  // Every step before this one is done, short ones too, however long ago: only research is ever left out.
  const skipped: string[] = [];
  if (!upload && !researchOn()) skipped.push('research');
  const w: Working = {
    id: j.b.sha256,
    title: j.b.title,
    task: j.phase,
    step,
    skipped,
    since: new Date(j.since).toISOString(),
    stepSince: new Date(j.stepSince).toISOString(),
    parts: [],
    model: j.ctx.model,
    account: j.ctx.account,
    calls: j.ctx.calls,
    log: j.ctx.log.slice(-LOG_SHOWN).reverse(),
  };
  if (upload) w.upload = true;
  if (parts && PART_STEPS.has(step)) w.parts = partStates(j, parts);
  return w;
}

/**
 * Clears what a book's step made, so it does it again from its start (the admin page's Redo step).
 * A step that keeps nothing of its own, or keeps it with its series (research, the soundtrack),
 * just starts again, carrying on its chat.
 */
function undoStep(b: QueueBook, phase: Phase, step: string) {
  const dir = bookDir(b.key);
  const gone = (...names: string[]) => {
    for (const name of names) rmSync(join(dir, name), { recursive: true, force: true });
  };
  if (step === 'research') gone('research-by.json', 'web.md');
  if (phase === 'marks') {
    if (step === 'cast') gone('cast-by.json', 'cast.json');
    if (step === 'mark') gone('marks', 'marked-by.json', 'failed');
    return;
  }
  if (phase === 'music') {
    if (uploading.has(b.key)) return;
    const led = musicLedger({ key: b.key });
    if (step === 'gather') gone('music/tracks.json');
    if (step === 'plan') {
      gone('music/plan.txt');
      delete led.plan;
    }
    if (step === 'score') {
      gone(...partFiles(join(dir, 'music')).map((f) => `music/${f}`));
      led.parts = {};
    }
    if (step === 'check') delete led.fixed;
    if (step === 'store') delete led.stored;
    if (existsSync(musicLedgerFile({ key: b.key }))) writeJson(musicLedgerFile({ key: b.key }), led);
    return;
  }
  const led = notesLedger({ key: b.key });
  if (step === 'roster') {
    gone('notes/roster.txt');
    delete led.roster;
  }
  if (step === 'write') {
    gone(...partFiles(join(dir, 'notes')).map((f) => `notes/${f}`));
    led.parts = {};
  }
  if (step === 'check') delete led.fixed;
  if (step === 'review') delete led.reviewed;
  if (existsSync(notesLedgerFile({ key: b.key }))) writeJson(notesLedgerFile({ key: b.key }), led);
}

/** A folder's part files (0001.txt and so on). */
function partFiles(folder: string): string[] {
  if (!existsSync(folder)) return [];
  return readdirSync(folder).filter((f) => /^\d{4}\.txt$/.test(f));
}

/** A book in the queue: why it waits, when it's for more than its turn, and how its last tries went when they failed. */
export interface Waiting {
  id: string;
  title: string;
  task: Phase;
  waitsFor?: string;
  failed?: { times: number; next: string; why: string };
}

function waiting(b: QueueBook, task: Phase, waitsFor: string | null): Waiting {
  const w: Waiting = { id: b.sha256, title: b.title, task };
  if (waitsFor) w.waitsFor = waitsFor;
  const f = failuresOf(task).get(b.sha256);
  if (f) w.failed = { times: f.count, next: new Date(f.next).toISOString(), why: f.why ?? '' };
  return w;
}

/** Why a book's music or notes wait, past their turn: an earlier volume, the marks, the music, or an account. */
function laterWaitsFor(b: QueueBook, want: QueueBook[], phase: Phase): string | null {
  const before = seriesBefore(b, want, phase);
  if (before) return volumeOf(before);
  if (marking()) return 'marks';
  if (phase === 'music' && !accountHere) return 'an Antigravity account';
  if (phase === 'notes' && [...running.values()].some(scoring)) return 'music';
  return null;
}

/** Every book waiting, in the order it goes: all the marks, then the music, then the notes. */
export function queueOf(books: QueueBook[], server: Map<string, OnServer>): Waiting[] {
  const out: Waiting[] = [];
  for (const b of books) {
    if (running.has(b.sha256) || ended.has(b.sha256)) continue;
    if (needs(b, server) !== 'marks') continue;
    const first = castFirst(b, books, server);
    let why: string | null = null;
    if (first) why = volumeOf(first);
    out.push(waiting(b, 'marks', why));
  }
  const music = musicQueue(books, server);
  for (const b of music) {
    if (running.has(b.sha256) || ended.has(b.sha256)) continue;
    out.push(waiting(b, 'music', laterWaitsFor(b, music, 'music')));
  }
  const notes = notesQueue(books, server);
  for (const b of notes) {
    if (running.has(b.sha256) || ended.has(b.sha256)) continue;
    out.push(waiting(b, 'notes', laterWaitsFor(b, notes, 'notes')));
  }
  return out;
}

/** What the status page shows of the marker: the books it's on, how far each has got, and the queue. */
export interface Live {
  at: string;
  books: number;
  finished: number;
  working: Working[];
  queue: Waiting[];
  /** While every Antigravity account is out of Gemini, until when: research and soundtracks wait for it. */
  limitedUntil?: string;
  /** While no Antigravity account serves Gemini at all: music waits for one to be connected. */
  musicWaitsForAccount?: boolean;
}

function liveNow(): Live {
  const books = seen?.books ?? [];
  const server = seen?.server ?? new Map<string, OnServer>();
  const working = [...running.values()].map(workingOf);
  const live: Live = {
    at: new Date().toISOString(),
    books: books.length,
    finished: books.filter((b) => needs(b, server) === null && !needsMusic(b, server)).length,
    working,
    queue: queueOf(books, server),
  };
  const limited = waitingForLimits();
  if (limited) live.limitedUntil = new Date(limited).toISOString();
  if (can.music && !accountHere) live.musicWaitsForAccount = true;
  return live;
}

/** Keeps the status page's live view current: whenever something changes, and every minute anyway. Every second while the admin page is open. */
async function liveLoop(pool: pg.Pool) {
  let last = '';
  let wrote = 0;
  for (;;) {
    try {
      if (seen) {
        const live = liveNow();
        const now = JSON.stringify({ ...live, at: '' });
        if (now !== last || Date.now() - wrote > LIVE_ANYWAY_S * 1000) {
          await recordLive(pool, JOB, live);
          last = now;
          wrote = Date.now();
        }
      }
    } catch {
      /* tried again in a moment */
    }
    let secs = LIVE_S;
    if (Date.now() < watchedUntil) secs = WATCHED_LIVE_S;
    await sleep(secs * 1000);
  }
}

/** Waits `ms`, or less when wake() is called meanwhile. */
function rest(ms: number): Promise<void> {
  return new Promise((resolve) => {
    if (woken) {
      woken = false;
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      wakeUp = null;
      woken = false;
      resolve();
    }
    wakeUp = done;
  });
}

/** A round as soon as the one going ends, or now when it's resting. */
function wake() {
  woken = true;
  if (wakeUp) wakeUp();
}

/** The admin page's settings, taken in: pauses, the first model, and a round to start what they let start. */
function applySettings(s: AdminState) {
  pauses.all = s.marker.paused;
  pauses.groups.clear();
  for (const t of MARKER_TASKS) {
    if (!s.marker.tasks[t]) pauses.groups.add(t);
  }
  setFirst(s.marker.first);
  hold();
  wake();
}

/** What the admin page asks once: a failed book tried now, a book stopped, or its step done again. */
function asked(c: Command) {
  if (c.kind === 'watching') {
    watchedUntil = Date.now() + WATCHED_FOR_S * 1000;
    return;
  }
  const id = String(c.args.id ?? '');
  const task = c.args.task as Phase;
  if (c.kind === 'retry') {
    const f = failuresOf(task).get(id);
    if (f) f.next = 0;
    wake();
    return;
  }
  const j = running.get(id);
  if (!j || j.phase !== task) return;
  if (c.kind === 'stop') j.cut = 'stop';
  else if (c.kind === 'redo') j.cut = 'redo';
  else return;
  j.ctx.controller.abort();
}

/** What the marker prints, into the log of the book it's about too, when it's printed inside one's job. */
function logIntoJobs() {
  const print = console.log.bind(console);
  console.log = (...args: unknown[]) => {
    print(...args);
    const job = current();
    if (job) note(job, format(...args));
  };
}

/** What the server holds now, with ai/out kept the same when `sync`. */
async function look(sync: boolean): Promise<{ books: QueueBook[]; server: Map<string, OnServer> }> {
  const q = await listBooks();
  if (q.everyBook) throw new Error('The server has no AI switch, so every book would be marked. Not starting.');
  // Sample books have no file on the server, so their notes could never reach anyone.
  const books = q.books.filter((b) => !b.sample);
  const db = await prodClient('breader-ai-marker');
  try {
    await live(db);
    const server = await onServer(db, books.map((b) => b.sha256));
    if (sync) {
      writeJson(QUEUE, q);
      await syncOut(db, server);
    }
    return { books, server };
  } finally {
    await db.end();
  }
}

/** These books in the order they go: notesOrder, each series from its earliest volume. */
function inSeriesOrder(want: QueueBook[]): QueueBook[] {
  const inOrder = want.slice().sort(notesOrder);
  const out: QueueBook[] = [];
  for (const b of inOrder) {
    const before = inOrder.filter((o) => earlier(o, b)).sort((x, y) => x.seriesIndex! - y.seriesIndex!);
    for (const o of [...before, b]) {
      if (!out.includes(o)) out.push(o);
    }
  }
  return out;
}

/** Every book that needs notes, in the order they go. */
function notesQueue(books: QueueBook[], server: Map<string, OnServer>): QueueBook[] {
  return inSeriesOrder(books.filter((b) => needs(b, server) === 'notes'));
}

/** Every book that needs music, in the order it goes. */
function musicQueue(books: QueueBook[], server: Map<string, OnServer>): QueueBook[] {
  return inSeriesOrder(books.filter((b) => needsMusic(b, server)));
}

/**
 * Says what the marker would start now, and checks that the first book due for notes reads here
 * the way it did when it was marked. It fetches that book if it has to, and writes nothing else:
 * nothing to the server, and no model is asked anything.
 */
async function plan() {
  const { books, server } = await look(false);
  const marks = books.filter((b) => needs(b, server) === 'marks');
  const music = musicQueue(books, server);
  const notes = notesQueue(books, server);
  console.log(`${books.length} books with the AI switch on: ${marks.length} to mark, then ${music.length} to score with music, then ${notes.length} to write notes for.`);
  const unvoiced = books.filter((b) => server.get(b.sha256)?.voiced === false);
  if (unvoiced.length) console.log(`${unvoiced.length} books marked before voices were picked get them at random first.`);
  const at = control.marker.atOnce;
  if (marks.length) console.log(`\nTo mark, ${at.marks} at a time, in this order:\n${marks.map((b) => `  ${b.title}`).join('\n')}`);
  if (music.length) console.log(`\nThen music, ${at.music} at a time, in this order:\n${music.map((b) => `  ${b.title}`).join('\n')}`);
  if (notes.length) console.log(`\nThen notes, ${at.notes} at a time, in this order:\n${notes.map((b) => `  ${b.title}`).join('\n')}`);
  const first = notes[0];
  if (!first) return;
  if (!isFetched(first.key)) await fetchBook(first);
  const db = await prodClient('breader-ai-marker');
  let row: AiFile | null;
  try {
    row = await fileOnServer(db, first.sha256);
  } finally {
    await db.end();
  }
  const here = loadBook(first.key).sections.map((s) => s.print);
  const there = row?.sections ?? [];
  const differ = here.filter((p, i) => p !== there[i]).length + Math.max(0, there.length - here.length);
  if (differ) console.log(`\n${first.title} reads differently here: ${differ} of ${there.length} chapters. Its notes would fail.`);
  else console.log(`\n${first.title} reads the same here as when it was marked (${here.length} chapters).`);
}

/** Starts putting in the music uploaded from the admin page, for books on the list here. Others wait. */
async function startUploads(books: QueueBook[], pool: pg.Pool) {
  let waiting: string[];
  try {
    waiting = await uploads();
  } catch (e) {
    console.log(`${clock()} Couldn’t look for uploaded music: ${message(e)}`);
    return;
  }
  for (const sha256 of waiting) {
    const b = books.find((o) => o.sha256 === sha256);
    if (!b || running.has(sha256) || resting(b, 'music') || held(b, 'music')) continue;
    start(b, 'music', () => uploadJob(b), pool);
  }
}

/** Kept back from a task on the admin page. */
function held(b: QueueBook, phase: Phase): boolean {
  return control.held.includes(queueKey(b.sha256, phase));
}

/** Of these books, the ones not kept back, the ones the admin page asked for next first. */
function ready(books: QueueBook[], phase: Phase): QueueBook[] {
  const free = books.filter((b) => !held(b, phase));
  return nextFirst(free, (b) => queueKey(b.sha256, phase), control.next);
}

/**
 * One look at the books, starting whatever can start: nothing while the admin page has the marker
 * paused, no task it switched off, and as many books at once as it says.
 */
async function round(lbs: Balancers, pool: pg.Pool) {
  const { books, server } = await look(true);
  if (can.music) accountHere = await servesGemini();
  seen = { books, server };
  ended.clear();
  const m = control.marker;
  if (m.paused) return;
  // Voices the same through a series, or at random, need no model, so they go in before anything starts.
  await voicesForOld(books, server);
  const free = (p: Phase) => {
    const now = [...running.values()].filter((j) => j.phase === p).length;
    return Math.max(0, m.atOnce[p] - now);
  };

  if (m.tasks.marks) {
    for (const b of ready(toMark(books, server), 'marks').slice(0, free('marks'))) {
      start(b, 'marks', () => markJob(b, lbs), pool);
    }
  }
  // Uploaded music needs no model, so it goes in while books are being marked too.
  if (can.uploads && m.tasks.music) await startUploads(books, pool);
  // Music only while no book is being marked, past its research, and an Antigravity account is connected.
  if (marking()) return;
  if (accountHere && m.tasks.music) {
    for (const b of ready(toMusic(books, server), 'music').slice(0, free('music'))) {
      start(b, 'music', () => musicJob(b, lbs), pool);
    }
  }
  // Notes only while no book's music is being scored, past its research and soundtrack.
  if ([...running.values()].some(scoring)) return;
  if (m.tasks.notes) {
    for (const b of ready(toNote(books, server), 'notes').slice(0, free('notes'))) {
      start(b, 'notes', () => notesJob(b, lbs), pool);
    }
  }
}

/** Whether a job is a book's music using NVIDIA: not paused, not being researched, not gathering its series' soundtrack, and not uploaded. */
function scoring(j: Job): boolean {
  if (j.phase !== 'music') return false;
  if (paused('music')) return false;
  if (researching.has(j.b.key)) return false;
  if (uploading.has(j.b.key)) return false;
  return musicStage.get(j.b.key) !== GATHERING;
}

/** Why there's no NVIDIA key, or null when there is one. */
function noKey(): string | null {
  try {
    nvidiaKey();
    return null;
  } catch (e) {
    return message(e);
  }
}

/** Says on the status page that the marker is off, when there's a database to say it in. */
async function sayOff(why: string) {
  let pool: pg.Pool | null = null;
  try {
    pool = prodPool('breader-ai-marker');
    await recordError(pool, JOB, new Error(`The marker is off: ${why}`));
  } catch {
    /* a stack for development: no database of the marker's */
  } finally {
    await pool?.end().catch(() => {});
  }
}

/**
 * Runs for good: a round about once a minute. With `dry`, only says what it would start. With no
 * NVIDIA key it stays off and ends, which is what it does in a stack for development.
 */
export async function runMarker(dry: boolean) {
  const why = noKey();
  const noResearch = noHarness();
  const noScore = noMusic();
  const noTracks = noDownloads();
  can.research = noResearch === null;
  can.music = noScore === null;
  can.uploads = noTracks === null;
  if (noResearch) console.log(`${clock()} No research from the web: ${noResearch}.`);
  if (noScore) console.log(`${clock()} No background music: ${noScore}.`);
  if (noTracks) console.log(`${clock()} No uploaded music either: ${noTracks}.`);
  if (dry) {
    if (why) console.log(`${why}\n`);
    else console.log(`The NVIDIA key comes from ${nvidiaKey().from}.\n`);
    return plan();
  }
  if (why) {
    console.log(`${clock()} The marker is off: ${why}`);
    await sayOff(why);
    return;
  }
  mkdirSync(WORK, { recursive: true });
  mkdirSync(OUT, { recursive: true });
  const lbs = balancers();
  const pool = prodPool('breader-ai-marker');
  let refused = '';
  let alive = 0;
  logIntoJobs();
  applySettings(await readControl(pool));
  woken = false;
  const at = control.marker.atOnce;
  console.log(`${clock()} The marker is running: a look about every ${POLL_S} s, up to ${at.marks} books marked, ${at.music} scored and ${at.notes} given notes at once.`);
  void liveLoop(pool);
  void controlLoop(pool, applySettings, asked);
  for (;;) {
    try {
      await round(lbs, pool);
      // Not while NVIDIA refuses the key: that would hide it on the status page.
      if (Date.now() - alive > ALIVE_S * 1000 && !Balancer.refused().length) {
        alive = Date.now();
        await recordOk(pool, JOB, liveNow());
      }
    } catch (e) {
      console.log(`${clock()} ${message(e)}`);
      await recordError(pool, JOB, e).catch(() => {});
    }
    // A key NVIDIA refuses stops everything without failing anything, so it's said out loud.
    const now = Balancer.refused().join(' and ');
    if (now && now !== refused) {
      console.log(`${clock()} NVIDIA refuses the key for ${now}; asking again about every hour.`);
      await recordError(pool, JOB, new Error(`NVIDIA refuses the key for ${now}. Put a new one in ai/.env and seal it again: npm --prefix ai run seal.`)).catch(() => {});
    }
    refused = now;
    await rest(jitter(POLL_S) * 1000);
  }
}
