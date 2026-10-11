import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AiFile } from '../../../shared/src/ai.ts';
import type { QueueBook } from '../lib.ts';
import { answerWith, calls } from './nvidia.ts';
import { epub, MARKS } from './lantern.ts';

/*
 * What the marker does to a book, end to end, on The Test Lantern (lantern.ts) with NVIDIA
 * played by the test: the cast from the book alone, the marks, everyone's voices, the pack, then
 * notes merged into the file the server would have. Everything but R2 and the database.
 */

const work = mkdtempSync(join(tmpdir(), 'breader-ai-test-'));
process.env.AI_WORK = join(work, 'work');
process.env.AI_OUT = join(work, 'out');
const { Balancer } = await import('../balancer.ts');
const { castPass } = await import('../cast.ts');
const { withRandomVoices } = await import('../casting.ts');
const { startBook } = await import('../fetch.ts');
const { checkFile } = await import('../import.ts');
const { castByFile, castOf, LADDER, PRIMARY } = await import('../kimi.ts');
const { bookDir, OUT, readJson } = await import('../lib.ts');
const { markBook } = await import('../mark.ts');
const { matchCast, needs, withNotes } = await import('../marker.ts');
const { writeNotes } = await import('../notes.ts');

const CAST = `## The book
A short story, fiction, in the third person through Elena's eyes.

## Names
Elena. Marlo. The masked knight.

## Traps
The masked knight is not who they seem.

## Hidden identities
The masked knight is Ines, shown at 1:3.

cast elena F | Elena | A traveller | 0:3 "she said"
cast marlo M | Marlo | Meets Elena at the ferry | 0:4 "He called it"
cast masked-knight M | The masked knight | A knight in a mask | 1:1, as the reader believes
cast ines F | Ines | Marlo's sister | 1:3
change masked-knight 1:3 F | Unmasked as Ines
change marlo 99:1 F | At a paragraph the book doesn't have`;

const ROSTER = `entry person elena
name elena 0:1 | Elena
entry place ferrow
name ferrow 0:1 | Ferrow
entry person masked-knight
name masked-knight 1:1 | The masked knight
merge masked-knight 1:3 ines
entry person ines
name ines 1:3 | Ines
cast gate-keeper M | The gate keeper | Keeps the gate | 1:1 "he"`;

const PART = `about elena 0:1 | A traveller who comes to Ferrow in the rain.
event elena 0:3 | Arrives late because of the trains.
about ferrow 0:1 | A town where it rains.
about masked-knight 1:1 | A knight who hides behind a mask.
about ines 1:3 | Marlo’s sister, who rode in as the masked knight.`;

// The first answer gives the masked knight, a man until the reveal, a woman's voice: asked again, just for him.
const VOICES = `voice elena lessac af_heart
voice marlo ryan am_michael
voice masked-knight kristin bm_george
voice ines alba bf_isabella`;
const KNIGHT = 'voice masked-knight alan bm_george';

const unexpected: string[] = [];
answerWith((_model, user) => {
  if (user.includes('# Your task\n\nRead the whole book')) return CAST;
  if (user.includes('# Mark part 1')) return MARKS;
  if (user.includes('# Your task: the entries')) return ROSTER;
  if (user.includes('# Your task: part 1')) return PART;
  if (user.includes('# Your task: read them as a reader would')) return 'none';
  if (user.includes('# What was wrong with the last answer\n\n- masked-knight: piper’s kristin isn’t a man’s voice')) return KNIGHT;
  if (user.includes('# Who needs voices')) return VOICES;
  unexpected.push(user.slice(-300));
  return 400;
});

const lb = new Balancer(LADDER, { waitForTopS: 300, strikesToFall: 3, maxTries: Infinity, patient: true });
const top = new Balancer(PRIMARY, { waitForTopS: Infinity, strikesToFall: Infinity, maxTries: 6, patient: true });
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
const outFile = join(OUT, `${sha256}.json`);

