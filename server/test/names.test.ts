import { describe, expect, it } from 'vitest';
import { MANGA_KINDS, type AniCard } from '@breader/shared';
import { distance, keyed, Names, slackOf } from '../src/manga/names.ts';

/*
 * The names the server knows, looked through as a reader types (manga/names.ts): what's found for
 * a name begun, one spelt a letter or two off, and what's left out.
 */

let ids = 0;
function card(title: string, names: string[] = [], over: Partial<AniCard> = {}): AniCard {
  ids += 1;
  return { id: ids, title, names: [title, ...names], cover: true, kind: 'manga', format: 'Manga', status: 'ongoing', year: 2020, adult: false, ...over };
}

const SOLO = card('Solo Leveling', ['Na Honjaman Level Up', '나 혼자만 레벨업'], { kind: 'manhwa' });
const RAGNAROK = card('Solo Leveling: Ragnarok', [], { kind: 'manhwa' });
const ONE_PIECE = card('One Piece');
const OPM = card('One-Punch Man', ['Onepunch-Man']);
const FMA = card('Fullmetal Alchemist', ['Hagane no Renkinjutsushi', 'FMA']);
const JJK = card('Jujutsu Kaisen', ['呪術廻戦']);
const NARUTO = card('Naruto');
const ART = card('The Art of Reincarnation', [], { kind: 'manhua' });
const ADULT = card('Solo Night', [], { adult: true });
const TITAN = card('Attack on Titan', ['Shingeki no Kyojin']);
const NARITO = card('Narito');
const MONOGATARI = card('Kaisen Monogatari');
const BORUTO = card('Boruto: Naruto Next Generations');

function known(): Names {
  const names = new Names();
  const all = [ONE_PIECE, SOLO, JJK, FMA, OPM, NARUTO, TITAN, RAGNAROK, ART, ADULT, NARITO, MONOGATARI, BORUTO];
  all.forEach((c, i) => names.add(c, i));
  return names;
}

const EVERY = { adult: false, adultOnly: false, kinds: [...MANGA_KINDS] };
const look = (names: Names, q: string, over: Record<string, unknown> = {}) => names.look({ q, ...EVERY, ...over }).map((c) => c.title);

