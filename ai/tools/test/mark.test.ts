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
 * Fixing marks (mark.ts) on The Test Lantern (lantern.ts), with NVIDIA played by the test: a part
 * with errors is fixed again and again while each round leaves fewer, and a fix with more is let
 * go. Each error here is a line spoken by someone who isn't in the cast.
 */

const work = mkdtempSync(join(tmpdir(), 'breader-ai-test-'));
process.env.AI_WORK = join(work, 'work');
process.env.AI_OUT = join(work, 'out');
const { Balancer } = await import('../balancer.ts');
const { castPass } = await import('../cast.ts');
const { startBook } = await import('../fetch.ts');
const { LADDER } = await import('../kimi.ts');
const { markParts, marksFile } = await import('../mark.ts');

const CAST = `cast elena F | Elena | A traveller | 0:3 "she said"
cast marlo M | Marlo | Meets Elena at the ferry | 0:4 "He called it"
cast masked-knight M | The masked knight | A knight in a mask | 1:1, as the reader believes
cast ines F | Ines | Marlo's sister | 1:3
change masked-knight 1:3 F | Unmasked as Ines`;

const ONE_ERROR = MARKS.replace('0:2.1 marlo', '0:2.1 nobody');
const TWO_ERRORS = ONE_ERROR.replace('0:3.1 elena', '0:3.1 somebody');
const THREE_ERRORS = TWO_ERRORS.replace('1:4.1 ines', '1:4.1 anybody');

/** What the model sends back for each fix, in turn. */
let fixes: string[] = [];
answerWith((_model, user) => {
  if (user.includes('# Fix these')) return `=== part 1 ===\n${fixes.shift()}`;
  if (user.includes('# Mark part 1')) return THREE_ERRORS;
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
