import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FramesAsk } from './frames';

/** White paper with two black panels, one above the other, `w` by `h` as RGBA. */
function twoPanels(w: number, h: number): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(w * h * 4).fill(255);
  const gap = Math.round(w * 0.06);
  for (let y = 0; y < h; y++) {
    const top = y >= gap && y < h / 2 - gap;
    const bottom = y >= h / 2 + gap && y < h - gap;
    if (!top && !bottom) continue;
    for (let x = gap; x < w - gap; x++) {
      const p = (y * w + x) * 4;
      rgba[p] = 0;
      rgba[p + 1] = 0;
      rgba[p + 2] = 0;
    }
  }
  return rgba;
}

/** A canvas a worker holds, that gives back two panels whatever's drawn on it. */
class FakeOffscreen {
  width: number;
  height: number;
  constructor(w: number, h: number) {
    this.width = w;
    this.height = h;
  }
  getContext() {
    return {
      fillStyle: '',
      fillRect: () => {},
      drawImage: () => {},
      getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: twoPanels(w, h) }),
    };
  }
}

/** Starts the worker's code with a fake worker scope, and gives back what it posts. */
async function startWorker(open: (file: Blob) => Promise<unknown>) {
  const posted: Array<{ id: number; frames: { panels: unknown[] } }> = [];
  const scope: { onmessage: ((e: MessageEvent<FramesAsk>) => Promise<void>) | null; postMessage: (m: never) => void } = {
    onmessage: null,
    postMessage: (m) => posted.push(m),
  };
  vi.stubGlobal('self', scope);
  vi.stubGlobal('OffscreenCanvas', FakeOffscreen);
  vi.stubGlobal('createImageBitmap', open);
  vi.resetModules();
  await import('./frames.worker');
  const ask = async (data: FramesAsk) => {
    await scope.onmessage!({ data } as MessageEvent<FramesAsk>);
  };
  return { posted, ask };
}

describe('frames worker', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('opens a page’s file, finds its panels, and lets the picture go', async () => {
    const close = vi.fn();
    const opened: Blob[] = [];
    const { posted, ask } = await startWorker(async (file) => {
      opened.push(file);
      return { width: 600, height: 860, close };
    });
    const file = new Blob(['jpeg']);
    await ask({ id: 7, file });
    expect(opened).toEqual([file]);
    expect(posted).toHaveLength(1);
    expect(posted[0].id).toBe(7);
    expect(posted[0].frames.panels).toHaveLength(2);
    expect(close).toHaveBeenCalledOnce();
  });

  it('answers with no panels for a file that won’t open', async () => {
    const { posted, ask } = await startWorker(async () => { throw new Error('not a picture'); });
    await ask({ id: 8, file: new Blob(['junk']) });
    expect(posted).toEqual([{ id: 8, frames: { groups: [], panels: [] } }]);
  });

  it('looks in greys sent from the page as they are', async () => {
    const open = vi.fn();
    const { posted, ask } = await startWorker(open);
    // 2 by 2 greys of plain paper: nothing to tell apart.
    await ask({ id: 9, pic: { luma: new Uint8Array(4).fill(255), w: 2, h: 2 } });
    expect(open).not.toHaveBeenCalled();
    expect(posted).toEqual([{ id: 9, frames: { groups: [], panels: [] } }]);
  });
});
