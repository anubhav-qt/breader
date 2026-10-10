import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Book } from '../lib.ts';

/*
 * A call asked again smaller (balancer.ts, Sized): which parts of the book it keeps at each level,
 * and how the parts left out are said. A made-up book of five parts, a hundred words each, and
 * one empty part that never counts.
 */

process.env.AI_WORK = mkdtempSync(join(tmpdir(), 'breader-ai-test-'));
const { bookDir, partName, writeJson } = await import('../lib.ts');
const { bookText, context, keptParts, SHRINKS } = await import('../kimi.ts');

const WORDS = [100, 100, 100, 0, 100, 100];

function book(): Book {
  const sections = WORDS.map((words, i) => ({
    title: `Chapter ${i + 1}`,
    blocks: [{ tag: 'p', text: `Part ${i + 1}.`, words }],
    words,
    print: '1:00000000',
  }));
  const parts = WORDS.map((words, i) => ({ n: i + 1, from: [i, 0] as [number, number], to: [i, 0] as [number, number], words }));
  const b: Book = {
    v: 1,
    key: 'five-parts-00000001',
    sha256: '1'.padStart(64, '0'),
    title: 'Five Parts',
    author: '',
    format: 'EPUB',
    kind: 'flow',
    words: 500,
    style: 'double',
    sections,
    parts,
    segs: [],
    stray: [],
  };
  const dir = join(bookDir(b.key), 'text');
  mkdirSync(dir, { recursive: true });
  for (const p of parts) writeFileSync(join(dir, `${partName(p.n)}.md`), `The text of part ${p.n}.`);
  writeJson(join(bookDir(b.key), 'book.json'), b);
  return b;
}

const b = book();

test('level 0 keeps every part with words', () => {
  assert.deepEqual(keptParts(b, null, 0), [1, 2, 3, 5, 6]);
  assert.deepEqual(keptParts(b, 3, 0), [1, 2, 3, 5, 6]);
});

test('each level keeps a fifth less of the book, from the start when there is no focus', () => {
  assert.equal(SHRINKS, 3);
  assert.deepEqual(keptParts(b, null, 1), [1, 2, 3, 5]);
  assert.deepEqual(keptParts(b, null, 2), [1, 2, 3]);
  assert.deepEqual(keptParts(b, null, 3), [1, 2]);
});

test('with a focus, the parts nearest it are kept, in the book’s order', () => {
  assert.deepEqual(keptParts(b, 5, 2), [3, 5, 6]);
  assert.deepEqual(keptParts(b, 5, 3), [5, 6]);
  assert.deepEqual(keptParts(b, 3, 3), [2, 3]);
});

test('a level past the smallest keeps as much as the smallest', () => {
  assert.deepEqual(keptParts(b, null, 9), keptParts(b, null, SHRINKS));
});

test('the parts left out are said once per gap, one part or a run of them', () => {
  const text = bookText(b, [1, 5]);
  assert.equal(text, [
    'The text of part 1.',
    '(Parts 2 to 3 are left out here, to keep this call smaller.)',
    'The text of part 5.',
    '(Part 6 is left out here, to keep this call smaller.)',
  ].join('\n\n'));
});

test('a book kept whole has no line about parts left out', () => {
  assert.doesNotMatch(bookText(b, keptParts(b, null, 0)), /left out/);
});

test('a smaller call says the book is cut down, and keeps the research whole', () => {
  assert.match(context(b), /^# The whole book\n/);
  const small = context(b, 1, 3);
  assert.match(small, /^# The book, cut down for this call\n/);
  assert.match(small, /# Research notes\n\n\(none\)/);
  assert.match(small, /Parts 3 to 6 are left out/);
});
