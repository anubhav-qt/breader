import type { Quad } from './labels.ts';
import type { Grey } from './snap.ts';

/*
 * Growing (README.md): a double-click on a panel grows from where it lands, out over the panel to
 * the gutter on every side, and boxes what it reached. So the box sits on the line between the
 * gutter and the panel, its border inside, and takes in whatever breaks out of the panel over the
 * gutter, a bubble or a sound effect.
 *
 * The gutter is the paper that can be reached from the page's edge without crossing ink. The paper
 * inside a panel, walled in by its border, isn't gutter, so it's grown over like the rest.
 */

/** How far from the paper's own darkness a pixel can be and still be paper. */
const PAPER = 40;
/** How wide the page's margin is, in pixels, that tells its paper's darkness. */
const MARGIN = 4;
/** Darknesses this close count as the same, when finding the commonest in the margin. */
const NEAR = 8;

/** The paper's darkness: the commonest in the page's margin, give or take a little. */
function paperOf(grey: Grey): number {
  const { width, height, dark } = grey;
  const counts = new Array<number>(256).fill(0);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // Inside the margin: on to its far side.
      if (y >= MARGIN && y < height - MARGIN && x >= MARGIN && x < width - MARGIN) x = width - MARGIN;
      counts[dark[y * width + x]]++;
    }
  }
  let paper = 0;
  let most = -1;
  for (let v = 0; v < 256; v++) {
    let n = 0;
    for (let u = Math.max(0, v - NEAR); u <= Math.min(255, v + NEAR); u++) {
      n += counts[u];
    }
    if (n > most) {
      most = n;
      paper = v;
    }
  }
  return paper;
}

/** Everything that can be reached from the start without crossing a pixel that's `wall`, and the box around it. */
function flood(wall: (i: number) => boolean, width: number, height: number, starts: number[]) {
  const reached = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  let head = 0;
  let tail = 0;
  let left = width;
  let right = -1;
  let top = height;
  let bottom = -1;
  const reach = (i: number) => {
    if (reached[i] || wall(i)) return;
    reached[i] = 1;
    queue[tail] = i;
    tail++;
  };
  for (const i of starts) reach(i);
  while (head < tail) {
    const i = queue[head];
    head++;
    const x = i % width;
    const y = (i - x) / width;
    left = Math.min(left, x);
    right = Math.max(right, x);
    top = Math.min(top, y);
    bottom = Math.max(bottom, y);
    if (x > 0) reach(i - 1);
    if (x < width - 1) reach(i + 1);
    if (y > 0) reach(i - width);
    if (y < height - 1) reach(i + width);
  }
  return { reached, left, right, top, bottom };
}

/** The page's gutter: 1 for each pixel of paper that can be reached from the page's edge without crossing ink. */
export function gutterOf(grey: Grey): Uint8Array {
  const { width, height, dark } = grey;
  const level = paperOf(grey);
  const edge: number[] = [];
  for (let x = 0; x < width; x++) {
    edge.push(x);
    edge.push((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    edge.push(y * width);
    edge.push(y * width + width - 1);
  }
  const ink = (i: number) => Math.abs(dark[i] - level) > PAPER;
  return flood(ink, width, height, edge).reached;
}

/**
 * The box around everything that can be reached from x, y without crossing the gutter, or null when
 * x, y is gutter itself. Its edges are whole pixels: a panel out to the page's edge runs to it.
 */
export function grownOf(gutter: Uint8Array, width: number, height: number, x: number, y: number): Quad | null {
  const start = y * width + x;
  if (gutter[start]) return null;
  const { left, right, top, bottom } = flood((i) => gutter[i] === 1, width, height, [start]);
  return [
    [left, top],
    [right + 1, top],
    [right + 1, bottom + 1],
    [left, bottom + 1],
  ];
}
