import { describe, expect, it } from 'vitest';
import type { AniCard } from '@breader/shared/manga';
import { KeptNames, stepped, worthShowing } from './suggest';

const card = (id: number, title: string): AniCard => ({ id, title, names: [title], cover: true, kind: 'manga', format: 'Manga', status: 'ongoing', year: 2020, adult: false });

describe('the arrow keys over the names', () => {
  it('goes down from the box to the first name, and round back to the box', () => {
    expect(stepped(-1, 3, true)).toBe(0);
    expect(stepped(0, 3, true)).toBe(1);
    expect(stepped(2, 3, true)).toBe(-1);
  });

  it('goes up from the box to the last name, and round back to the box', () => {
    expect(stepped(-1, 3, false)).toBe(2);
    expect(stepped(1, 3, false)).toBe(0);
    expect(stepped(0, 3, false)).toBe(-1);
  });

  it('stays in the box when there are no names', () => {
    expect(stepped(-1, 0, true)).toBe(-1);
    expect(stepped(-1, 0, false)).toBe(-1);
  });
});

describe('whether the names are worth showing', () => {
  it('shows names that differ from what was typed', () => {
    expect(worthShowing('solo levl', [card(1, 'Solo Leveling')])).toBe(true);
    expect(worthShowing('naruto', [card(1, 'Naruto'), card(2, 'Boruto: Naruto Next Generations')])).toBe(true);
  });

  it('hides an empty list, or only the very name typed', () => {
    expect(worthShowing('xyzzy', [])).toBe(false);
    expect(worthShowing('one piece ', [card(1, 'One Piece')])).toBe(false);
    expect(worthShowing('ONE PIECE', [card(1, 'One Piece ')])).toBe(false);
  });
});

describe('the lists already fetched', () => {
  it('gives back a list kept, and nothing for one never asked', () => {
    const kept = new KeptNames();
    kept.set('a', [card(1, 'A')]);
    expect(kept.get('a')?.map((c) => c.title)).toEqual(['A']);
    expect(kept.get('b')).toBeUndefined();
  });

  it('lets the oldest go once it holds sixty, keeping one asked again', () => {
    const kept = new KeptNames();
    for (let i = 0; i < 60; i++) kept.set(`q${i}`, []);
    // Asked again, q0 is the newest now.
    kept.set('q0', []);
    kept.set('q60', []);
    expect(kept.size).toBe(60);
    expect(kept.get('q0')).toBeDefined();
    expect(kept.get('q1')).toBeUndefined();
    expect(kept.get('q60')).toBeDefined();
  });
});
