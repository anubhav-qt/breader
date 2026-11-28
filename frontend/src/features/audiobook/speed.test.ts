import { describe, expect, it } from 'vitest';
import { devicePace, lanesFor, learn, timer, type Device } from './speed';

const desktop: Device = { cores: 16, memory: 32, handheld: false };
const laptop: Device = { cores: 4, memory: 8, handheld: false };
const phone: Device = { cores: 8, memory: 8, handheld: true };
const smallPhone: Device = { cores: 8, memory: 3, handheld: true };
const old: Device = { cores: 2, memory: 2, handheld: false };

describe('lanesFor', () => {
  it('runs one engine at Minimal, whatever the device', () => {
    for (const d of [desktop, laptop, phone, old]) {
      expect(lanesFor('min', d)).toBe(1);
    }
  });

  it('gives about one engine for two threads, six at most', () => {
    expect(lanesFor('max', desktop)).toBe(6);
    expect(lanesFor('max', { ...desktop, cores: 64 })).toBe(6);
    expect(lanesFor('max', laptop)).toBe(2);
  });

  it('counts threads, not just the cap: 8 threads get 3, 10 get 4', () => {
    expect(lanesFor('max', { cores: 8, memory: 16, handheld: false })).toBe(3);
    expect(lanesFor('max', { cores: 10, memory: 16, handheld: false })).toBe(4);
  });

  it('never gives fewer than one', () => {
    expect(lanesFor('max', old)).toBe(1);
    expect(lanesFor('max', { cores: 1, memory: 0.5, handheld: false })).toBe(1);
  });

  it('keeps a phone to three, and fewer when it has little memory', () => {
    expect(lanesFor('max', phone)).toBe(3);
    expect(lanesFor('max', smallPhone)).toBe(2);
    expect(lanesFor('max', { cores: 12, memory: 12, handheld: true })).toBe(3);
  });
});

describe('devicePace', () => {
  const none = { mode: 'max' as const, pace: {} };

  it('uses what was measured making a book here, over any guess', () => {
    const k = { mode: 'max' as const, score: 1, pace: { 'phonon:max': 33.3, 'piper:min': 50 } };
    expect(devicePace('phonon', 'max', k, desktop)).toBe(33.3);
    // Only for that engine and mode: Piper's pace from before isn't Phonon's.
    expect(devicePace('phonon', 'min', k, desktop)).toBe(5);
  });

  it('guesses from the processor check, faster with more engines', () => {
    const k = { ...none, score: 1.27 };
    const one = devicePace('phonon', 'min', k, desktop);
    const six = devicePace('phonon', 'max', k, desktop);
    expect(one).toBeCloseTo(6.35, 1);
    expect(six).toBeGreaterThan(one * 5);
    expect(six).toBeLessThan(one * 6);
  });

  it('guesses slower for a phone that has not been checked yet', () => {
    expect(devicePace('phonon', 'min', none, phone)).toBeLessThan(devicePace('phonon', 'min', none, desktop));
  });

  it('guesses faster at Maximum than Minimal', () => {
    expect(devicePace('phonon', 'max', none, desktop)).toBeGreaterThan(devicePace('phonon', 'min', none, desktop));
  });
});

describe('learn', () => {
  it('keeps a real pace, and what it keeps is used', () => {
    learn('phonon', 'max', 21.234);
    expect(devicePace('phonon', 'max', undefined, desktop)).toBe(21.23);
  });

  it('keeps nothing that isn’t a real pace', () => {
    learn('phonon', 'min', 4);
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 0, -5]) learn('phonon', 'min', bad);
    expect(devicePace('phonon', 'min', undefined, desktop)).toBe(4);
  });
});

describe('timer', () => {
  /** A clock moved by hand, and the pace it kept. */
  const run = (steps: Array<[number, number]>) => {
    let t = 0;
    const tick = timer('phonon', 'max', () => t);
    for (const [at, sound] of steps) { t = at; tick(sound); }
    return devicePace('phonon', 'max', undefined, desktop);
  };

  it('starts timing at the first paragraph, which is not counted', () => {
    // 600 s of sound in 10 s after the first: 60 times.
    expect(run([[1000, 99], [11_000, 600]])).toBe(60);
  });

  it('waits for five minutes of sound before keeping anything', () => {
    learn('phonon', 'max', 1);
    expect(run([[0, 5], [1000, 299]])).toBe(1);
    expect(run([[0, 5], [1000, 300]])).toBe(300);
  });

  it('keeps it at most every five seconds', () => {
    // Kept at 10 s (400 s of sound: 40x); not again at 12 s; again at 15 s (1000 s: 66.67x).
    learn('phonon', 'max', 1);
    let t = 0;
    const tick = timer('phonon', 'max', () => t);
    tick(0);
    t = 10_000; tick(400);
    expect(devicePace('phonon', 'max', undefined, desktop)).toBe(40);
    t = 12_000; tick(400);
    expect(devicePace('phonon', 'max', undefined, desktop)).toBe(40);
    t = 15_000; tick(200);
    expect(devicePace('phonon', 'max', undefined, desktop)).toBe(66.67);
  });
});
