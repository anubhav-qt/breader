import { describe, expect, it } from 'vitest';
import { clipOf } from './MangaZoom';
import { framesOfPanels } from './panelModel';

/** A clip's corners, back as numbers 0 to 1. */
function cornersOf(clip: string): Array<[number, number]> {
  const m = /^polygon\((.*)\)$/.exec(clip);
  expect(m).not.toBeNull();
  return m![1].split(', ').map((c) => c.split(' ').map((v) => parseFloat(v) / 100) as [number, number]);
}

// A slanted panel on a 1000 x 1000 page, the way the model gives it: top left round.
const slant: Array<[number, number]> = [
  [100, 100],
  [600, 160],
  [580, 500],
  [120, 440],
];

describe('a panel is cut to its own corners', () => {
  it('keeps the corners the model found', () => {
    const [box] = framesOfPanels(1000, 1000, [slant]).panels;
    expect(box.quad).toEqual(slant.map(([x, y]) => [x / 1000, y / 1000]));
    // Its box still holds them all, for fitting it to the screen.
    expect(box).toMatchObject({ x: 0.1, y: 0.1 });
    expect(box.w).toBeCloseTo(0.5);
    expect(box.h).toBeCloseTo(0.4);
  });

  it('a slanted panel is clipped slanted, not to its box', () => {
    const [box] = framesOfPanels(1000, 1000, [slant]).panels;
    const c = cornersOf(clipOf(box));
    expect(c).toHaveLength(4);
    // Each corner a little out from the panel's middle, the way a box's sides are.
    const want: Array<[number, number]> = [
      [0.086, 0.086],
      [0.614, 0.146],
      [0.594, 0.514],
      [0.106, 0.454],
    ];
    c.forEach(([x, y], i) => {
      expect(x).toBeCloseTo(want[i][0], 5);
      expect(y).toBeCloseTo(want[i][1], 5);
    });
  });

  it('a panel with no corners is clipped to its box', () => {
    const c = cornersOf(clipOf({ x: 0.2, y: 0.3, w: 0.4, h: 0.2 }));
    const want: Array<[number, number]> = [
      [0.186, 0.286],
      [0.614, 0.286],
      [0.614, 0.514],
      [0.186, 0.514],
    ];
    c.forEach(([x, y], i) => {
      expect(x).toBeCloseTo(want[i][0], 5);
      expect(y).toBeCloseTo(want[i][1], 5);
    });
  });

  it('stays on the page at its edges', () => {
    const [box] = framesOfPanels(800, 1200, [
      [
        [0, 0],
        [800, 0],
        [800, 1200],
        [0, 1200],
      ],
    ]).panels;
    expect(cornersOf(clipOf(box))).toEqual([
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ]);
  });

  it('the whole page is four corners too, so it glides into a panel', () => {
    expect(cornersOf(clipOf(null))).toEqual([
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ]);
  });
});
