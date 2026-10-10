import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type pg from 'pg';
import type { AiFile } from '../../shared/src/ai.ts';
import { recordError, recordLive, recordOk } from '../../server/src/jobs/runs.ts';
import { Balancer, jitter } from './balancer.ts';
import { castPass } from './cast.ts';
import { prodClient, prodPool } from './env.ts';
import { castFromFile, fetchBook } from './fetch.ts';
import { waitingForLimits } from './harness.ts';
import { checkFile, fileOnServer, live, loadOne, onServer, replace, upsert, wanted } from './import.ts';
import { castByFile, castOf, fitBy, LADDER, mins, notesBy, notesLedger, PRIMARY } from './kimi.ts';
import { bookDir, isFetched, loadBook, marksFiles, OUT, QUEUE, readJson, WORK, writeJson, type Book, type QueueBook } from './lib.ts';
import { listBooks } from './library.ts';
import { markBook, stageOf } from './mark.ts';
import { GATHERING, musicBy, musicLedger, musicStage, noMusic, scoreBook, type Score } from './music.ts';
import { nvidiaKey } from './nim.ts';
import { writeNotes } from './notes.ts';
import { revisitOf } from './pack.ts';
import { noHarness } from './proxy.ts';
import { researchBook, researched } from './research.ts';
import { validate, type Notes } from './validate.ts';

/*
 * The marker: mark.ts, music.ts and notes.ts for every book whose AI switch is on, for good, with
 * no one at the keyboard. The server's worker runs it (server/src/jobs/marker.ts); npm --prefix ai
 * run marker runs it here. With no NVIDIA key it stays off.
 *
 * About once a minute it lists the books. A book with nothing on the server yet gets its voice
 * marks: fetched, researched on the web by the harness (research.ts) when Antigravity is here, its
 * cast read from the book with that research (cast.ts), every part marked, packed and imported, up
 * to MARKING books at once, the books being read first. Only when no book is being marked does
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
 * the harness waits for the first to fill again (harness.ts), which can be days.
 *
 * A call that fails is asked again by the balancer, after a wait that doubles each time, with
 * jitter, for as long as it takes. A book that fails waits 2 minutes, then 4, 8 and so on up to an
 * hour, with jitter, and carries on where it stopped. How it goes is in job_runs as "ai-marker",
 * for the admin page, along with what it's on right now: each book, its task, its step and how
 * many of its parts are done, and the queue (liveLoop). Nothing it prints has a book's text in it.
 */

/** How often it looks for work, and how many books it marks, scores and writes notes for, at once. */
const POLL_S = 60;
const MARKING = 4;
const MUSICING = 2;
const NOTING = 2;
/** A book that failed waits this long, doubling each time it fails again, up to the cap. */
const RETRY_FIRST_S = 120;
const RETRY_CAP_S = 3600;
/** A volume that has failed this many times in a row stops holding up the volumes after it. */
const STUCK = 5;
/** Its name in job_runs, and how often it says it's alive there when there's nothing new. */
const JOB = 'ai-marker';
const ALIVE_S = 3600;
/** How often the status page's live view is brought up to date, and how often it's written anyway. */
const LIVE_S = 10;
const LIVE_ANYWAY_S = 60;

export type Phase = 'marks' | 'music' | 'notes';

/** What the server has for a book: when it was made, by whom, how many Revisit entries, and whether it has music. */
export interface OnServer {
  made: string;
  by: string;
  notes: number;
  music?: boolean;
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
/** What the marker can do here besides marks and notes, set when it starts: research needs the harness; music the harness, yt-dlp and ffmpeg. */
export const can = { research: false, music: false };
/** The last look at the books and the server. */
let seen: { books: QueueBook[]; server: Map<string, OnServer> } | null = null;

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
    const castFirst = books.filter((o) => earlier(o, b) && needs(o, server) === 'marks' && !existsSync(castByFile(o)) && !stuck(o, 'marks'));
    if (castFirst.length) continue;
    out.push(b);
  }
  return out;
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
    const before = inOrder.filter((o) => earlier(o, b) && !stuck(o, phase)).sort((x, y) => x.seriesIndex! - y.seriesIndex!);
    const first = before[0] ?? b;
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

