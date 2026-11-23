import { describe, expect, it } from 'vitest';
import { pageTitle } from './pageTitle';

describe('pageTitle', () => {
  it('names the book first, then Breader', () => {
    expect(pageTitle('The Lighthouse')).toBe('The Lighthouse · Breader');
  });

  it('is plain Breader with no name', () => {
    expect(pageTitle(undefined)).toBe('Breader');
    expect(pageTitle(null)).toBe('Breader');
    expect(pageTitle('')).toBe('Breader');
    expect(pageTitle('   ')).toBe('Breader');
  });

  it('drops spaces around the name', () => {
    expect(pageTitle('  Dune \n')).toBe('Dune · Breader');
  });
});
