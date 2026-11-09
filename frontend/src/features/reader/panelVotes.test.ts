import { describe, expect, it, vi } from 'vitest';
import { PanelVote } from '@breader/shared/protocol';
import type { MangaBook } from '../../books/types';
import { clipOf } from './MangaZoom';
import { framesOfPanels } from './panelModel';
import { cornersOf, quadKey, votePageOf } from './panelVotes';

vi.mock('../../lib/api', () => ({ api: { get: vi.fn(), post: vi.fn() } }));
vi.mock('../../lib/account', () => ({ useAccount: () => ({ status: 'out', user: null, google: false }) }));

// A slanted panel as the model gave it, on a picture 800 by 1200.
const slant: Array<[number, number]> = [
  [80, 100],
  [700, 140],
  [690, 600],
  [90, 560],
];

describe('a vote on a panel', () => {
  it('sends the corners the model gave, not the room shown around them', () => {
    const [box] = framesOfPanels(800, 1200, [slant], 21).panels;
    // Shown with the page around it, its top left corner out from 10% across to 8.6%...
    expect(clipOf(box)).toMatch(/^polygon\(8\.600% /);
    // ...but voted on as found.
    expect(cornersOf(box.found!)).toEqual(slant);
    expect(box.found).toMatchObject({ w: 800, h: 1200, round: 21 });
  });

  it('is in the pixels of the picture the model read, whatever size it is shown at', () => {
    const [box] = framesOfPanels(400, 600, [[[40, 50], [350, 70], [345, 300], [45, 280]]], 21).panels;
    expect(cornersOf(box.found!)).toEqual([[40, 50], [350, 70], [345, 300], [45, 280]]);
  });

  it('keeps the corners whole and on the picture, as the server wants', () => {
    const found = { quad: [[-2, 0.4], [800.6, 3], [799, 1201], [10.5, 1199.4]] as Array<[number, number]>, w: 800, h: 1200, round: 21 };
    const quad = cornersOf(found);
    expect(quad).toEqual([[0, 0], [800, 3], [799, 1200], [11, 1199]]);
    expect(PanelVote.safeParse({ w: 800, h: 1200, round: 21, quad, good: true }).success).toBe(true);
  });

  it('is told apart by its corners', () => {
    expect(quadKey(slant)).toBe('80,100 700,140 690,600 90,560');
    expect(quadKey(slant)).not.toBe(quadKey([slant[1], slant[0], slant[2], slant[3]]));
  });

  it('is kept by the page’s place in its catalogue, or not at all', () => {
    const remote = { where: (i: number) => ({ chapter: i < 10 ? 'ch-a' : 'ch-b', n: i % 10 }) } as unknown as MangaBook;
    expect(votePageOf(remote, 12)).toBe('/v1/panels/ch-b/2/votes');
    expect(votePageOf({} as MangaBook, 3)).toBeNull();
    expect(votePageOf(remote, 1.5)).toBeNull();
  });
});
