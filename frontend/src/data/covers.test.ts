import { describe, expect, it } from 'vitest';
import type { BookRecord } from '../books/types';
import { shownCover } from './library';

const covers = { a: 'blob:cover' };

function rec(over: Partial<BookRecord>): BookRecord {
  return { id: 'a', title: 'A', author: '', format: 'EPUB', source: 'file', shared: false, addedAt: 0, words: 0, color: 'ink', hasCover: true, progress: 0, line: '', lastOpened: 0, ...over };
}

describe('which covers show', () => {
  it('shows a new cover of a reader’s own book only once the model said yes to it', () => {
    expect(shownCover(rec({ coverOk: false }), covers)).toBeUndefined();
    expect(shownCover(rec({ coverOk: true }), covers)).toBe('blob:cover');
  });

  it('shows a cover from before the check until the model says no', () => {
    expect(shownCover(rec({}), covers)).toBe('blob:cover');
  });

  it('shows a manga’s, a sample’s and a preview’s as they are', () => {
    expect(shownCover(rec({ source: 'remote' }), covers)).toBe('blob:cover');
    expect(shownCover(rec({ format: 'CBZ' }), covers)).toBe('blob:cover');
    expect(shownCover(rec({ source: 'sample' }), covers)).toBe('blob:cover');
    expect(shownCover(rec({ source: 'placeholder' }), covers)).toBe('blob:cover');
  });

  it('shows nothing where this browser holds no picture', () => {
    expect(shownCover(rec({ coverOk: true, id: 'b' }), covers)).toBeUndefined();
  });
});
