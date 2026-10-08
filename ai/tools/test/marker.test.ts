import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { QueueBook } from '../lib.ts';
import type { OnServer } from '../marker.ts';

/*
 * What the marker picks next: marks before notes, notes in the order the owner asked for, and a
 * series from its earliest volume. Made-up books, no network.
 */

process.env.AI_WORK = mkdtempSync(join(tmpdir(), 'breader-ai-test-'));
const { bookDir, writeJson } = await import('../lib.ts');
const { byWithNotes, failures, needs, notesOrder, progressOf, queueOf, toMark, toNote } = await import('../marker.ts');

let made = 0;
function book(title: string, more: Partial<QueueBook> = {}): QueueBook {
  made++;
  const sha256 = String(made).padStart(64, '0');
  return {
    rank: made,
    key: `${title.toLowerCase().replace(/\W+/g, '-')}-${sha256.slice(0, 8)}`,
    sha256,
    title,
    author: '',
    format: 'EPUB',
    size: 1,
    r2Key: 'x',
    started: false,
    progress: 0,
    lastRead: '2026-01-01T00:00:00.000Z',
    added: '2026-01-01T00:00:00.000Z',
    readers: 1,
    ...more,
  };
}

const marked = (notes = 0, by = 'Kimi K3 (reasoning high, NVIDIA) parts 1-3; research by Antigravity'): OnServer => ({ made: '2026-01-01T00:00:00.000Z', by, notes });
const titles = (books: QueueBook[]) => books.map((b) => b.title);

test('a book with nothing on the server needs marks; one with marks and no notes needs notes', () => {
  const b = book('B');
  assert.equal(needs(b, new Map()), 'marks');
  assert.equal(needs(b, new Map([[b.sha256, marked()]])), 'notes');
  assert.equal(needs(b, new Map([[b.sha256, marked(12)]])), null);
  // Notes written that came out empty are done, not written again and again.
  const empty = marked(0, 'Kimi K3 (reasoning high, NVIDIA) parts 1; notes by Kimi K3 (reasoning high, NVIDIA); cast by Kimi K3 (reasoning high, NVIDIA)');
  assert.equal(needs(b, new Map([[b.sha256, empty]])), null);
});

test('notes go to books being read first, the latest read at the top, then the oldest added', () => {
  const books = [
    book('Added last', { added: '2026-05-01T00:00:00.000Z' }),
    book('Read long ago', { started: true, lastRead: '2026-02-01T00:00:00.000Z' }),
    book('Added first', { added: '2025-12-01T00:00:00.000Z' }),
    book('Read today', { started: true, lastRead: '2026-10-08T00:00:00.000Z' }),
  ];
  assert.deepEqual(titles(books.slice().sort(notesOrder)), ['Read today', 'Read long ago', 'Added first', 'Added last']);
  const server = new Map(books.map((b) => [b.sha256, marked()]));
  assert.deepEqual(titles(toNote(books, server)), ['Read today', 'Read long ago', 'Added first', 'Added last']);
});

test('a series gets its notes from its earliest volume, at the place its book being read has', () => {
  const s1 = book('Saga 1', { series: 'Saga', seriesIndex: 1, added: '2026-03-01T00:00:00.000Z' });
  const s2 = book('Saga 2', { series: 'Saga', seriesIndex: 2, started: true, lastRead: '2026-10-08T00:00:00.000Z' });
  const s3 = book('Saga 3', { series: 'saga', seriesIndex: 3 });
  const other = book('Other', { started: true, lastRead: '2026-09-01T00:00:00.000Z' });
  const books = [other, s3, s2, s1];
  const server = new Map(books.map((b) => [b.sha256, marked()]));
  assert.deepEqual(titles(toNote(books, server)), ['Saga 1', 'Other']);
  // Once Saga 1 has notes, Saga 2 is next, still ahead of Other.
  server.set(s1.sha256, marked(10));
  assert.deepEqual(titles(toNote(books, server)), ['Saga 2', 'Other']);
});

test('a volume that keeps failing is still tried, but stops holding up the ones after it', () => {
  const v1 = book('Epic 1', { series: 'Epic', seriesIndex: 1 });
  const v2 = book('Epic 2', { series: 'Epic', seriesIndex: 2 });
  const books = [v2, v1];
  const server = new Map(books.map((b) => [b.sha256, marked()]));
  failures.set(v1.sha256, { count: 2, next: Date.now() + 60_000 });
  assert.deepEqual(titles(toNote(books, server)), [], 'resting, and still holding up Epic 2');
  failures.set(v1.sha256, { count: 5, next: Date.now() + 60_000 });
  assert.deepEqual(titles(toNote(books, server)), ['Epic 2']);
  failures.set(v1.sha256, { count: 5, next: 0 });
  assert.deepEqual(titles(toNote(books, server)), ['Epic 2', 'Epic 1']);
  failures.clear();
});

