import { describe, expect, it } from 'vitest';
import { inOrder } from './order';

const track = (from: number) => {
  const runs: Array<[number, number]> = [];
  return { runs, add: inOrder(from, (done, bytes) => runs.push([done, bytes])) };
};

describe('inOrder', () => {
  it('moves on part by part when they come in order', () => {
    const t = track(0);
    t.add(0, 10);
    t.add(1, 20);
    expect(t.runs).toEqual([[1, 10], [2, 20]]);
  });

  it('waits for a gap to fill, then takes in everything after it at once', () => {
    const t = track(0);
    t.add(2, 30);
    t.add(1, 20);
    expect(t.runs).toEqual([]);
    t.add(0, 10);
    expect(t.runs).toEqual([[3, 60]]);
  });

  it('starts where the book was left, not at the first part', () => {
    const t = track(5);
    t.add(6, 1);
    expect(t.runs).toEqual([]);
    t.add(5, 2);
    expect(t.runs).toEqual([[7, 3]]);
  });

  it('ignores a part from before where it started, and one sent twice', () => {
    const t = track(3);
    t.add(1, 99);
    t.add(3, 1);
    t.add(3, 1);
    expect(t.runs).toEqual([[4, 1]]);
  });

  it('says nothing while only later parts arrive', () => {
    const t = track(0);
    for (const n of [4, 3, 2, 1]) t.add(n, 1);
    expect(t.runs).toEqual([]);
  });
});
