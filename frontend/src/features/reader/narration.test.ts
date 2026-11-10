import { describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/api', () => ({
  api: {
    onVia: () => () => {},
  },
}));

import { sentencesIn } from './narration';

const extract = (text: string, ranges: Array<[number, number]>) => ranges.map(([a, b]) => text.slice(a, b));

describe('sentencesIn', () => {
  it('does not split sentences on middle initials or authors with initials', () => {
    const text = 'It was by O. Henry. Then we left.';
    const sentences = sentencesIn(text, 0);
    expect(sentences).toHaveLength(2);
    expect(extract(text, sentences)).toEqual(['It was by O. Henry. ', 'Then we left.']);
  });

  it('keeps successive initials like J. R. R. Tolkien in one sentence', () => {
    const text = 'J. R. R. Tolkien wrote The Hobbit.';
    const sentences = sentencesIn(text, 0);
    expect(sentences).toHaveLength(1);
    expect(extract(text, sentences)).toEqual(['J. R. R. Tolkien wrote The Hobbit.']);
  });

  it('does not split on known honorific and Latin abbreviations', () => {
    const text = 'Mr. Smith visited Dr. Watson, e.g. this morning.';
    const sentences = sentencesIn(text, 0);
    expect(sentences).toHaveLength(1);
    expect(extract(text, sentences)).toEqual(['Mr. Smith visited Dr. Watson, e.g. this morning.']);
  });

  it('splits ordinary sentences normally', () => {
    const text = 'First sentence. Second sentence! Third sentence?';
    const sentences = sentencesIn(text, 0);
    expect(sentences).toHaveLength(3);
    expect(extract(text, sentences)).toEqual([
      'First sentence. ',
      'Second sentence! ',
      'Third sentence?',
    ]);
  });

  it('respects the from parameter offset', () => {
    const text = 'Skip this part. Read this sentence. And this one.';
    const from = 'Skip this part. '.length;
    const sentences = sentencesIn(text, from);
    expect(sentences).toHaveLength(2);
    expect(extract(text, sentences)).toEqual(['Read this sentence. ', 'And this one.']);
  });
});
