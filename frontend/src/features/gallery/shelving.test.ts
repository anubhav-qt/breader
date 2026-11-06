import { describe, expect, it } from 'vitest';
import { dateShelf } from './shelving';

describe('dateShelf', () => {
  const now = new Date(2026, 10, 20, 12).getTime();

  it('names a month of this year by itself', () => {
    expect(dateShelf(new Date(2026, 7, 4, 12).getTime(), now)).toBe('August');
  });

  it('names a month of last year with its year', () => {
    expect(dateShelf(new Date(2025, 11, 9, 12).getTime(), now)).toBe('December 2025');
  });

  it('keeps the newest shelves by how long ago', () => {
    expect(dateShelf(now - 2 * 86_400_000, now)).toBe('This week');
    expect(dateShelf(now - 10 * 86_400_000, now)).toBe('Last week');
  });
});
