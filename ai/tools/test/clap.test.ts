import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import LABELS from '../clap-labels.json';

/*
 * CLAP's ear (clap.ts) without the model: the sound made into what the model takes, checked
 * against numbers from CLAP's own code (Transformers.js 3.7.5's ClapFeatureExtractor, with the
 * model's settings) for the same made-up sound; where the stretches are heard; and the words
 * chosen for a place among them.
 */

process.env.AI_WORK = mkdtempSync(join(tmpdir(), 'breader-ai-test-'));
const { FRAMES, SAMPLES, features, stretches, tenSeconds, unit, wordsFor } = await import('../clap.ts');

/** Three seconds: an A at 440 Hz throughout, and a softer tone at 3 kHz in the second half. */
function twoTones(): Float32Array {
  const n = 3 * 48_000;
  const wave = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    wave[i] = 0.3 * Math.sin((2 * Math.PI * 440 * i) / 48_000);
    if (i >= n / 2) wave[i] += 0.1 * Math.sin((2 * Math.PI * 3000 * i) / 48_000);
  }
  return wave;
}

test('ten seconds of sound come out as CLAP’s own code makes them', () => {
  const out = features(tenSeconds(twoTones()));
  assert.equal(out.length, FRAMES * 64);
  // [frame, band, decibels]: the A's band, the 3 kHz band before and after it starts, the silence at the end.
  const expected = [
    [0, 0, 4.191],
    [40, 6, 19.8309],
    [200, 6, 19.8309],
    [200, 36, 6.0718],
    [100, 36, -90.1612],
    [350, 36, -90.1612],
    [950, 6, -100],
    [1000, 6, -100],
  ];
  for (const [frame, band, db] of expected) {
    assert.ok(Math.abs(out[frame * 64 + band] - db) < 0.01, `frame ${frame}, band ${band}: ${out[frame * 64 + band]} dB, not ${db}`);
  }
});

test('a short stretch is repeated to fill ten seconds, then silence; a long one is cut', () => {
  const short = tenSeconds(new Float32Array(SAMPLES * 0.3).fill(1));
  assert.equal(short.length, SAMPLES);
  assert.equal(short[SAMPLES * 0.9 - 1], 1, 'three times over');
  assert.equal(short[SAMPLES * 0.9], 0, 'then silence');
  assert.equal(tenSeconds(new Float32Array(SAMPLES * 2).fill(0.5)).length, SAMPLES);
  assert.throws(() => tenSeconds(new Float32Array(0)), /no sound/);
});

test('the stretches are spread through the track, and none runs past its end', () => {
  assert.deepEqual(stretches(130), [15, 45, 75, 105]);
  assert.deepEqual(stretches(30), [3, 8, 13, 18]);
  assert.deepEqual(stretches(8), [0, 0, 0, 0]);
});

test('the nearest words in each group, as many as it picks', () => {
  const groups = [
    { name: 'mood', pick: 2, labels: [{ word: 'sad', vector: [1, 0, 0] }, { word: 'calm', vector: [0.6, 0.8, 0] }, { word: 'epic', vector: [0, 0, 1] }] },
    { name: 'pace', pick: 1, labels: [{ word: 'slow', vector: [0, 1, 0] }, { word: 'fast', vector: [0, 0, 1] }] },
  ];
  assert.equal(wordsFor(unit([0.9, 0.3, 0.1]), groups), 'sad and calm; slow');
  assert.equal(wordsFor(unit([0, 0.2, 0.9]), groups), 'epic and calm; fast');
});

test('every word has a place of the model’s size, scaled to length 1, and no group says a word twice', () => {
  for (const g of LABELS.groups) {
    const words = new Set<string>();
    for (const l of g.labels) {
      assert.equal(l.vector.length, 512, l.word);
      let sum = 0;
      for (const x of l.vector) sum += x * x;
      assert.ok(Math.abs(Math.sqrt(sum) - 1) < 0.001, l.word);
      words.add(l.word);
    }
    assert.equal(words.size, g.labels.length, g.name);
    assert.ok(g.pick >= 1 && g.pick < g.labels.length, g.name);
  }
});
