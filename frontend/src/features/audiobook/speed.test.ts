import { describe, expect, it } from 'vitest';
import { devicePace, lanesFor, learn, SERVER_PACE, timer, type Device } from './speed';

const desktop: Device = { cores: 16, memory: 32, handheld: false };
const laptop: Device = { cores: 4, memory: 8, handheld: false };
const phone: Device = { cores: 8, memory: 8, handheld: true };
const smallPhone: Device = { cores: 8, memory: 3, handheld: true };
const old: Device = { cores: 2, memory: 2, handheld: false };

describe('lanesFor', () => {
  it('runs one engine at Minimal, whatever the device', () => {
    for (const d of [desktop, laptop, phone, old]) {
      expect(lanesFor('piper', 'min', d)).toBe(1);
      expect(lanesFor('kokoro', 'min', d)).toBe(1);
    }
  });

  it('gives Piper about one engine for two threads, six at most', () => {
    expect(lanesFor('piper', 'max', desktop)).toBe(6);
    expect(lanesFor('piper', 'max', { ...desktop, cores: 64 })).toBe(6);
    expect(lanesFor('piper', 'max', laptop)).toBe(2);
  });

  it('counts threads, not just the cap: 8 threads get 3, 10 get 4', () => {
    expect(lanesFor('piper', 'max', { cores: 8, memory: 16, handheld: false })).toBe(3);
    expect(lanesFor('piper', 'max', { cores: 10, memory: 16, handheld: false })).toBe(4);
  });

  it('never gives fewer than one', () => {
    expect(lanesFor('piper', 'max', old)).toBe(1);
    expect(lanesFor('piper', 'max', { cores: 1, memory: 0.5, handheld: false })).toBe(1);
  });

  it('keeps a phone to three, and fewer when it has little memory', () => {
    expect(lanesFor('piper', 'max', phone)).toBe(3);
    expect(lanesFor('piper', 'max', smallPhone)).toBe(2);
    expect(lanesFor('piper', 'max', { cores: 12, memory: 12, handheld: true })).toBe(3);
  });

  it('gives Kokoro two on a computer, one on a phone', () => {
    expect(lanesFor('kokoro', 'max', desktop)).toBe(2);
    expect(lanesFor('kokoro', 'max', phone)).toBe(1);
  });
});

describe('devicePace', () => {
  const none = { mode: 'max' as const, pace: {} };

  it('uses what was measured making a book here, over any guess', () => {
    const k = { mode: 'max' as const, score: 1, pace: { 'piper:max': 33.3 } };
    expect(devicePace('piper', 'max', k, desktop)).toBe(33.3);
    // Only for that engine and mode.
    expect(devicePace('piper', 'min', k, desktop)).toBe(6);
  });

  it('guesses Piper from the processor check, faster with more engines', () => {
    const k = { ...none, score: 1.27 };
    const one = devicePace('piper', 'min', k, desktop);
    const six = devicePace('piper', 'max', k, desktop);
    expect(one).toBeCloseTo(7.62, 1);
    expect(six).toBeGreaterThan(one * 5);
    expect(six).toBeLessThan(one * 6);
  });

  it('guesses slower for a phone that has not been checked yet', () => {
    expect(devicePace('piper', 'min', none, phone)).toBeLessThan(devicePace('piper', 'min', none, desktop));
  });

  it('guesses Kokoro faster at Maximum than Minimal', () => {
    expect(devicePace('kokoro', 'max', none, desktop)).toBeGreaterThan(devicePace('kokoro', 'min', none, desktop));
  });

  it('keeps Breader’s computer apart', () => {
    expect(SERVER_PACE.piper).toBeGreaterThan(SERVER_PACE.kokoro);
  });
});

describe('learn', () => {
  it('keeps a real pace, and what it keeps is used', () => {
    learn('piper', 'max', 21.234);
    expect(devicePace('piper', 'max', undefined, desktop)).toBe(21.23);
  });

  it('keeps nothing that isn’t a real pace', () => {
    learn('kokoro', 'min', 4);
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 0, -5]) learn('kokoro', 'min', bad);
    expect(devicePace('kokoro', 'min', undefined, desktop)).toBe(4);
  });
});

describe('timer', () => {
  /** A clock moved by hand, and the pace it kept. */
  const run = (steps: Array<[number, number]>) => {
    let t = 0;
    const tick = timer('kokoro', 'max', () => t);
    for (const [at, sound] of steps) { t = at; tick(sound); }
    return devicePace('kokoro', 'max', undefined, desktop);
  };

  it('starts timing at the first paragraph, which is not counted', () => {
    // 60 s of sound in 10 s after the first: 6 times.
    expect(run([[1000, 99], [11_000, 60]])).toBe(6);
  });

  it('waits for half a minute of sound before keeping anything', () => {
    learn('kokoro', 'max', 1);
    expect(run([[0, 5], [1000, 29]])).toBe(1);
    expect(run([[0, 5], [1000, 30]])).toBe(30);
  });

  it('keeps it at most every five seconds', () => {
    // Kept at 10 s (40 s of sound: 4x); not again at 12 s; again at 15 s (100 s: 6.67x).
    learn('kokoro', 'max', 1);
    let t = 0;
    const tick = timer('kokoro', 'max', () => t);
    tick(0);
    t = 10_000; tick(40);
    expect(devicePace('kokoro', 'max', undefined, desktop)).toBe(4);
    t = 12_000; tick(40);
    expect(devicePace('kokoro', 'max', undefined, desktop)).toBe(4);
    t = 15_000; tick(20);
    expect(devicePace('kokoro', 'max', undefined, desktop)).toBe(6.67);
  });
});
