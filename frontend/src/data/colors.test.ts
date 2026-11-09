import { describe, expect, it } from 'vitest';
import { colorVars, inkOn, isPicked, normColor, pickColor, rgbToHex, tintInkOf, tintOf, toHex } from './colors';

describe('a colour typed or pasted', () => {
  it('is read with or without its #, in 3 digits or 6, any case, with spaces round it', () => {
    expect(toHex('#2F6F8F')).toBe('#2f6f8f');
    expect(toHex('2f6f8f')).toBe('#2f6f8f');
    expect(toHex('  #abc ')).toBe('#aabbcc');
    expect(toHex('FFF')).toBe('#ffffff');
  });

  it('is turned down when it isn’t a colour', () => {
    for (const bad of ['', '#', '#12', '#1234', '#12345', '#1234567', 'red', '#ggg000', '##123456', 'rgb(1,2,3)']) {
      expect(toHex(bad), bad).toBeNull();
    }
  });
});

describe('a book’s colour', () => {
  it('stays the palette’s when it is one', () => {
    expect(normColor('teal', 'x')).toBe('teal');
  });

  it('turns an earlier build’s saved hex into the palette’s nearest', () => {
    expect(normColor('#1F5F63', 'x')).toBe('teal');
    expect(normColor('#D8C9A8', 'x')).toBe('sand');
  });

  it('keeps a colour picked exactly as it is, even one an earlier build also saved', () => {
    expect(normColor('#123456', 'x')).toBe('#123456');
    expect(normColor('#1f5f63', 'x')).toBe('#1f5f63');
  });

  it('falls back to one from the title, the same each time, for anything else', () => {
    for (const odd of [undefined, '', 'blue', '#12345', '#1234567', 'var(--x)']) {
      const c = normColor(odd, 'The Lighthouse');
      expect(c, String(odd)).toBe(normColor(undefined, 'The Lighthouse'));
      expect(isPicked(c)).toBe(false);
    }
  });

  it('shows the palette’s shade for the theme, or the colour picked, with words that stand out on it', () => {
    expect(tintOf('teal')).toBe('var(--bc-teal)');
    expect(tintInkOf('teal')).toBe('var(--bc-teal-ink)');
    expect(tintOf('#123456')).toBe('#123456');
    expect(colorVars('#ffee00')).toEqual({ '--bc': '#ffee00', '--bc-ink': '#141414' });
  });

  it('is never given out new as a picked one, and picked ones don’t count against the palette', () => {
    const given = ['#123456', '#123456', '#abcdef'];
    for (let i = 0; i < 20; i++) expect(isPicked(pickColor(given))).toBe(false);
  });
});

describe('the words on a picked colour', () => {
  it('are white on dark colours and near black on light ones', () => {
    for (const dark of ['#000000', '#1f2a44', '#942f44', '#0000ff', '#6b5b95']) expect(inkOn(dark), dark).toBe('#ffffff');
    for (const light of ['#ffffff', '#ffee00', '#ffa8b2', '#00ff00', '#d8c9a8']) expect(inkOn(light), light).toBe('#141414');
  });
});

describe('a colour as the browser gives it', () => {
  it('is read as a code', () => {
    expect(rgbToHex('rgb(148, 47, 68)')).toBe('#942f44');
    expect(rgbToHex('rgba(0, 0, 0, 0.5)')).toBe('#000000');
    expect(rgbToHex('rgb(255,255,255)')).toBe('#ffffff');
    expect(rgbToHex('transparent')).toBeNull();
  });
});
