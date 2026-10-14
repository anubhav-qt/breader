import type { Point, Quad } from './labels.ts';

/*
 * Snapping (README.md): a corner let go of moves onto the border nearest it, where the panels are
 * labelled, on the line between the gutter and the panel, its border inside. It looks along both of
 * the corner's edges for that line, so a slanted panel snaps along its slant, and a neighbour's
 * border across the gutter, which faces the other way, never pulls it over.
 *
 * Nothing is snapped quietly: the corner is moved on screen, as a change of its own that Ctrl+Z
 * takes back to where it was let go.
 */

/** A picture's darkness, 0 for paper white to 255 for ink, a byte a pixel, row after row. */
export interface Grey {
  width: number;
  height: number;
  dark: Uint8Array;
  /** Whether its paper (its margins, and so mostly its gutters) is light, as most pages' are. */
  light: boolean;
}

/** How far along each edge from the corner its border is looked for, in the picture's pixels. */
const ALONG = 40;
/** How much a pixel further from where it was let go has to be worth, in darkness, to be snapped to. */
const PULL = 3;
/** Borders fainter than this, in darkness across them, aren't snapped to. */
const FAINTEST = 30;
/** How sharp the page's own edge is, as a border, over the darkness of the panel against it. */
const EDGE = 100;
/** How wide the page's margin is, in pixels, that tells its paper. */
const MARGIN = 4;

/** The picture's darkness from its pixels, four bytes each (red, green, blue, alpha), as a canvas gives them. */
export function greyOf(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): Grey {
  const dark = new Uint8Array(width * height);
  for (let i = 0, j = 0; i < dark.length; i++, j += 4) dark[i] = 255 - ((rgba[j] * 299 + rgba[j + 1] * 587 + rgba[j + 2] * 114) / 1000);
  let sum = 0;
  let n = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // Inside the margin: on to its far side.
      if (y >= MARGIN && y < height - MARGIN && x >= MARGIN && x < width - MARGIN) x = width - MARGIN;
      sum += dark[y * width + x];
      n++;
    }
  }
  return { width, height, dark, light: sum / Math.max(1, n) < 128 };
}

/**
 * Where a corner of a panel snaps to, within `reach` of where it is, or null when there's no border
 * near enough to be sure of. A corner on the page's edge stays on it.
 */
export function snapOf(grey: Grey, quad: Quad, corner: number, reach: number): Point | null {
  const { width, height, dark } = grey;
  const [x0, y0] = quad[corner];
  const ends = [quad[(corner + 3) % 4], quad[(corner + 1) % 4]];
  const cx = (quad[0][0] + quad[1][0] + quad[2][0] + quad[3][0]) / 4;
  const cy = (quad[0][1] + quad[1][1] + quad[2][1] + quad[3][1]) / 4;
  // Ink is darker than the paper around it: on dark paper, the panel is the lighter side. Past the
  // page's edge counts as paper paler than any, so a panel running off the page snaps to its edge.
  const sign = grey.light ? 1 : -1;
  const paper = grey.light ? -EDGE : 255 + EDGE;
  const at = (x: number, y: number) => {
    const px = Math.floor(x);
    const py = Math.floor(y);
    return px < 0 || py < 0 || px >= width || py >= height ? paper : dark[py * width + px];
  };

  /** How sharply the picture turns from paper to panel across both edges, were the corner at x, y. */
  const across = (x: number, y: number): number | null => {
    let total = 0;
    let edges = 0;
    for (const [ex, ey] of ends) {
      const len = Math.hypot(ex - x, ey - y);
      if (len < 8) continue;
      const dx = (ex - x) / len;
      const dy = (ey - y) / len;
      // The edge's normal, turned to face into the panel.
      let nx = -dy;
      let ny = dx;
      if ((cx - x) * nx + (cy - y) * ny < 0) {
        nx = -nx;
        ny = -ny;
      }
      let sum = 0;
      let n = 0;
      for (let t = 3; t <= Math.min(ALONG, len * 0.45); t += 2) {
        const sx = x + dx * t;
        const sy = y + dy * t;
        const inside = at(sx + nx * 0.5, sy + ny * 0.5) + at(sx + nx * 1.5, sy + ny * 1.5);
        const outside = at(sx - nx * 0.5, sy - ny * 0.5) + at(sx - nx * 1.5, sy - ny * 1.5);
        sum += (sign * (inside - outside)) / 2;
        n++;
      }
      if (n) {
        total += sum / n;
        edges++;
      }
    }
    return edges ? total / edges : null;
  };

  const pinX = x0 <= 0 || x0 >= width;
  const pinY = y0 <= 0 || y0 >= height;
  let best: Point | null = null;
  let bestWorth = -Infinity;
  let bestSharp = 0;
  for (let dy = pinY ? 0 : -reach; dy <= (pinY ? 0 : reach); dy++) {
    for (let dx = pinX ? 0 : -reach; dx <= (pinX ? 0 : reach); dx++) {
      const x = x0 + dx;
      const y = y0 + dy;
      if (x < 0 || y < 0 || x > width || y > height) continue;
      const sharp = across(x, y);
      if (sharp === null) continue;
      const worth = sharp - PULL * Math.hypot(dx, dy);
      if (worth > bestWorth) {
        bestWorth = worth;
        bestSharp = sharp;
        best = [x, y];
      }
    }
  }
  return best && bestSharp >= FAINTEST ? best : null;
}
