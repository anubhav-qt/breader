import { describe, expect, it } from 'vitest';
import type { ShelfItem } from '../../data/useLibrary';
import { nextIn, type Series } from './series';

const item = (id: string, progress: number, lastOpened = 0): ShelfItem =>
  ({ id, title: id, author: '', format: 'EPUB', source: 'file', shared: false, addedAt: 0, words: 1, color: 'ink', hasCover: true, progress, line: '', lastOpened }) as ShelfItem;
const series = (...books: ShelfItem[]): Series => ({ key: 'series:s', name: 'S', books });

describe('the book a series card stands on', () => {
  it('is the first book where no one’s reading shows, as in a shared library', () => {
    expect(nextIn(series(item('1', 0), item('2', 0), item('3', 0))).id).toBe('1');
  });

  it('is the book the reader is at, opened most lately', () => {
    expect(nextIn(series(item('1', 0.5, 10), item('2', 0), item('3', 0.2, 30))).id).toBe('3');
    expect(nextIn(series(item('1', 1, 50), item('2', 0.4, 20), item('3', 0))).id).toBe('2');
  });

  it('is the first not finished when none is begun, or the last once all are', () => {
    expect(nextIn(series(item('1', 1), item('2', 0), item('3', 0))).id).toBe('2');
    expect(nextIn(series(item('1', 1), item('2', 1))).id).toBe('2');
  });
});
