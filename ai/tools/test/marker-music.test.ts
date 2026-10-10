import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AiFile } from '../../../shared/src/ai.ts';
import type { QueueBook } from '../lib.ts';
import type { OnServer } from '../marker.ts';
import type { Score } from '../music.ts';

/*
 * The marker's music: which books get it and in what order, where its credit goes in the file's
 * "by", that a file with music in it still passes the import's check, and music uploaded from the
 * admin page. Made-up books, no network.
 */

process.env.AI_WORK = mkdtempSync(join(tmpdir(), 'breader-ai-test-'));
const { checkFile } = await import('../import.ts');
const { writeJson } = await import('../lib.ts');
const { byWith, can, musicFailures, needsMusic, toMusic, withMusic } = await import('../marker.ts');
const { musicBy, musicLedgerFile } = await import('../music.ts');
const { fits, uploadProblems } = await import('../uploads.ts');

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

const marked = (music = false): OnServer => ({ made: '2026-01-01T00:00:00.000Z', by: 'Kimi K3 (reasoning high, NVIDIA) parts 1-3; research by Antigravity', notes: 0, music });
const titles = (books: QueueBook[]) => books.map((b) => b.title);

test('no book needs music where music can’t be made', () => {
  const b = book('Quiet');
  can.music = false;
  assert.equal(needsMusic(b, new Map([[b.sha256, marked()]])), false);
});

test('where it can, a marked book without music needs it; one not marked yet or with music doesn’t', () => {
  const b = book('Loud');
  can.music = true;
  assert.equal(needsMusic(b, new Map()), false, 'marks come first');
  assert.equal(needsMusic(b, new Map([[b.sha256, marked()]])), true);
  assert.equal(needsMusic(b, new Map([[b.sha256, marked(true)]])), false);
  can.music = false;
});

test('a series gets its music from its earliest volume, as its soundtrack starts there', () => {
  can.music = true;
  const s1 = book('Score 1', { series: 'Score', seriesIndex: 1 });
  const s2 = book('Score 2', { series: 'Score', seriesIndex: 2, started: true, lastRead: '2026-10-08T00:00:00.000Z' });
  const s3 = book('Score 3', { series: 'score', seriesIndex: 3 });
  const other = book('Solo', { started: true, lastRead: '2026-09-01T00:00:00.000Z' });
  const books = [other, s3, s2, s1];
  const server = new Map(books.map((b) => [b.sha256, marked()]));
  assert.deepEqual(titles(toMusic(books, server)), ['Score 1', 'Solo']);
  server.set(s1.sha256, marked(true));
  assert.deepEqual(titles(toMusic(books, server)), ['Score 2', 'Solo']);
  can.music = false;
});

test('music that keeps failing rests on its own, apart from marks and notes', () => {
  can.music = true;
  const b = book('Resting');
  const server = new Map([[b.sha256, marked()]]);
  musicFailures.set(b.sha256, { count: 1, next: Date.now() + 60_000 });
  assert.deepEqual(titles(toMusic([b], server)), []);
  musicFailures.clear();
  assert.deepEqual(titles(toMusic([b], server)), ['Resting']);
  can.music = false;
});

test('the music’s credit goes before the research’s, or last when there’s none', () => {
  assert.equal(byWith('Kimi parts 1-3; research by Antigravity', 'music', 'Gemini and Kimi'), 'Kimi parts 1-3; music by Gemini and Kimi; research by Antigravity');
  assert.equal(byWith('Kimi parts 1-3; notes by Kimi; cast by Kimi', 'music', 'Gemini'), 'Kimi parts 1-3; notes by Kimi; music by Gemini; cast by Kimi');
  assert.equal(byWith('Kimi parts 1-3', 'music', 'Gemini'), 'Kimi parts 1-3; music by Gemini');
});

test('music made again replaces its old credit, and leaves the notes’ alone', () => {
  const by = 'Kimi parts 1-3; notes by Kimi; music by Gemini; research by Antigravity';
  assert.equal(byWith(by, 'music', 'Gemini and Nemotron'), 'Kimi parts 1-3; notes by Kimi; music by Gemini and Nemotron; research by Antigravity');
});

/** A marked book's file as the server would have it: two chapters, no one in the cast. */
function serverFile(sha256: string): AiFile {
  return {
    v: 1,
    sha256,
    title: 'Two Chapters',
    author: '',
    format: 'EPUB',
    words: 40,
    made: '2026-01-01T00:00:00.000Z',
    by: 'Kimi K3 (reasoning high, NVIDIA) parts 1-2; research by Antigravity',
    sections: ['5:00000000', '4:00000000'],
    revisit: { people: [], places: [], terms: [] },
    voices: { cast: [], narration: [], spans: [] },
  };
}

