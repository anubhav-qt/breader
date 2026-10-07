import { namesOf, seriesName, type MangaChapter } from '@breader/shared';
import { describe, expect, it } from 'vitest';
import { copiesOf, measure, sizeOf } from '../src/manga/copies.ts';

/*
 * Telling the same series apart on every site by its name, and its copies in one place: which
 * groups count as one, the chapter each is measured on, and a page's size from its file.
 */

/** The start of a PNG this wide and tall. */
export function pngOf(width: number, height: number): Uint8Array {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, width);
  new DataView(b.buffer).setUint32(20, height);
  return b;
}

/** A JPEG's start: an APP0 segment, then its frame header. */
function jpegOf(width: number, height: number): Uint8Array {
  const app0 = [0xff, 0xe0, 0, 16, ...Array.from('JFIF\0', (ch) => ch.charCodeAt(0)), 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const sof = [0xff, 0xc0, 0, 17, 8, height >> 8, height & 0xff, width >> 8, width & 0xff, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  return new Uint8Array([0xff, 0xd8, ...app0, ...sof]);
}

/** A WebP's start, its first chunk of this kind holding these bytes from offset 20. */
function webpOf(chunk: string, bytes: number[]): Uint8Array {
  const b = new Uint8Array(40);
  b.set(Array.from('RIFF', (ch) => ch.charCodeAt(0)), 0);
  b.set(Array.from('WEBP', (ch) => ch.charCodeAt(0)), 8);
  b.set(Array.from(chunk, (ch) => ch.charCodeAt(0)), 12);
  b.set(bytes, 20);
  return b;
}

function chapter(n: number, by: string[], extra: Partial<MangaChapter> = {}): MangaChapter {
  return { id: `${by.join('+')}-${n}`, chapter: String(n), volume: null, title: null, pages: 20, external: null, groups: by.map((g) => ({ id: g, name: g })), at: n, ...extra };
}

describe('the same series by name', () => {
  it('reads past case, punctuation, accents, a leading The and doubled vowels', () => {
    expect(seriesName('Haikyuu!!').key).toBe(seriesName('Haikyu!!').key);
    expect(seriesName('Shōnen Days').key).toBe(seriesName('SHOUNEN days').key);
    expect(seriesName('The Promised Neverland').key).toBe(seriesName('Promised Neverland').key);
    expect(seriesName('Nisekyuu!!').key).not.toBe(seriesName('Haikyu!!').key);
  });

  it('tells an edition named at the end apart from the name', () => {
    expect(seriesName('Haikyu!! (Color)')).toEqual({ key: seriesName('Haikyu!!').key, edition: 'Color' });
    expect(seriesName('One Piece - Digital Colored Comics')).toEqual({ key: seriesName('One Piece').key, edition: 'Color' });
    expect(seriesName('Dragon Ball Full Color').edition).toBe('Color');
    expect(seriesName('Colorful').edition).toBeNull();
    expect(seriesName('Color').edition).toBeNull();
  });

  it('keys every name once, and takes the edition from the first', () => {
    expect(namesOf(['Haikyu!! (Color)', 'Haikyuu!!', 'ハイキュー!!'])).toEqual({ keys: ['haikyu', 'ハイキュー'], edition: 'Color' });
  });
});

describe('a page’s size', () => {
  it('reads PNG, JPEG, GIF and the three kinds of WebP', () => {
    expect(sizeOf(pngOf(1067, 1600))).toEqual({ width: 1067, height: 1600 });
    expect(sizeOf(jpegOf(700, 1050))).toEqual({ width: 700, height: 1050 });
    const gif = new Uint8Array(24);
    gif.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x20, 0x03, 0x58, 0x02]);
    expect(sizeOf(gif)).toEqual({ width: 800, height: 600 });
    // Extended: each side less one, in three bytes.
    expect(sizeOf(webpOf('VP8X', [0, 0, 0, 0, 0xff, 0x04, 0, 0x3f, 0x06, 0]))).toEqual({ width: 1280, height: 1600 });
    // Lossy: each side in two bytes, after the frame tag.
    expect(sizeOf(webpOf('VP8 ', [0, 0, 0, 0x9d, 0x01, 0x2a, 0x20, 0x03, 0x58, 0x02]))).toEqual({ width: 800, height: 600 });
    // Lossless: fourteen bits a side, less one.
    expect(sizeOf(webpOf('VP8L', [0x2f, 0x1f, 0xc3, 0x43, 0x01]))).toEqual({ width: 800, height: 1296 });
  });

  it('says nothing of what isn’t a picture it knows', () => {
    expect(sizeOf(new Uint8Array(40))).toBeNull();
    expect(sizeOf(new Uint8Array([0xff, 0xd8, 0xff]))).toBeNull();
  });

  it('measures the narrower of two pages from the middle, so a spread doesn’t count as wide', async () => {
    const widths = [700, 700, 1400, 700];
    const asked: number[] = [];
    const size = await measure(4, async (n) => {
      asked.push(n);
      return { data: pngOf(widths[n], 1050), type: 'image/png' };
    });
    expect(asked).toEqual([2, 1]);
    expect(size).toEqual({ width: 700, height: 1050 });
    expect(await measure(0, async () => ({ data: pngOf(1, 1), type: 'image/png' }))).toBeNull();
  });
});

describe('a series’ copies in one place', () => {
  it('counts each group with half its chapters or more, most first, measured on a chapter they share', () => {
    const chapters: MangaChapter[] = [];
    for (let n = 1; n <= 10; n++) chapters.push(chapter(n, ['official']));
    for (let n = 3; n <= 9; n++) chapters.push(chapter(n, ['fans']));
    chapters.push(chapter(1, ['few']), chapter(2, ['few']));
    const { total, plans } = copiesOf(chapters);
    expect(total).toBe(10);
    expect(plans.map((p) => [p.group?.name, p.chapters])).toEqual([['official', 10], ['fans', 7]]);
    // Chapters 3 to 9 are in both: the middle one.
    expect(plans.map((p) => p.sample?.id)).toEqual(['official-6', 'fans-6']);
  });

  it('is one copy, as it comes, when no group made half of it, and measures only chapters read here', () => {
    const chapters = [chapter(1, ['a']), chapter(2, ['b']), chapter(3, ['c'], { external: 'https://example.com', pages: 0 }), chapter(4, [])];
    const { plans } = copiesOf(chapters);
    expect(plans).toHaveLength(1);
    expect(plans[0].group).toBeNull();
    expect(plans[0].chapters).toBe(4);
    expect(plans[0].sample?.id).toBe('b-2');
  });
});
