import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import opencv from './opencvResize.json';
import { findPanels, fitOf, merged, PAD, panelsIn, quadOf, squareOf, SURE, takesOf, windows } from '@breader/shared/panels';

// A slanted panel's corners, each with how sure the model is of it, on a 1000 x 1000 page.
const slant: Array<[number, number, number]> = [
  [100, 100, 0.9],
  [600, 140, 0.2],
  [580, 500, 0.9],
  [160, 440, 0.3],
];
const asPut = (q: Array<[number, number, number]>) => q.map(([x, y]) => [x, y]);

describe('a panel is where the model puts it', () => {
  it('keeps every corner, even ones the model is unsure of', () => {
    expect(quadOf(slant, 1000, 1000)).toEqual(asPut(slant));
  });

  it('never squares off a nearly square panel', () => {
    const wobble: Array<[number, number, number]> = [
      [100, 100, 1],
      [600, 102, 1],
      [599, 500, 1],
      [101, 498, 1],
    ];
    expect(quadOf(wobble, 1000, 1000)).toEqual(asPut(wobble));
  });

  it('keeps corners that cross, as the model put them', () => {
    const crossed = [slant[0], slant[2], slant[1], slant[3]];
    expect(quadOf(crossed, 1000, 1000)).toEqual(asPut(crossed));
  });

  it('only rounds to whole pixels, half away from zero like Python', () => {
    expect(quadOf([[10.4, 10.6, 1], [20.5, 10.5, 1], [21.5, 30.49, 1], [9.5, 30.51, 1]], 1000, 1000)).toEqual([
      [10, 11],
      [20, 10],
      [22, 30],
      [10, 31],
    ]);
  });

  it('keeps corners on the page', () => {
    expect(quadOf([[-5, -3, 1], [1010, 0, 1], [1004, 1200, 1], [0, 999.6, 1]], 1000, 1000)).toEqual([
      [0, 0],
      [1000, 0],
      [1000, 1000],
      [0, 1000],
    ]);
  });
});

/** The model's answer for one guess, as the ONNX model gives it: each number for every guess in turn. */
function answer(sure: number[], corners: Array<[number, number, number]>) {
  return new Float32Array([350, 300, 500, 400, ...sure, ...corners.flat()]);
}

describe('the model answer', () => {
  // A 1024 square page, so the model's pixels are the page's.
  const fit = fitOf(1024, 1024, true);
  const read = (out: Float32Array) => panelsIn(out, 1, fit, [0, 1024], true, true, 1024, 1024);

  it('reads a panel in its own shape', () => {
    expect(read(answer([0.8], slant))[0].quad).toEqual(asPut(slant));
  });

  it('reads round 8 (two kinds of panel) the same way, sure of either', () => {
    expect(read(answer([0.1, 0.8], slant))[0].quad).toEqual(asPut(slant));
    expect(read(answer([0.8, 0.1], slant))[0].quad).toEqual(asPut(slant));
    expect(read(answer([0.1, 0.8], slant))[0].sure).toBeCloseTo(0.8);
  });

  it('drops a guess it is unsure of', () => {
    expect(read(answer([0.2], slant))).toEqual([]);
    expect(read(answer([0.2, 0.25], slant))).toEqual([]);
    // Under 0.4 sure: most of the model's extra boxes are. Round 21 was 0.46 sure of a panel it
    // would have skipped at half.
    expect(read(answer([0.35], slant))).toEqual([]);
    expect(read(answer([0.46], slant))).toHaveLength(1);
  });

  it('keeps what the labeller guesser keeps', () => {
    const py = readFileSync(new URL('../../../../ai/panels/model/guess.py', import.meta.url), 'utf8');
    expect(Number(py.match(/^SURE = ([\d.]+)$/m)?.[1])).toBe(SURE);
  });

  it('keeps a box that reaches past the page on it, as Ultralytics clips it', () => {
    const [f] = read(new Float32Array([1000, 50, 100, 60, 0.9, ...[[990, 30, 1], [1050, 30, 1], [1050, 80, 1], [990, 80, 1]].flat()]));
    expect(f.box).toEqual([950, 20, 1024, 80]);
    expect(f.quad).toEqual([[990, 30], [1024, 30], [1024, 80], [990, 80]]);
  });

  it('puts corners back on a page that is not square', () => {
    // 512 x 1024: the model sees it scaled to 512 x 1024 with grey either side, 256 to the left.
    const tall = fitOf(512, 1024, false);
    const quad = panelsIn(answer([0.9], [[356, 100, 1], [756, 100, 1], [756, 500, 1], [356, 500, 1]]), 1, tall, [0, 1024], true, true, 512, 1024)[0].quad;
    expect(quad).toEqual([
      [100, 100],
      [500, 100],
      [500, 500],
      [100, 500],
    ]);
  });
});