test('marks: a later volume waits for an earlier one’s cast, so everyone keeps their id and voice', () => {
  const v1 = book('Tale 1', { series: 'Tale', seriesIndex: 1 });
  const v2 = book('Tale 2', { series: 'Tale', seriesIndex: 2 });
  const v3 = book('Tale 3', { series: 'Tale', seriesIndex: 3 });
  const lone = book('Lone');
  const books = [v3, lone, v2, v1];
  const server = new Map([[v1.sha256, marked(5)]]);
  assert.deepEqual(titles(toMark(books, server)), ['Lone', 'Tale 2']);
  writeJson(join(bookDir(v2.key), 'cast-by.json'), { model: 'kimi-k3', rounds: 1, secs: 1, at: '' });
  assert.deepEqual(titles(toMark(books, server)), ['Tale 3', 'Lone', 'Tale 2']);
});

test('the live view: how far a book’s marks have got, from what’s on disk', () => {
  const b = book('Gauge');
  const dir = bookDir(b.key);
  const parts = [1, 2, 3, 4];
  assert.deepEqual(progressOf(b.key, 'marks', null), { step: 'Fetching the book', parts: 0, of: 0, percent: 0 });
  assert.equal(progressOf(b.key, 'marks', parts).step, 'Reading the cast from the book');
  writeJson(join(dir, 'cast-by.json'), { model: 'kimi-k3', rounds: 1, secs: 1, at: '' });
  mkdirSync(join(dir, 'marks'), { recursive: true });
  writeFileSync(join(dir, 'marks', '0001.txt'), '');
  writeFileSync(join(dir, 'marks', '0002.txt'), '');
  // The cast and two of four parts: 3 of 6 steps.
  assert.deepEqual(progressOf(b.key, 'marks', parts), { step: 'Marking who speaks, part by part', parts: 2, of: 4, percent: 50 });
  writeFileSync(join(dir, 'marks', '0003.txt'), '');
  writeFileSync(join(dir, 'marks', '0004.txt'), '');
  assert.deepEqual(progressOf(b.key, 'marks', parts), { step: 'Checking, settling and saving', parts: 4, of: 4, percent: 83 });
});

test('the live view: how far a book’s notes have got', () => {
  const b = book('Ledger');
  const done = { model: 'kimi-k3', rounds: 1, secs: 1, at: '' };
  const parts = [1, 2, 3, 4];
  assert.equal(progressOf(b.key, 'notes', parts).step, 'Listing who’s who');
  writeJson(join(bookDir(b.key), 'notes-by.json'), { roster: done, parts: { 1: done } });
  // The list of who's who and one of four parts: 2 of 7 steps.
  assert.deepEqual(progressOf(b.key, 'notes', parts), { step: 'Writing notes, part by part', parts: 1, of: 4, percent: 28 });
  writeJson(join(bookDir(b.key), 'notes-by.json'), { roster: done, parts: { 1: done, 2: done, 3: done, 4: done }, fixed: done });
  assert.deepEqual(progressOf(b.key, 'notes', parts), { step: 'Reading them through as a reader would', parts: 4, of: 4, percent: 85 });
});

test('the live view: the queue, marks first, then notes, with how the failed ones went', () => {
  const fresh = book('Fresh');
  const halfway = book('Halfway', { started: true, lastRead: '2026-10-08T00:00:00.000Z' });
  const done = book('Done');
  const server = new Map([[halfway.sha256, marked()], [done.sha256, marked(9)]]);
  failures.set(halfway.sha256, { count: 2, next: Date.parse('2026-10-08T12:00:00.000Z'), why: 'NVIDIA was busy' });
  assert.deepEqual(queueOf([done, halfway, fresh], server), [
    { title: 'Fresh', task: 'marks' },
    { title: 'Halfway', task: 'notes', failed: { times: 2, next: '2026-10-08T12:00:00.000Z', why: 'NVIDIA was busy' } },
  ]);
  failures.clear();
});

test('the notes go into "by" before the credit for the research, within 200 characters', () => {
  const kimi = 'Kimi K3 (reasoning high, NVIDIA)';
  assert.equal(byWithNotes(`${kimi} parts 1-19; research by Antigravity`, kimi), `${kimi} parts 1-19; notes by ${kimi}; research by Antigravity`);
  assert.equal(byWithNotes(`${kimi} parts 1-4; cast by ${kimi}`, kimi), `${kimi} parts 1-4; notes by ${kimi}; cast by ${kimi}`);
  const long = `${kimi} parts 1-3, 5-6, 8-10, 12-14, 16-19; nemotron-3-ultra parts 4, 7, 11, 15; cast by ${kimi}`;
  const by = byWithNotes(long, `${kimi} and nemotron-3-ultra`);
  assert.ok(by.length <= 200);
  assert.ok(by.includes('notes by'), 'the research credit goes, not the notes');
  assert.ok(!by.includes('cast by'));
});
