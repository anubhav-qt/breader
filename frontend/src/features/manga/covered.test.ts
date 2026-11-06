import { describe, expect, it } from 'vitest';
import { stillCovered } from './covered';

describe('stillCovered', () => {
  it('skips drawing only while the reader stays over the page', () => {
    expect(stillCovered({ covered: true }, { covered: true })).toBe(true);
  });

  it('draws as the reader opens over it, so it rests as it was left', () => {
    expect(stillCovered({ covered: false }, { covered: true })).toBe(false);
  });

  it('draws as the reader closes, catching up', () => {
    expect(stillCovered({ covered: true }, { covered: false })).toBe(false);
  });

  it('draws as usual when nothing covers it', () => {
    expect(stillCovered({ covered: false }, { covered: false })).toBe(false);
  });
});
