import type { AiFile } from '@breader/shared';

/**
 * A small book's notes, as ai/tools/pack.ts would write them: three chapters of ten paragraphs.
 * A girl who gets her name in chapter 2, a stranger who turns out to be her brother at 1:8, a
 * woman who only comes in at the end, and a narration that changes hands.
 */
export function aiFile(sha256 = 'a'.repeat(64)): AiFile {
  return {
    v: 1,
    sha256,
    title: 'The Station',
    author: 'An Author',
    format: 'EPUB',
    words: 3000,
    made: '2026-09-29T08:00:00.000Z',
    by: 'a test',
    sections: ['10:0000000a', '10:0000000b', '10:0000000c'],
    revisit: {
      people: [
        {
          id: 'anna',
          names: [[0, 1, 'the girl'], [1, 2, 'Anna']],
          about: [[0, 1, 'A girl at the station.'], [1, 3, 'Anna, a painter.']],
          events: [[0, 4, 'Misses her train.'], [2, 5, 'Leaves the city.']],
        },
        {
          id: 'stranger',
          names: [[0, 6, 'the stranger']],
          about: [[0, 6, 'A man in a grey coat.']],
          events: [[1, 1, 'Follows Anna home.']],
          merge: [1, 8, 'tomas'],
        },
        {
          id: 'tomas',
          names: [[1, 5, 'Tomas']],
          about: [[1, 5, 'Anna’s brother, back from the sea.']],
          events: [[1, 6, 'Writes to Anna.']],
        },
        { id: 'mara', names: [[2, 2, 'Mara']], about: [[2, 2, 'The landlady.']], events: [] },
      ],
      places: [{ id: 'station', names: [[0, 0, 'The station']], about: [[0, 0, 'Where it starts.']], events: [] }],
      terms: [],
    },
    voices: {
      cast: [
        { id: 'anna', name: 'Anna', g: 'F', changes: [[2, 7, 'F']] },
        { id: 'stranger', name: 'the stranger', g: 'N', changes: [[1, 8, 'M']] },
        { id: 'tomas', name: 'Tomas', g: 'M' },
      ],
      narration: [[0, 0, -1, 0], [1, 0, -1, 1], [2, 0, -1, -1], [2, 5, 2, 2]],
      spans: [[0, 2, 0, 10, 'F', 0, 0], [0, 3, 5, 9, 'N', 1, 0], [1, 9, 0, 4, 'M', 1, 1]],
    },
  };
}
