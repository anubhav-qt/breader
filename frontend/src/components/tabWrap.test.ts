import { describe, expect, it } from 'vitest';
import { wrapTab } from './tabWrap';

describe('wrapTab', () => {
  it('goes from the last stop round to the first', () => {
    expect(wrapTab(3, 2, false)).toBe(0);
  });

  it('goes back from the first stop round to the last', () => {
    expect(wrapTab(3, 0, true)).toBe(2);
  });

  it('lets the browser step between stops in the middle', () => {
    expect(wrapTab(3, 0, false)).toBeNull();
    expect(wrapTab(3, 1, false)).toBeNull();
    expect(wrapTab(3, 2, true)).toBeNull();
  });

  it('brings focus in from the dialog itself or from outside', () => {
    expect(wrapTab(3, -1, false)).toBe(0);
    expect(wrapTab(3, -1, true)).toBe(2);
  });

  it('keeps a single stop where it is, both ways', () => {
    expect(wrapTab(1, 0, false)).toBe(0);
    expect(wrapTab(1, 0, true)).toBe(0);
  });

  it('has nowhere to go in a dialog with no stops', () => {
    expect(wrapTab(0, -1, false)).toBeNull();
  });
});