const SCORE: Score = {
  made: '2026-01-02T00:00:00.000Z',
  tracks: [
    { id: 'aaaaaaaaaaa', title: 'Opening', source: 'A channel', seconds: 90, role: 'The main theme.' },
    { id: 'bbbbbbbbbbb', title: 'Rain', source: 'A channel', seconds: 150, role: 'Sad scenes.' },
  ],
  cues: [[0, 1, 0], [0, 4, -1], [1, 2, 1]],
};

test('a file with music in it passes the import’s check, with the music credited', () => {
  const b = book('Two Chapters');
  writeJson(musicLedgerFile(b), { plan: { model: 'kimi-k3', rounds: 1, secs: 1, at: '' }, parts: {} });
  const f = withMusic(serverFile(b.sha256), SCORE, musicBy(b));
  const c = checkFile(`${b.sha256}.json`, f);
  assert.deepEqual(c.problems, []);
  assert.deepEqual(c.data?.music, { tracks: SCORE.tracks, cues: SCORE.cues });
  assert.equal(f.by, 'Kimi K3 (reasoning high, NVIDIA) parts 1-2; music by Gemini and Kimi K3 (reasoning high, NVIDIA); research by Antigravity');
  assert.ok(f.made > '2026-01-01T00:00:00.000Z', 'made again, so readers fetch it again');
});

test('music cued past the book, or out of order, fails the check', () => {
  const b = book('Out Of Order');
  const bad: Score = { ...SCORE, cues: [[1, 2, 1], [0, 1, 0], [5, 0, 0]] };
  const c = checkFile(`${b.sha256}.json`, withMusic(serverFile(b.sha256), bad, musicBy(b)));
  assert.equal(c.problems.length, 2);
  assert.match(c.problems[0], /music: the cue at 0:1 is out of order/);
  assert.match(c.problems[1], /music: a cue at 5:0, which isn.t a paragraph/);
});

/** Music for serverFile's book, as the admin page would upload it. */
function uploaded(sha256: string) {
  return {
    sha256,
    sections: ['5:00000000', '4:00000000'],
    by: 'Gemini and Kimi K3 (reasoning high, NVIDIA)',
    score: { tracks: SCORE.tracks, cues: SCORE.cues },
    soundtrack: {
      name: 'Two Chapters',
      made: '2026-01-01T00:00:00.000Z',
      summary: 'Alternates: there is no adaptation.',
      tracks: SCORE.tracks.map((t) => ({ id: t.id, title: t.title, source: t.source, seconds: t.seconds, album: 'An album', use: t.role, official: false, sound: 'Quiet.' })),
    },
  };
}

test('uploaded music that’s sound has no problems, fits the book it was scored on, and goes in with its own credit', () => {
  const b = book('Uploaded');
  const { upload, problems } = uploadProblems(uploaded(b.sha256));
  assert.deepEqual(problems, []);
  const row = serverFile(b.sha256);
  assert.equal(fits(upload!, row), true);
  const c = checkFile(`${b.sha256}.json`, withMusic(row, upload!.score, upload!.by));
  assert.deepEqual(c.problems, []);
  assert.equal(c.data?.by, 'Kimi K3 (reasoning high, NVIDIA) parts 1-2; music by Gemini and Kimi K3 (reasoning high, NVIDIA); research by Antigravity');
  assert.deepEqual(c.data?.music, { tracks: SCORE.tracks, cues: SCORE.cues });
});

test('uploaded music doesn’t fit a book that reads differently, or another book', () => {
  const b = book('Read Again');
  const { upload } = uploadProblems(uploaded(b.sha256));
  const row = serverFile(b.sha256);
  assert.equal(fits(upload!, { ...row, sections: ['5:00000000', '4:11111111'] }), false);
  assert.equal(fits(upload!, { ...row, sections: ['5:00000000'] }), false);
  assert.equal(fits(upload!, serverFile('f'.repeat(64))), false);
});

test('uploaded music with cues past the book, a track missing from its soundtrack, or the wrong shape has problems', () => {
  const b = book('Broken Upload');
  const past = uploaded(b.sha256);
  past.score = { ...past.score, cues: [[0, 1, 0], [7, 0, 1]] };
  assert.match(uploadProblems(past).problems.join('\n'), /a cue at 7:0, which isn.t a paragraph/);

  const missing = uploaded(b.sha256);
  missing.soundtrack.tracks = missing.soundtrack.tracks.slice(1);
  assert.match(uploadProblems(missing).problems.join('\n'), /track aaaaaaaaaaa isn.t in the soundtrack/);

  const shape = uploadProblems({ ...uploaded(b.sha256), text: 'a whole chapter' });
  assert.equal(shape.upload, undefined);
  assert.ok(shape.problems.length > 0, 'nothing besides the score, its credit, the soundtrack and the prints');
});
