import { describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/api', () => ({
  api: { onVia: () => () => {} },
}));

import { sentencesIn } from './narration';

/** The sentences `sentencesIn` finds, as text. */
const split = (text: string, from = 0) => sentencesIn(text, from).map(([a, b]) => text.slice(a, b));

describe('sentencesIn', () => {
  it('splits plain sentences at . ! and ?', () => {
    expect(split('First one. Second one! Third one?')).toEqual(['First one. ', 'Second one! ', 'Third one?']);
  });

  it('keeps an initial with the name after it', () => {
    expect(split('It was by O. Henry. Then we left.')).toEqual(['It was by O. Henry. ', 'Then we left.']);
  });

  it('keeps several initials in a row together', () => {
    expect(split('J. R. R. Tolkien wrote The Hobbit.')).toEqual(['J. R. R. Tolkien wrote The Hobbit.']);
  });

  it('keeps initials in other alphabets', () => {
    expect(split('А. С. Пушкин написал это. Потом мы ушли.')).toEqual(['А. С. Пушкин написал это. ', 'Потом мы ушли.']);
  });

  it('keeps an initial right after an opening quote or bracket', () => {
    expect(split('“O. Henry,” she said. (J. Smith agreed.)')).toEqual(['“O. Henry,” she said. ', '(J. Smith agreed.)']);
  });

  it('still ends a sentence at "I."', () => {
    expect(split('So did I. Then we left.')).toEqual(['So did I. ', 'Then we left.']);
  });

  it('ends a sentence at a small single letter', () => {
    expect(split('Call it x. Then we left.')).toEqual(['Call it x. ', 'Then we left.']);
  });

  it('keeps the known short forms', () => {
    expect(split('Mr. Smith met Dr. Watson, e.g. this morning.')).toEqual(['Mr. Smith met Dr. Watson, e.g. this morning.']);
    expect(split('“Mr. Smith,” she said.')).toEqual(['“Mr. Smith,” she said.']);
  });

  it('starts at `from`', () => {
    const text = 'Skip this. Read this, by O. Henry. And this.';
    expect(split(text, 'Skip this. '.length)).toEqual(['Read this, by O. Henry. ', 'And this.']);
  });

  it('finds nothing in empty or unsayable text', () => {
    expect(split('')).toEqual([]);
    expect(split('... !!! ?')).toEqual([]);
  });
});
