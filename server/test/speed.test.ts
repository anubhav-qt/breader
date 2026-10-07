import { describe, expect, it } from 'vitest';
import { Speeds } from '../src/manga/speed.ts';

/* How long each source takes over a lot it hasn't seen, from the lots it answered. */

const HOUR = 3_600_000;

describe('a source’s speed', () => {
  it('is not known until a lot made calls enough of its site, and counts as quick until then', () => {
    const s = new Speeds();
    s.took('a', 30_000, 3, 0);
    expect(s.lotTime('a', 0)).toBeNull();
    expect(s.quick('a', 12_000, 0)).toBe(true);
  });

  it('takes each lot as if it made every call: its list and two for each of ten series', () => {
    const s = new Speeds();
    s.took('a', 10_000, 10, 0);
    expect(s.lotTime('a', 0)).toBe(21_000);
    expect(s.quick('a', 12_000, 0)).toBe(false);
  });

  it('goes by the middle of its last three lots', () => {
    const s = new Speeds();
    for (const ms of [40_000, 4_000, 5_000, 6_000]) s.took('a', ms, 21, 0);
    expect(s.lotTime('a', 0)).toBe(5_000);
    s.took('a', 50_000, 21, 0);
    expect(s.lotTime('a', 0)).toBe(6_000);
    s.took('a', 50_000, 21, 0);
    expect(s.lotTime('a', 0)).toBe(50_000);
  });

  it('forgets lots after six hours, so a slow source is tried again', () => {
    const s = new Speeds();
    s.took('a', 40_000, 21, 0);
    expect(s.quick('a', 12_000, 5 * HOUR)).toBe(false);
    expect(s.quick('a', 12_000, 6 * HOUR)).toBe(true);
  });
});