test('the cast comes from the book alone, and research.md says so', async () => {
  const { book } = await startBook(b, bytes);
  await castPass(book, lb);
  const cast = castOf(book).people;
  assert.deepEqual(cast.filter((p) => !p.generic).map((p) => `${p.id} ${p.gender}`), ['elena F', 'marlo M', 'masked-knight M', 'ines F']);
  assert.deepEqual(cast.find((p) => p.id === 'masked-knight')?.changes?.map((c) => `${c.at} ${c.gender}`), ['1:3 F']);
  assert.equal(cast.find((p) => p.id === 'marlo')?.changes, undefined, 'a change at a paragraph the book doesn’t have is left out');
  assert.match(readFileSync(join(bookDir(b.key), 'research.md'), 'utf8'), /^# Research: The Test Lantern\n\nFrom the book alone, by kimi-k3/);
  assert.equal(readJson<{ model: string }>(castByFile(book)).model, 'kimi-k3');
});

test('then marked and packed into a file the server takes', async () => {
  await markBook(b.key, lb, top, {});
  assert.ok(existsSync(outFile));
  const f = readJson<AiFile>(outFile);
  assert.deepEqual(checkFile(`${sha256}.json`, f).problems, []);
  assert.equal(f.by, 'Kimi K3 (reasoning high, NVIDIA) parts 1; cast by Kimi K3 (reasoning high, NVIDIA)');
  assert.equal(f.voices.spans.length, 9);
  const voiced = f.voices.cast.filter((p) => p.voice).map((p) => `${p.id} ${p.voice!.piper} ${p.voice!.kokoro}`);
  assert.deepEqual(voiced, ['elena lessac af_heart', 'marlo ryan am_michael', 'masked-knight alan bm_george', 'ines alba bf_isabella']);
  assert.deepEqual(f.revisit, { people: [], places: [], terms: [] });
  assert.equal(needs(b, new Map([[sha256, { made: f.made, by: f.by, notes: 0 }]])), 'notes');
});

test('then notes, merged into the server’s file with anyone they added to the cast', async () => {
  const row = readJson<AiFile>(outFile);
  const { book } = await startBook(b, bytes);
  matchCast(book, row);
  await writeNotes(b.key, lb, top, { 'no-pack': true });
  const f = withNotes(row, book);
  assert.deepEqual(checkFile(`${sha256}.json`, f).problems, []);
  assert.deepEqual(f.revisit.people.map((e) => e.id), ['elena', 'masked-knight', 'ines']);
  assert.deepEqual(f.revisit.places.map((e) => e.id), ['ferrow']);
  assert.deepEqual(f.voices.cast.slice(0, row.voices.cast.length), row.voices.cast, 'the marks’ cast keeps its order');
  assert.deepEqual(f.voices.cast.slice(row.voices.cast.length).map((p) => p.id), ['gate-keeper']);
  assert.deepEqual(f.voices.spans, row.voices.spans);
  assert.equal(f.by, 'Kimi K3 (reasoning high, NVIDIA) parts 1; notes by Kimi K3 (reasoning high, NVIDIA); cast by Kimi K3 (reasoning high, NVIDIA)');
  assert.equal(needs(b, new Map([[sha256, { made: f.made, by: f.by, notes: 4 }]])), null);
});

test('a book marked before there were voices gets them at random, a woman’s for a woman and a man’s for a man', () => {
  const row = readJson<AiFile>(outFile);
  const bare: AiFile = { ...row, voices: { ...row.voices, cast: row.voices.cast.map(({ voice: _, ...p }) => p) } };
  const { file, given } = withRandomVoices(bare);
  assert.equal(given, 4);
  assert.deepEqual(checkFile(`${sha256}.json`, file).problems, []);
  const voiced = file.voices.cast.filter((p) => p.voice);
  assert.deepEqual(voiced.map((p) => p.id), ['elena', 'marlo', 'masked-knight', 'ines'], 'the generic speakers get none');
  assert.equal(new Set(voiced.map((p) => p.voice!.piper)).size, 4, 'no one shares a voice while there are others');
  assert.equal(withRandomVoices(file).given, 0, 'and anyone with voices keeps them');
});

test('a book marked somewhere else gets its cast from the server’s file', async () => {
  const row = readJson<AiFile>(outFile);
  const other: AiFile = { ...row, voices: { ...row.voices, cast: row.voices.cast.filter((p) => p.id !== 'marlo') } };
  const { book } = await startBook(b, bytes);
  matchCast(book, other);
  assert.deepEqual(castOf(book).people.map((p) => p.id), other.voices.cast.map((p) => p.id));
  assert.deepEqual(castOf(book).people.find((p) => p.id === 'masked-knight')?.changes, [{ at: '1:3', gender: 'F', why: 'As marked.' }]);
  assert.deepEqual(castOf(book).people.find((p) => p.id === 'elena')?.voice, { piper: 'lessac', kokoro: 'af_heart' }, 'with their voices');
});

test('no call went unanswered, and none came twice', () => {
  assert.deepEqual(unexpected, []);
  assert.equal(calls.length, 7);
});
