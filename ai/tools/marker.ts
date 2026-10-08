import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type pg from 'pg';
import type { AiFile } from '../../shared/src/ai.ts';
import { recordError, recordOk } from '../../server/src/jobs/runs.ts';
import { Balancer, jitter } from './balancer.ts';
import { castPass } from './cast.ts';
import { prodClient, prodPool } from './env.ts';
import { castFromFile, fetchBook } from './fetch.ts';
import { checkFile, fileOnServer, live, loadOne, onServer, replace, upsert, wanted } from './import.ts';
import { castByFile, castOf, fitBy, LADDER, mins, notesBy, PRIMARY } from './kimi.ts';
import { bookDir, isFetched, loadBook, OUT, QUEUE, readJson, WORK, writeJson, type Book, type QueueBook } from './lib.ts';
import { listBooks } from './library.ts';
import { markBook } from './mark.ts';
import { nvidiaKey } from './nim.ts';
import { writeNotes } from './notes.ts';
import { revisitOf } from './pack.ts';
import { validate, type Notes } from './validate.ts';

/*
 * The marker: mark.ts and notes.ts for every book whose AI switch is on, for good, with no one at
 * the keyboard. The server's worker runs it (server/src/jobs/marker.ts); npm --prefix ai run
 * marker runs it here. With no NVIDIA key it stays off.
 *
 * About once a minute it lists the books. A book with nothing on the server yet gets its voice
 * marks: fetched, its cast read from the book alone (cast.ts, no web research), every part marked,
 * packed and imported, up to MARKING books at once, the books being read first. Only when no book
 * is waiting to be marked do Revisit notes start, for books that have none: books someone is
 * reading, the most recently read first, then the rest, the oldest added first. A series goes
 * from its earliest volume that needs notes, since each volume's notes build on the ones before.
 * A book added later still comes first: while one is being marked, notes calls wait.
 *
 * A call that fails is asked again by the balancer, after a wait that doubles each time, with
 * jitter, for as long as it takes. A book that fails waits 2 minutes, then 4, 8 and so on up to an
 * hour, with jitter, and carries on where it stopped. How it goes is in job_runs as "ai-marker",
 * for the admin page. Nothing it prints has a book's text in it.
 */

/** How often it looks for work, and how many books it marks, and writes notes for, at once. */
const POLL_S = 60;
const MARKING = 4;
const NOTING = 2;
/** A book that failed waits this long, doubling each time it fails again, up to the cap. */
const RETRY_FIRST_S = 120;
const RETRY_CAP_S = 3600;
/** A volume that has failed this many times in a row stops holding up the volumes after it. */
const STUCK = 5;
/** Its name in job_runs, and how often it says it's alive there when there's nothing new. */
const JOB = 'ai-marker';
const ALIVE_S = 3600;

type Phase = 'marks' | 'notes';

/** What the server has for a book: when it was made, by whom, and how many Revisit entries. */
export interface OnServer {
  made: string;
  by: string;
  notes: number;
}

interface Balancers {
  lb: Balancer;
  top: Balancer;
  notes: Balancer;
  review: Balancer;
}

