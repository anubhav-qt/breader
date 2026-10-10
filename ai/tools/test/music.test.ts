import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Book } from '../lib.ts';
import type { Brain } from '../harness.ts';
import type { CatalogTrack } from '../music.ts';

/*
 * A book's score from the model's lines (music.ts): how the lines are read, what check tells the
 * model to fix, and the cues and tracks that go in the book's file. A made-up book of two
 * chapters and three tracks, no network.
 */

process.env.AI_WORK = mkdtempSync(join(tmpdir(), 'breader-ai-test-'));
const { buildScore, cueProblems, parseCues, soundtrackTools } = await import('../music.ts');

const paragraph = (text: string) => ({ tag: 'p', text, words: text.split(' ').length });

/** Two chapters, a part each. Chapter 1's third paragraph is a scene break with no words. */
const BOOK: Book = {
  v: 1,
  key: 'two-chapters-00000001',
  sha256: '1'.padStart(64, '0'),
  title: 'Two Chapters',
  author: '',
  format: 'EPUB',
  kind: 'flow',
  words: 40,
  style: 'double',
  sections: [
    { title: 'One', blocks: [paragraph('Chapter one'), paragraph('It begins.'), paragraph('* * *'), paragraph('A fight.'), paragraph('It ends.')], words: 20, print: '5:00000000' },
    { title: 'Two', blocks: [paragraph('Chapter two'), paragraph('Quiet.'), paragraph('A storm.'), paragraph('Home.')], words: 20, print: '4:00000000' },
  ],
  parts: [
    { n: 1, from: [0, 0], to: [0, 4], words: 20 },
    { n: 2, from: [1, 0], to: [1, 3], words: 20 },
  ],
  segs: [],
  stray: [],
};

function track(n: number, use = `Track ${n}'s feel.`): CatalogTrack {
  return { id: `track${n}`.padEnd(11, 'x'), title: `Track ${n}`, source: 'A channel', seconds: 120 + n, album: 'Season one', use, official: true, sound: '' };
}
const TRACKS = [track(1, 'Long use. '.repeat(40)), track(2), track(3)];

test('lines are read with their paragraph and track; anything else is counted as odd', () => {
  const said = parseCues(['```', 'Here are the lines:', '0:1 2 | it begins', '- 0:3 SILENCE | a breath', '', '0:4 3', '```'].join('\n'));
  assert.deepEqual(said.lines, [
    { at: '0:1', track: 2 },
    { at: '0:3', track: 0 },
    { at: '0:4', track: 3 },
  ]);
  assert.equal(said.odd, 1);
});

test('nothing loops: a line asking for it fits no shape', () => {
  const said = parseCues('1:1 3 loop | again and again\n1:2 silence');
  assert.deepEqual(said.lines, [{ at: '1:2', track: 0 }]);
  assert.equal(said.odd, 1);
});

test('check tells the model each problem with its lines', () => {
  const said = parseCues(['nonsense', '0:2 1', '0:4 9', '0:3 2', '1:1 2'].join('\n'));
  const problems = cueProblems(BOOK, BOOK.parts[0], said.lines, said.odd, TRACKS.length);
  assert.equal(problems.length, 5);
  assert.match(problems[0], /^1 line fits no shape/);
  assert.match(problems[1], /^0:2 isn.t a paragraph with text/);
  assert.match(problems[2], /^0:4 plays track 9, and the soundtrack has 3/);
  assert.match(problems[3], /^0:3 comes after 0:4/);
  assert.match(problems[4], /^1:1 isn.t in this part \(0:0 to 0:4\)/);
});

test('good lines have no problems', () => {
  const said = parseCues(['0:1 1', '0:3 silence', '0:4 2'].join('\n'));
  assert.deepEqual(cueProblems(BOOK, BOOK.parts[0], said.lines, said.odd, TRACKS.length), []);
});

test('the score has a cue only where the music changes, and tracks numbered by first use', () => {
  const answers = new Map([
    [1, ['0:0 silence', '0:1 2', '0:2 1 | no words here, so left out', '0:3 2 | the same again', '0:4 1'].join('\n')],
    [2, ['1:0 1 | still on from part 1', '1:1 silence', '1:2 3', '1:3 2'].join('\n')],
  ]);
  const score = buildScore(BOOK, TRACKS, answers);
  assert.deepEqual(score.cues, [
    [0, 1, 0],
    [0, 4, 1],
    [1, 1, -1],
    [1, 2, 2],
    [1, 3, 0],
  ]);
  assert.deepEqual(score.tracks.map((t) => t.id), [TRACKS[1].id, TRACKS[0].id, TRACKS[2].id]);
});

test('silence before the first track needs no cue', () => {
  const score = buildScore(BOOK, TRACKS, new Map([[1, '0:0 silence\n0:1 silence\n0:3 3']]));
  assert.deepEqual(score.cues, [[0, 3, 0]]);
});

test('the track already playing isn’t started again, but after silence it is', () => {
  const score = buildScore(BOOK, TRACKS, new Map([[1, '0:1 2\n0:3 2\n0:4 silence'], [2, '1:1 2']]));
  assert.deepEqual(score.cues, [[0, 1, 0], [0, 4, -1], [1, 1, 0]]);
});

test('a part with no answer adds nothing, and each track’s role is kept short', () => {
  const score = buildScore(BOOK, TRACKS, new Map([[2, '1:1 1']]));
  assert.deepEqual(score.cues, [[1, 1, 0]]);
  assert.equal(score.tracks[0].role.length, 200);
  assert.deepEqual(Object.keys(score.tracks[0]).sort(), ['id', 'role', 'seconds', 'source', 'title']);
});

test('the soundtrack is shown a page at a time, however many tracks it has', async () => {
  const tracks: CatalogTrack[] = [];
  for (let n = 1; n <= 90; n++) tracks.push(track(n));
  // The list doesn't call Gemini.
  const tools = soundtrackTools({} as Brain, { name: 'Two Chapters', made: '', summary: '', tracks });
  const list = tools.find((t) => t.name === 'soundtrack')!;
  const shown = async (args: { from?: number }) => {
    const result = await list.execute('call', args as never);
    const first = result.content[0];
    if (first.type !== 'text') throw new Error('not text');
    return first.text.split('\n');
  };

  const page = await shown({});
  assert.equal(page.length, 41);
  assert.match(page[0], /^1 \| /);
  assert.equal(page[40], '(Tracks 1 to 40 of 90: call soundtrack with from 41 for the rest.)');

  const last = await shown({ from: 81 });
  assert.equal(last.length, 10, 'the last page has no note');
  assert.match(last[9], /^90 \| /);

  await assert.rejects(shown({ from: 91 }), /has 90 tracks/);
});