/** Whether NVIDIA is busy with marks: a book being marked that isn't being researched on the web. */
function marking(): boolean {
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
  if (!can.research || researched(b)) return;
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

async function markJob(b: QueueBook, lbs: Balancers) {
  if (!isFetched(b.key)) await fetchBook(b);
  const book = loadBook(b.key);
  await research(b, 'marks');
  if (!existsSync(castByFile(book))) await castPass(book, lbs.lb);
  try {
    await markBook(b.key, lbs.lb, lbs.top, {});
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

/** The server's file with this book's music in it. */
export function withMusic(row: AiFile, book: { key: string }, score: Score): AiFile {
  return {
    ...row,
    made: new Date().toISOString(),
    by: byWith(row.by, 'music', musicBy(book)),
    music: { tracks: score.tracks, cues: score.cues },
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

/** Notes for a book with marks on the server, made here or anywhere, into its file on the server. */
async function notesJob(b: QueueBook, lbs: Balancers) {
  const row = await serverFile(b);
  const book = await sameBook(b, row, 'notes');
  await research(b, 'notes');
  matchCast(book, row);
  await writeNotes(b.key, lbs.notes, lbs.review, { 'no-pack': true });
  await putBack(withNotes(row, book), row.made, 'notes');
}

/** Music for a book with marks on the server, made here or anywhere, into its file on the server. */
async function musicJob(b: QueueBook, lbs: Balancers) {
  const row = await serverFile(b);
  const book = await sameBook(b, row, 'music');
  await research(b, 'music');
  try {
    const score = await scoreBook(b, book, lbs.music);
    await putBack(withMusic(row, book, score), row.made, 'music');
  } finally {
    musicStage.delete(b.key);
  }
}

/** Starts a book's work without waiting for it. When it ends, job_runs hears how it went. */
function start(b: QueueBook, phase: Phase, work: () => Promise<void>, pool: pg.Pool) {
  running.set(b.sha256, { b, phase, since: Date.now() });
  hold();
  console.log(`${clock()} ${b.title}: ${phase} start`);
  const t0 = Date.now();
  work()
    .then(async () => {
      failuresOf(phase).delete(b.sha256);
      running.delete(b.sha256);
      ended.add(b.sha256);
      console.log(`${clock()} ${b.title}: ${phase} done, in ${mins((Date.now() - t0) / 1000)}`);
      await recordOk(pool, JOB, liveNow()).catch(() => {});
    })
    .catch(async (e: unknown) => {
      const why = message(e);
      const list = failuresOf(phase);
      const f = list.get(b.sha256) ?? { count: 0, next: 0 };
      f.count++;
      const secs = jitter(Math.min(RETRY_CAP_S, RETRY_FIRST_S * 2 ** (f.count - 1)));
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

/** How far a book's marks, music or notes have got, from what's on disk. `parts` is null until it's fetched. */
export function progressOf(key: string, phase: Phase, parts: number[] | null): Progress {
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

/** A book in the queue, with how its last tries went when they failed. */
export interface Waiting {
  title: string;
  task: Phase;
  failed?: { times: number; next: string; why: string };
}

function waiting(b: QueueBook, task: Phase): Waiting {
  const f = failuresOf(task).get(b.sha256);
  if (!f) return { title: b.title, task };
  return { title: b.title, task, failed: { times: f.count, next: new Date(f.next).toISOString(), why: f.why ?? '' } };
}

/** Every book waiting, in the order it goes: all the marks, then the music, then the notes. */
export function queueOf(books: QueueBook[], server: Map<string, OnServer>): Waiting[] {
  const out: Waiting[] = [];
  for (const b of books) {
    if (running.has(b.sha256) || ended.has(b.sha256)) continue;
    if (needs(b, server) === 'marks') out.push(waiting(b, 'marks'));
  }
  for (const b of musicQueue(books, server)) {
    if (running.has(b.sha256) || ended.has(b.sha256)) continue;
    out.push(waiting(b, 'music'));
  }
  for (const b of notesQueue(books, server)) {
    if (running.has(b.sha256) || ended.has(b.sha256)) continue;
    out.push(waiting(b, 'notes'));
  }
  return out;
}

/** What the status page shows of the marker: the books it's on, how far each has got, and the queue. */
export interface Live {
  at: string;
  books: number;
  finished: number;
  working: Array<Progress & { title: string; task: Phase; since: string }>;
  queue: Waiting[];
  /** While every Antigravity account is out of Gemini, until when: research and soundtracks wait for it. */
  limitedUntil?: string;
}

function liveNow(): Live {
  const books = seen?.books ?? [];
  const server = seen?.server ?? new Map<string, OnServer>();
  const working = [...running.values()].map((j) => ({
    title: j.b.title,
    task: j.phase,
    since: new Date(j.since).toISOString(),
    ...progressOf(j.b.key, j.phase, partsOf(j)),
  }));
  const live: Live = {
    at: new Date().toISOString(),
    books: books.length,
    finished: books.filter((b) => needs(b, server) === null && !needsMusic(b, server)).length,
    working,
    queue: queueOf(books, server),
  };
  const limited = waitingForLimits();
  if (limited) live.limitedUntil = new Date(limited).toISOString();
  return live;
}

/** Keeps the status page's live view current: whenever something changes, and every minute anyway. */
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
    await sleep(LIVE_S * 1000);
  }
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
  if (marks.length) console.log(`\nTo mark, ${MARKING} at a time, in this order:\n${marks.map((b) => `  ${b.title}`).join('\n')}`);
  if (music.length) console.log(`\nThen music, ${MUSICING} at a time, in this order:\n${music.map((b) => `  ${b.title}`).join('\n')}`);
  if (notes.length) console.log(`\nThen notes, ${NOTING} at a time, in this order:\n${notes.map((b) => `  ${b.title}`).join('\n')}`);
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

/** One look at the books, starting whatever can start. */
async function round(lbs: Balancers, pool: pg.Pool) {
  const { books, server } = await look(true);
  seen = { books, server };
  ended.clear();
  const byPhase = (p: Phase) => [...running.values()].filter((j) => j.phase === p).length;

  const marks = toMark(books, server);
  for (const b of marks.slice(0, Math.max(0, MARKING - byPhase('marks')))) {
    start(b, 'marks', () => markJob(b, lbs), pool);
  }
  // Music only while no book is being marked, past its research.
  if (marking()) return;
  for (const b of toMusic(books, server).slice(0, Math.max(0, MUSICING - byPhase('music')))) {
    start(b, 'music', () => musicJob(b, lbs), pool);
  }
  // Notes only while no book's music is being scored, past its research and soundtrack.
  if ([...running.values()].some(scoring)) return;
  for (const b of toNote(books, server).slice(0, Math.max(0, NOTING - byPhase('notes')))) {
    start(b, 'notes', () => notesJob(b, lbs), pool);
  }
}

/** Whether a job is a book's music using NVIDIA: not being researched, and not gathering its series' soundtrack. */
function scoring(j: Job): boolean {
  if (j.phase !== 'music') return false;
  if (researching.has(j.b.key)) return false;
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
  can.research = noResearch === null;
  can.music = noScore === null;
  if (noResearch) console.log(`${clock()} No research from the web: ${noResearch}.`);
  if (noScore) console.log(`${clock()} No background music: ${noScore}.`);
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
  console.log(`${clock()} The marker is running: a look about every ${POLL_S} s, up to ${MARKING} books marked, ${MUSICING} scored and ${NOTING} given notes at once.`);
  void liveLoop(pool);
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
    await sleep(jitter(POLL_S) * 1000);
  }
}