/** Books being worked on, by SHA-256, and books that failed, with when to try them again. */
const running = new Map<string, Phase>();
export const failures = new Map<string, { count: number; next: number }>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clock = () => new Date().toISOString().slice(0, 16).replace('T', ' ');
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function balancers(): Balancers {
  const patient = { waitForTopS: 300, strikesToFall: 3, maxTries: Infinity, patient: true };
  const kimiOnly = { waitForTopS: Infinity, strikesToFall: Infinity, patient: true };
  return {
    // The cast pass and the marks: Kimi K3, and Nemotron while Kimi is down (kimi.ts).
    lb: new Balancer(LADDER, patient),
    // Nemotron's parts again, by Kimi only. After 6 tries a part keeps Nemotron's marks.
    top: new Balancer(PRIMARY, { ...kimiOnly, maxTries: 6 }),
    // Notes, which wait while a book is being marked.
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

/** Failed lately, and not due to be tried again yet. */
function resting(b: QueueBook): boolean {
  const f = failures.get(b.sha256);
  if (!f) return false;
  return f.next > Date.now();
}

function stuck(b: QueueBook): boolean {
  const f = failures.get(b.sha256);
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
    if (needs(b, server) !== 'marks' || running.has(b.sha256) || resting(b)) continue;
    const castFirst = books.filter((o) => earlier(o, b) && needs(o, server) === 'marks' && !existsSync(castByFile(o)) && !stuck(o));
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
 * Books to start notes for, in notesOrder. A series goes from its earliest volume that needs
 * notes, one volume at a time, since each builds on the ones before. A stuck volume is still
 * tried, but no longer holds up the ones after it.
 */
export function toNote(books: QueueBook[], server: Map<string, OnServer>): QueueBook[] {
  const want = books.filter((b) => needs(b, server) === 'notes').sort(notesOrder);
  const out: QueueBook[] = [];
  for (const b of want) {
    const before = want.filter((o) => earlier(o, b) && !stuck(o)).sort((x, y) => x.seriesIndex! - y.seriesIndex!);
    const first = before[0] ?? b;
    if (running.has(first.sha256) || resting(first) || out.includes(first)) continue;
    out.push(first);
  }
  return out;
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

async function markJob(b: QueueBook, lbs: Balancers) {
  if (!isFetched(b.key)) await fetchBook(b);
  const book = loadBook(b.key);
  if (!existsSync(castByFile(book))) await castPass(book, lbs.lb);
  await markBook(b.key, lbs.lb, lbs.top, {});
  await importFile(b.sha256);
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

/** The server's "by" with who wrote the notes, before the credit for the research. */
export function byWithNotes(by: string, who: string): string {
  const parts = by.split('; ').filter((p) => !p.startsWith('notes '));
  const research = parts.findIndex((p) => /^(research|cast) by /.test(p));
  const credit = `notes by ${who}`;
  if (research < 0) return fitBy([...parts, credit]);
  return fitBy([...parts.slice(0, research), credit, ...parts.slice(research)]);
}

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

/**
 * Notes for a book with marks on the server, made here or anywhere: fetched if it isn't, checked
 * to read the same as when it was marked, then the notes go into its file on the server.
 */
async function notesJob(b: QueueBook, lbs: Balancers) {
  const db = await prodClient('breader-ai-marker');
  let row: AiFile | null;
  try {
    row = await fileOnServer(db, b.sha256);
  } finally {
    await db.end();
  }
  if (!row) throw new Error('its file left the server');
  if (!isFetched(b.key)) await fetchBook(b);
  const book = loadBook(b.key);
  if (book.sections.map((s) => s.print).join(' ') !== row.sections.join(' ')) {
    throw new Error('it reads differently here than when it was marked, so its notes would land on the wrong paragraphs');
  }
  matchCast(book, row);
  await writeNotes(b.key, lbs.notes, lbs.review, { 'no-pack': true });

  const f = withNotes(row, book);
  const c = checkFile(`${f.sha256}.json`, f);
  if (c.problems.length) throw new Error(`its file with notes has problems. The first: ${c.problems[0]}`);
  writeJson(join(OUT, `${f.sha256}.json`), f);
  const write = await prodClient('breader-ai-marker');
  try {
    const ok = await replace(write, f, row.made);
    if (!ok) throw new Error('its file on the server changed while the notes were written, so they go in next time');
  } finally {
    await write.end();
  }
}

/** Starts a book's work without waiting for it. When it ends, job_runs hears how it went. */
function start(b: QueueBook, phase: Phase, work: () => Promise<void>, pool: pg.Pool) {
  running.set(b.sha256, phase);
  if (phase === 'marks') Balancer.holdLow = true;
  console.log(`${clock()} ${b.title}: ${phase} start`);
  const t0 = Date.now();
  work()
    .then(async () => {
      failures.delete(b.sha256);
      console.log(`${clock()} ${b.title}: ${phase} done, in ${mins((Date.now() - t0) / 1000)}`);
      await recordOk(pool, JOB, { book: b.title, done: phase }).catch(() => {});
    })
    .catch(async (e: unknown) => {
      const f = failures.get(b.sha256) ?? { count: 0, next: 0 };
      f.count++;
      const secs = jitter(Math.min(RETRY_CAP_S, RETRY_FIRST_S * 2 ** (f.count - 1)));
      f.next = Date.now() + secs * 1000;
      failures.set(b.sha256, f);
      const why = message(e);
      console.log(`${clock()} ${b.title}: ${phase} failed (${f.count} in a row), again in ${mins(secs)}: ${why}`);
      await recordError(pool, JOB, new Error(`${b.title}: ${phase}: ${why}`)).catch(() => {});
    })
    .finally(() => {
      running.delete(b.sha256);
      Balancer.holdLow = [...running.values()].includes('marks');
    });
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

/** Every book that needs notes, in the order they go: notesOrder, each series from its earliest volume. */
function notesQueue(books: QueueBook[], server: Map<string, OnServer>): QueueBook[] {
  const want = books.filter((b) => needs(b, server) === 'notes').sort(notesOrder);
  const out: QueueBook[] = [];
  for (const b of want) {
    const before = want.filter((o) => earlier(o, b)).sort((x, y) => x.seriesIndex! - y.seriesIndex!);
    for (const o of [...before, b]) {
      if (!out.includes(o)) out.push(o);
    }
  }
  return out;
}

/**
 * Says what the marker would start now, and checks that the first book due for notes reads here
 * the way it did when it was marked. It fetches that book if it has to, and writes nothing else:
 * nothing to the server, and no model is asked anything.
 */
async function plan() {
  const { books, server } = await look(false);
  const marks = books.filter((b) => needs(b, server) === 'marks');
  const notes = notesQueue(books, server);
  console.log(`${books.length} books with the AI switch on: ${marks.length} to mark, then ${notes.length} to write notes for.`);
  if (marks.length) console.log(`\nTo mark, ${MARKING} at a time, in this order:\n${marks.map((b) => `  ${b.title}`).join('\n')}`);
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
  const byPhase = (p: Phase) => [...running.values()].filter((x) => x === p).length;

  const marks = toMark(books, server);
  for (const b of marks.slice(0, Math.max(0, MARKING - byPhase('marks')))) {
    start(b, 'marks', () => markJob(b, lbs), pool);
  }
  // Notes only once no book is being marked, or could be.
  if (marks.length || byPhase('marks')) return;
  for (const b of toNote(books, server).slice(0, Math.max(0, NOTING - byPhase('notes')))) {
    start(b, 'notes', () => notesJob(b, lbs), pool);
  }
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
  console.log(`${clock()} The marker is running: a look about every ${POLL_S} s, up to ${MARKING} books marked and ${NOTING} given notes at once.`);
  for (;;) {
    try {
      await round(lbs, pool);
      // Not while NVIDIA refuses the key: that would hide it on the status page.
      if (Date.now() - alive > ALIVE_S * 1000 && !Balancer.refused().length) {
        alive = Date.now();
        await recordOk(pool, JOB, { running: running.size, failing: failures.size });
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
