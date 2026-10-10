import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { QueueBook } from '../lib.ts';
import { answerWith, calls } from './nvidia.ts';
import { epub, MARKS } from './lantern.ts';

/*
 * Marking and fixing (mark.ts) on The Test Lantern (lantern.ts), with NVIDIA played by the test: a
 * garbled answer is refused and asked again, a part with errors is fixed again and again while
 * each round leaves fewer, and a fix with more is let go. Each error here is a line spoken by
 * someone who isn't in the cast.
 */

const work = mkdtempSync(join(tmpdir(), 'breader-ai-test-'));
process.env.AI_WORK = join(work, 'work');
process.env.AI_OUT = join(work, 'out');
const { Balancer } = await import('../balancer.ts');
const { castPass } = await import('../cast.ts');
const { startBook } = await import('../fetch.ts');
const { LADDER } = await import('../kimi.ts');
const { garbled, markParts, marksFile } = await import('../mark.ts');

const CAST = `cast elena F | Elena | A traveller | 0:3 "she said"
cast marlo M | Marlo | Meets Elena at the ferry | 0:4 "He called it"
cast masked-knight M | The masked knight | A knight in a mask | 1:1, as the reader believes
cast ines F | Ines | Marlo's sister | 1:3
change masked-knight 1:3 F | Unmasked as Ines`;

const ONE_ERROR = MARKS.replace('0:2.1 marlo', '0:2.1 nobody');
const TWO_ERRORS = ONE_ERROR.replace('0:3.1 elena', '0:3.1 somebody');
const THREE_ERRORS = TWO_ERRORS.replace('1:4.1 ines', '1:4.1 anybody');
/** Nonsense in every script, the way Kimi K3 now and then answers a part. */
const GARBLED = Array.from({ length: 40 }, (_, i) => `zq${i} wv 我感到 <|im_sep|> ýŒá ハイント xo:${i} — qq vv ww ${'ab '.repeat(10)}`).join('\n');

/** What the model sends back for each mark and fix, in turn: after the marks run out, three errors. */
let marks: string[] = [];
let fixes: string[] = [];
answerWith((_model, user) => {
  if (user.includes('# Fix these')) return `=== part 1 ===\n${fixes.shift()}`;
  if (user.includes('# Mark part 1')) return marks.shift() ?? THREE_ERRORS;
  return CAST;
});

const lb = new Balancer(LADDER, { waitForTopS: 300, strikesToFall: 3, maxTries: Infinity, patient: true });
const bytes = await epub();
const sha256 = createHash('sha256').update(bytes).digest('hex');
const b: QueueBook = {
  rank: 1,
  key: `the-test-lantern-${sha256.slice(0, 8)}`,
  sha256,
  title: 'The Test Lantern',
  author: 'A. Tester',
  format: 'EPUB',
  size: bytes.length,
  r2Key: 'x',
  started: false,
  progress: 0,
  lastRead: '2026-01-01T00:00:00.000Z',
  added: '2026-01-01T00:00:00.000Z',
  readers: 1,
};
const { book } = await startBook(b, bytes);
await castPass(book, lb);

const fixCalls = () => calls.filter((c) => c.user.includes('# Fix these')).length;
const markCalls = () => calls.filter((c) => c.user.includes('# Mark part 1')).length;

test('marks, a fix with its part headings and cast lines, and an empty answer aren’t garbled', () => {
  assert.equal(garbled(MARKS, true), null);
  assert.equal(garbled(`=== part 1 ===\n${MARKS}\ncast nobody M | Nobody | A stranger | 0:2 "he"`, true), null);
  assert.equal(garbled('', true), null);
});

test('nonsense is garbled, judged as it comes in once there’s enough of it', () => {
  assert.equal(garbled(GARBLED, true), 'a garbled answer: 0 of its 40 lines read as marks');
  assert.equal(garbled(GARBLED.slice(0, 1000), false), null, 'too little yet');
  assert.match(garbled(GARBLED.slice(0, 3000), false) ?? '', /^a garbled answer/);
  assert.equal(garbled(`${MARKS}0:9 ${'x'.repeat(400)}`, true), null, 'one long line among marks');
  assert.match(garbled(`0:1 ${'x'.repeat(400)}\n0:2 ${'x'.repeat(400)}`, true) ?? '', /^a garbled answer: 0 of its 2/, 'long lines that start like marks');
});

test('a garbled answer is refused and the part asked again, a size smaller', async () => {
  marks = [GARBLED, MARKS];
  fixes = [];
  const before = markCalls();
  const failed = await markParts(book, [1], lb);
  assert.deepEqual(failed, []);
  assert.equal(markCalls() - before, 2);
  assert.equal(readFileSync(marksFile(book, 1), 'utf8'), MARKS);
});

test('a part is fixed again and again while each round leaves fewer errors', async () => {
  fixes = [TWO_ERRORS, ONE_ERROR, MARKS];
  const before = fixCalls();
  const failed = await markParts(book, [1], lb);
  assert.deepEqual(failed, []);
  assert.equal(fixCalls() - before, 3);
  assert.equal(readFileSync(marksFile(book, 1), 'utf8'), MARKS);
});

test('a fix with more errors is let go, the part keeps its marks, and fixing stops', async () => {
  fixes = [ONE_ERROR, THREE_ERRORS, MARKS];
  const before = fixCalls();
  const failed = await markParts(book, [1], lb);
  assert.deepEqual(failed, [1]);
  assert.equal(fixCalls() - before, 2);
  assert.equal(readFileSync(marksFile(book, 1), 'utf8'), ONE_ERROR);
});