describe('the names the server knows', () => {
  it('finds a name begun, the most read first, those starting with it before a later word', () => {
    const names = known();
    expect(look(names, 'one p')).toEqual(['One Piece', 'One-Punch Man']);
    expect(look(names, 'solo lev')).toEqual(['Solo Leveling', 'Solo Leveling: Ragnarok']);
    // Jujutsu Kaisen is read more, but Kaisen Monogatari starts with it.
    expect(look(names, 'kaisen')).toEqual(['Kaisen Monogatari', 'Jujutsu Kaisen']);
    expect(look(names, 'leveling')).toEqual(['Solo Leveling', 'Solo Leveling: Ragnarok']);
  });

  it('finds a name spelt a letter or two off, however it is spaced', () => {
    const names = known();
    expect(look(names, 'solo levelling')).toEqual(['Solo Leveling', 'Solo Leveling: Ragnarok']);
    expect(look(names, 'one peice')).toEqual(['One Piece']);
    expect(look(names, 'full metal alchemist')).toEqual(['Fullmetal Alchemist']);
    expect(look(names, 'jujutsu kaisan')).toEqual(['Jujutsu Kaisen']);
    expect(look(names, 'chainsaw')).toEqual([]);
    expect(look(names, 'shingeki')).toEqual(['Attack on Titan']);
    expect(look(names, 'hagane no renkinjutsushi')).toEqual(['Fullmetal Alchemist']);
  });

  it('keeps to the closest, and to a name’s start, and never guesses its first letter', () => {
    const names = known();
    // Naruto as it's spelt, and Narito a letter off, only when nothing's spelt right.
    expect(look(names, 'naruto')).toEqual(['Naruto', 'Boruto: Naruto Next Generations']);
    // "narto" is Naruto or Narito a letter off; The Art of… only with its first letter dropped, and
    // Boruto only in a later word.
    expect(look(names, 'narto')).toEqual(['Naruto', 'Narito']);
    expect(look(names, 'maruto')).toEqual([]);
    // A short one must be right as it stands.
    expect(look(names, 'oen')).toEqual([]);
    expect(look(names, 'xyzzy')).toEqual([]);
  });

  it('finds nothing for a search of no letters or numbers', () => {
    const names = known();
    expect(look(names, '')).toEqual([]);
    expect(look(names, '<>')).toEqual([]);
    expect(look(names, '  !!  ')).toEqual([]);
  });

  it('gives the kinds asked for, and 18+ only as asked', () => {
    const names = known();
    expect(look(names, 'solo', { kinds: ['manga'] })).toEqual([]);
    expect(look(names, 'solo', { kinds: ['manhwa'] })).toEqual(['Solo Leveling', 'Solo Leveling: Ragnarok']);
    expect(look(names, 'solo')).toEqual(['Solo Leveling', 'Solo Leveling: Ragnarok']);
    expect(look(names, 'solo', { adult: true })).toEqual(['Solo Leveling', 'Solo Leveling: Ragnarok', 'Solo Night']);
    expect(look(names, 'solo', { adult: true, adultOnly: true })).toEqual(['Solo Night']);
  });

  it('gives eight at most, and keeps a series’ highest place', () => {
    const names = new Names();
    for (let i = 0; i < 12; i++) names.add(card(`Blue ${i}`), 100 + i);
    const late = card('Blue Lock');
    names.add(late, 1);
    names.add(late, 500);
    const found = look(names, 'blue');
    expect(found).toHaveLength(8);
    expect(found[0]).toBe('Blue Lock');
    expect(names.size).toBe(13);
  });

  it('takes a few milliseconds for a few thousand series', () => {
    const names = new Names();
    for (let i = 0; i < 3000; i++) names.add(card(`Series number ${i} of the long list`, [`Other name ${i}`, `シリーズ${i}`]), i);
    names.add(SOLO, 3000);
    names.look({ q: 'solo levelling', ...EVERY });
    const started = performance.now();
    const found = names.look({ q: 'solo levelling', ...EVERY });
    expect(performance.now() - started).toBeLessThan(50);
    expect(found.map((c) => c.title)).toEqual(['Solo Leveling']);
  });
});

describe('how close a name is', () => {
  it('counts letters changed, added, taken out and swapped round', () => {
    expect(distance('berserk', keyed('Berserk'), 2, false)).toBe(0);
    expect(distance('bersrek', keyed('Berserk'), 2, false)).toBe(1);
    expect(distance('bersek', keyed('Berserk'), 2, false)).toBe(1);
    expect(distance('berzerk', keyed('Berserk'), 2, false)).toBe(1);
    expect(distance('berserrk', keyed('Berserk'), 2, false)).toBe(1);
    // Past what's typed, the name may go on.
    expect(distance('ber', keyed('Berserk'), 0, false)).toBe(0);
    // Past the slack, it gives up.
    expect(distance('bxxxxrk', keyed('Berserk'), 2, false)).toBe(3);
  });

  it('starts at a later word only when asked to', () => {
    expect(distance('kaisen', keyed('Jujutsu Kaisen'), 1, false)).toBe(2);
    expect(distance('kaisen', keyed('Jujutsu Kaisen'), 1, true)).toBe(0);
    // Not partway into a word.
    expect(distance('utsu', keyed('Jujutsu Kaisen'), 1, true)).toBe(2);
  });

  it('keys names as searches are, without a "the" in front', () => {
    expect(keyed('The Art of War').key).toBe('artofwar');
    expect(keyed('Fullmetal Alchemist').starts.slice(0, 10)).toEqual([true, false, false, false, false, false, false, false, false, true]);
    expect(keyed('Sousou no Frieren').key).toBe('sosonofrieren');
    expect(keyed('Pokémon').key).toBe('pokemon');
    expect(keyed('The').key).toBe('the');
  });

  it('allows more slips as a search gets longer', () => {
    expect([1, 3, 4, 7, 8, 20].map(slackOf)).toEqual([0, 0, 1, 1, 2, 2]);
  });
});
