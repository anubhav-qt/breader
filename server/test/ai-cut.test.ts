import { describe, expect, it } from 'vitest';
import { AiFile, aiProblems } from '@breader/shared';
import { cutAt, revisitFor, voicesFor } from '../src/lib/ai.ts';
import { aiFile } from './ai-fixture.ts';

const f = aiFile();
const at = (s: number, b: number) => revisitFor(f, [s, b]);
const people = (s: number, b: number) => at(s, b).people.map((p) => p.name);

describe('the spoiler line', () => {
  it('starts from a sound file', () => {
    expect(AiFile.parse(f)).toEqual(f);
    expect(aiProblems(f)).toEqual([]);
  });

  it('stops at the read mark, or goes to the end once the book is read', () => {
    expect(cutAt(null)).toEqual([0, 0]);
    expect(cutAt({ pos: { section: 1, block: 4 }, progress: 0.4 })).toEqual([1, 4]);
    expect(cutAt({ pos: { section: 0, block: 2 }, progress: 0.1, n: 1 })).toBeNull();
    expect(cutAt({ pos: { section: 2, block: 9 }, progress: 1 })).toBeNull();
  });

  it('shows no one before they come in', () => {
    expect(people(0, 0)).toEqual([]);
    expect(at(0, 0).places.map((p) => p.name)).toEqual(['The station']);
    expect(people(0, 5)).toEqual(['the girl']);
    expect(people(0, 6)).toEqual(['the girl', 'the stranger']);
  });

  it('goes by the name, the facts and the events so far', () => {
    const [anna] = at(1, 2).people;
    expect(anna).toMatchObject({ name: 'Anna', also: ['the girl'], about: 'A girl at the station.', events: [[0, 4, 'Misses her train.']], first: [0, 1], seen: [0, 1] });
    expect(at(1, 3).people[0].about).toBe('Anna, a painter.');
    expect(at(2, 5).people[0].events.map((e) => e[2])).toEqual(['Misses her train.', 'Leaves the city.']);
  });

  it('keeps a secret until the book tells it', () => {
    expect(people(1, 7)).toEqual(['Anna', 'the stranger', 'Tomas']);
    const later = at(1, 8).people;
    expect(later.map((p) => p.name)).toEqual(['Anna', 'Tomas']);
    expect(later[1]).toMatchObject({
      also: ['the stranger'],
      about: 'Anna’s brother, back from the sea.',
      events: [[1, 1, 'Follows Anna home.'], [1, 6, 'Writes to Anna.']],
      first: [0, 6],
    });
  });

  it('never lets a word from further on through', () => {
    const early = JSON.stringify(at(1, 2));
    for (const later of ['painter', 'Leaves the city', 'Tomas', 'tomas', 'brother', 'Mara', 'mara', 'landlady']) expect(early).not.toContain(later);
    expect(early).not.toContain('"id"');
    // Tomas is in by 1:7, but that he's the stranger isn't.
    const stranger = at(1, 7).people.find((p) => p.name === 'the stranger');
    expect(JSON.stringify(stranger)).not.toContain('Tomas');
  });

  it('gives it all once the book is read', () => {
    const all = revisitFor(f, null);
    expect(all.upTo).toBeNull();
    expect(all.people.map((p) => p.name)).toEqual(['Anna', 'Tomas', 'Mara']);
  });
});

describe('voice marks', () => {
  const v = voicesFor(f);

  it('says whose voice the narration takes, and only when it changes', () => {
    expect(v.narration).toEqual([
      [0, 0, 'F'],
      [1, 0, null],
      [1, 8, 'M'],
      [2, 0, null],
      [2, 5, 'M'],
    ]);
  });

  it('keeps the lines by a woman or a man, and nothing that names anyone', () => {
    expect(v.spans).toEqual([[0, 2, 0, 10, 'F'], [1, 9, 0, 4, 'M']]);
    expect(v.sections).toEqual(f.sections);
    const sent = JSON.stringify(v);
    for (const name of ['Anna', 'Tomas', 'stranger', 'anna']) expect(sent).not.toContain(name);
  });
});