describe('a page fitted to the model, as the guesser does it', () => {
  // From Ultralytics' own LetterBox (stride 32) and scale_boxes, for a model that takes any size
  // (rect) and one that takes only the square.
  const theirs = [
    { w: 1782, h: 2789, rect: true, wide: 672, tall: 1024, left: 9, top: 0, r: 0.3671566869845823, padX: 9, padY: 0 },
    { w: 1782, h: 2789, rect: false, wide: 1024, tall: 1024, left: 185, top: 0, r: 0.3671566869845823, padX: 185, padY: 0 },
    { w: 512, h: 1024, rect: true, wide: 512, tall: 1024, left: 0, top: 0, r: 1, padX: 0, padY: 0 },
    { w: 512, h: 1024, rect: false, wide: 1024, tall: 1024, left: 256, top: 0, r: 1, padX: 256, padY: 0 },
    { w: 1000, h: 1000, rect: true, wide: 1024, tall: 1024, left: 0, top: 0, r: 1.024, padX: 0, padY: 0 },
    { w: 800, h: 1600, rect: true, wide: 512, tall: 1024, left: 0, top: 0, r: 0.64, padX: 0, padY: 0 },
    { w: 1031, h: 1500, rect: true, wide: 704, tall: 1024, left: 0, top: 0, r: 0.6826666666666666, padX: 0, padY: 0 },
    { w: 1031, h: 1500, rect: false, wide: 1024, tall: 1024, left: 160, top: 0, r: 0.6826666666666666, padX: 160, padY: 0 },
    { w: 700, h: 333, rect: true, wide: 1024, tall: 512, left: 0, top: 12, r: 1.4628571428571429, padX: 0, padY: 12 },
    { w: 700, h: 333, rect: false, wide: 1024, tall: 1024, left: 0, top: 268, r: 1.4628571428571429, padX: 0, padY: 268 },
    { w: 1200, h: 1700, rect: true, wide: 736, tall: 1024, left: 6, top: 0, r: 0.6023529411764705, padX: 6, padY: 0 },
    { w: 1097, h: 1600, rect: true, wide: 704, tall: 1024, left: 1, top: 0, r: 0.64, padX: 1, padY: 0 },
    { w: 2000, h: 2001, rect: true, wide: 1024, tall: 1024, left: 0, top: 0, r: 0.511744127936032, padX: 0, padY: 0 },
    { w: 37, h: 1024, rect: true, wide: 64, tall: 1024, left: 13, top: 0, r: 1, padX: 13, padY: 0 },
    { w: 37, h: 1024, rect: false, wide: 1024, tall: 1024, left: 493, top: 0, r: 1, padX: 493, padY: 0 },
  ];

  it('puts it where Ultralytics puts it, in the least rectangle round it or the square', () => {
    for (const t of theirs) {
      const f = fitOf(t.w, t.h, t.rect);
      expect({ ...t, wide: f.wide, tall: f.tall, left: f.left, top: f.top, r: f.r, padX: f.padX, padY: f.padY }).toEqual(t);
    }
  });

  it('knows how a model takes its pictures by its input', () => {
    expect(takesOf(['batch', 3, 'height', 'width'])).toEqual({ rect: true, batch: 2 });
    expect(takesOf([1, 3, -1, -1])).toEqual({ rect: true, batch: 1 });
    // Round 7, live before round 21: the square, one at a time.
    expect(takesOf([1, 3, 1024, 1024])).toEqual({ rect: false, batch: 1 });
    expect(takesOf(undefined)).toEqual({ rect: false, batch: 1 });
  });

  it('scales a picture exactly as OpenCV does, to the shade', () => {
    // Made by OpenCV itself (cv2.resize, INTER_LINEAR), as the guesser's Ultralytics calls it:
    // down, up, half each way (averaged by fours), its own size, and a tiny picture made huge.
    for (const c of opencv.cases) {
      const px = Uint8Array.from({ length: c.w * c.h * 3 }, (_, i) => (i * 37 + (i >> 3) * 11) % 256);
      const fit = { wide: c.nw, tall: c.nh, w: c.nw, h: c.nh, left: 0, top: 0, r: 1, padX: 0, padY: 0 };
      const into = squareOf(px, c.w, 3, [0, c.h], fit);
      const plane = c.nw * c.nh;
      const out = Array.from({ length: plane * 3 }, (_, i) => Math.round(into[(i % 3) * plane + Math.floor(i / 3)] * 255));
      if (c.out) expect(out).toEqual(c.out);
      expect(out.reduce((t, v) => t + v, 0)).toBe(c.sum);
      expect(out.reduce((t, v, i) => t + v * ((i % 9973) + 1), 0)).toBe(c.hash);
    }
  });

  it('greys only round the picture, and copies a picture that needs no scaling as it is', () => {
    // 37 x 1024: put 13 in, in a 64 wide input, grey either side.
    const w = 37;
    const h = 1024;
    const px = Uint8Array.from({ length: w * h * 3 }, (_, i) => (i * 7) % 256);
    const fit = fitOf(w, h, true);
    const into = squareOf(px, w, 3, [0, h], fit);
    expect(into.length).toBe(3 * 64 * 1024);
    const plane = 64 * 1024;
    for (const [x, y] of [[0, 0], [12, 500], [13 + 37, 10], [63, 1023]]) expect(into[y * 64 + x]).toBeCloseTo(PAD / 255);
    for (const [x, y] of [[0, 0], [36, 1023], [5, 77]]) {
      for (let c = 0; c < 3; c++) expect(into[c * plane + y * 64 + 13 + x]).toBeCloseTo(px[(y * w + x) * 3 + c] / 255);
    }
  });

  it('reads a page in its rectangle, back on the page', async () => {
    // 1782 x 2789 goes in at 672 x 1024, 9 in: a panel the model puts at 9 + 0.367 * 100 is at 100.
    const r = 0.3671566869845823;
    const at = (v: number, pad = 0) => v * r + pad;
    let asked: number[] = [];
    const found = await findPanels(new Uint8Array(1782 * 2789 * 3), 1782, 2789, 3, { rect: true, batch: 2 }, async (input, k, fit) => {
      asked = [input.length, k, fit.wide, fit.tall];
      const q: Array<[number, number, number]> = [[at(100, 9), at(100), 1], [at(900, 9), at(100), 1], [at(900, 9), at(1000), 1], [at(100, 9), at(1000), 1]];
      return { out: new Float32Array([at(500, 9), at(550), at(800), at(900), 0.9, ...q.flat()]), n: 1 };
    });
    expect(asked).toEqual([3 * 672 * 1024, 1, 672, 1024]);
    expect(found.panels).toEqual([[[100, 100], [900, 100], [900, 1000], [100, 1000]]]);
  });

  it("runs a strip's windows two at a time", async () => {
    const w = 100;
    const h = 1000;
    const run = (runs: number[]) => async (input: Float32Array, k: number, fit: { wide: number; tall: number }) => {
      runs.push(k);
      expect(input.length).toBe(k * 3 * fit.wide * fit.tall);
      return { out: new Float32Array(k * 17), n: 1 };
    };
    const runs: number[] = [];
    await findPanels(new Uint8Array(w * h * 4), w, h, 4, { rect: true, batch: 2 }, run(runs));
    expect(runs.reduce((a, b) => a + b, 0)).toBe(windows(w, h).length);
    expect(runs.every((k) => k <= 2)).toBe(true);
    expect(runs.length).toBe(Math.ceil(windows(w, h).length / 2));
    // One that takes one at a time is given one at a time.
    const ones: number[] = [];
    await findPanels(new Uint8Array(w * h * 4), w, h, 4, { rect: false, batch: 1 }, run(ones));
    expect(ones).toEqual(windows(w, h).map(() => 1));
  });
});

describe("a strip's pieces joined", () => {
  it("keeps the upper piece's top corners and the lower one's bottom corners, not their box", () => {
    const up = { box: [100, 100, 600, 1000] as [number, number, number, number], quad: [[100, 100], [600, 130], [600, 1000], [100, 1000]] as Array<[number, number]>, sure: 0.9, cut: true };
    const down = { box: [100, 900, 620, 1500] as [number, number, number, number], quad: [[100, 900], [600, 900], [620, 1500], [110, 1480]] as Array<[number, number]>, sure: 0.8, cut: true };
    const [one, ...rest] = merged([up, down]);
    expect(rest).toEqual([]);
    expect(one.quad).toEqual([
      [100, 100],
      [600, 130],
      [620, 1500],
      [110, 1480],
    ]);
  });
});
