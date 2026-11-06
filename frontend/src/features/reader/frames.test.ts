import { afterEach, describe, expect, it, vi } from 'vitest';
import { drawsInWorker, framesIn, greySize, greysOfFine, greysOn, pictureFile, type AnyCanvas, type FramesAsk } from './frames';

/** A page `w` by `h` as RGBA: white paper, and `rows` by `cols` black panels with gutters between. */
function gridPage(w: number, h: number, rows = 3, cols = 2): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(w * h * 4).fill(255);
  const gap = Math.round(w * 0.05);
  const cellW = w / cols;
  const cellH = h / rows;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const inX = x % cellW;
      const inY = y % cellH;
      const inked = inX >= gap && inX < cellW - gap && inY >= gap && inY < cellH - gap;
      if (!inked) continue;
      const p = (y * w + x) * 4;
      rgba[p] = 17;
      rgba[p + 1] = 17;
      rgba[p + 2] = 17;
    }
  }
  return rgba;
}

/** What a fake canvas was asked to do, in order. */
type Call = string;

/** A canvas that gives back `page` (at the size read) whatever's drawn on it, and notes what it was asked. */
function fakeCanvas(page: (w: number, h: number) => Uint8ClampedArray, calls: Call[], noContext = false): AnyCanvas {
  const ctx = {
    fillStyle: '',
    fillRect: (x: number, y: number, w: number, h: number) => calls.push(`fill ${ctx.fillStyle} ${x},${y},${w},${h}`),
    drawImage: (_source: unknown, x: number, y: number, w: number, h: number) => calls.push(`draw ${x},${y},${w},${h}`),
    getImageData: (x: number, y: number, w: number, h: number) => {
      calls.push(`read ${x},${y},${w},${h}`);
      return { data: page(w, h) };
    },
  };
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => (noContext ? null : ctx),
  };
  return canvas as unknown as AnyCanvas;
}

describe('greySize', () => {
  it('has no size for a picture with none', () => {
    expect(greySize(0, 100)).toBeNull();
    expect(greySize(100, 0)).toBeNull();
    expect(greySize(-5, 100)).toBeNull();
    expect(greySize(Number.NaN, 100)).toBeNull();
  });

  it('shrinks a page to 400 across', () => {
    expect(greySize(800, 1136)).toEqual({ w: 400, h: 568 });
  });

  it('never grows a small page', () => {
    expect(greySize(200, 284)).toEqual({ w: 200, h: 284 });
  });

  it('looks at a spread as two pages, each 400 across', () => {
    // 1280 / 1.42 = 901 wide a page, so 400 / 901 of the whole.
    expect(greySize(1800, 1280)).toEqual({ w: 799, h: 568 });
  });

  it('keeps a long strip no taller than 6000', () => {
    expect(greySize(720, 12000)).toEqual({ w: 360, h: 6000 });
  });
});

describe('greysOfFine', () => {
  it('turns colours to greys by how bright they look', () => {
    // One grey from four fine pixels, all the same colour.
    const of = (r: number, g: number, b: number) => greysOfFine(new Uint8ClampedArray([r, g, b, 255, r, g, b, 255, r, g, b, 255, r, g, b, 255]), 1, 1)[0];
    expect(of(255, 255, 255)).toBe(255);
    expect(of(0, 0, 0)).toBe(0);
    expect(of(255, 0, 0)).toBe(76);
    expect(of(0, 255, 0)).toBe(149);
    expect(of(0, 0, 255)).toBe(28);
  });

  it('keeps the darkest of each square of four, so thin lines survive', () => {
    // 4 by 2 fine pixels, two greys: one black fine pixel in the right square only.
    const rgba = new Uint8ClampedArray(4 * 2 * 4).fill(255);
    const p = (1 * 4 + 3) * 4;
    rgba[p] = 0;
    rgba[p + 1] = 0;
    rgba[p + 2] = 0;
    expect([...greysOfFine(rgba, 2, 1)]).toEqual([255, 0]);
  });

  it('puts each square in its own row', () => {
    // 2 by 4 fine pixels, two greys one above the other: black in the bottom square only.
    const rgba = new Uint8ClampedArray(2 * 4 * 4).fill(255);
    const p = (3 * 2 + 0) * 4;
    rgba[p] = 0;
    rgba[p + 1] = 0;
    rgba[p + 2] = 0;
    expect([...greysOfFine(rgba, 1, 2)]).toEqual([255, 0]);
  });
});

describe('greysOn', () => {
  it('draws the picture twice as fine on white, then reads it', () => {
    const calls: Call[] = [];
    const canvas = fakeCanvas((w, h) => gridPage(w, h), calls);
    const pic = greysOn(canvas, {} as CanvasImageSource, 800, 1136);
    expect(canvas.width).toBe(800);
    expect(canvas.height).toBe(1136);
    expect(calls).toEqual(['fill #FFFFFF 0,0,800,1136', 'draw 0,0,800,1136', 'read 0,0,800,1136']);
    expect(pic?.w).toBe(400);
    expect(pic?.h).toBe(568);
    expect(pic?.luma.length).toBe(400 * 568);
  });

  it('has nothing to give without a size or a context', () => {
    const calls: Call[] = [];
    expect(greysOn(fakeCanvas((w, h) => gridPage(w, h), calls), {} as CanvasImageSource, 0, 0)).toBeNull();
    expect(greysOn(fakeCanvas((w, h) => gridPage(w, h), calls, true), {} as CanvasImageSource, 100, 140)).toBeNull();
    expect(calls).toEqual([]);
  });

  it('gives greys the panels are found in', () => {
    const pic = greysOn(fakeCanvas((w, h) => gridPage(w, h), []), {} as CanvasImageSource, 600, 860);
    expect(framesIn(pic!).panels).toHaveLength(6);
  });
});

describe('drawsInWorker', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('needs both a canvas a worker can hold and a way to open pictures', () => {
    vi.stubGlobal('OffscreenCanvas', undefined);
    vi.stubGlobal('createImageBitmap', undefined);
    expect(drawsInWorker()).toBe(false);
    vi.stubGlobal('OffscreenCanvas', class {});
    expect(drawsInWorker()).toBe(false);
    vi.stubGlobal('createImageBitmap', () => null);
    expect(drawsInWorker()).toBe(true);
    vi.stubGlobal('OffscreenCanvas', undefined);
    expect(drawsInWorker()).toBe(false);
  });
});

describe('pictureFile', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is the file of a picture held in this tab', async () => {
    const file = new Blob(['jpeg'], { type: 'image/jpeg' });
    const fetch = vi.fn(async () => new Response(file));
    vi.stubGlobal('fetch', fetch);
    const got = await pictureFile({ currentSrc: 'blob:https://breader.site/1', src: 'blob:https://breader.site/1' } as HTMLImageElement);
    expect(fetch).toHaveBeenCalledWith('blob:https://breader.site/1');
    expect(await got?.text()).toBe('jpeg');
  });

  it('goes by the picture shown, when it has a choice of sources', async () => {
    const fetch = vi.fn(async () => new Response('x'));
    vi.stubGlobal('fetch', fetch);
    await pictureFile({ currentSrc: 'blob:shown', src: 'blob:other' } as HTMLImageElement);
    expect(fetch).toHaveBeenCalledWith('blob:shown');
  });

  it('is nothing for a picture elsewhere, which isn’t fetched', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect(await pictureFile({ currentSrc: '', src: 'https://example.com/a.jpg' } as HTMLImageElement)).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('is nothing once its file is let go', async () => {
    vi.stubGlobal('fetch', async () => { throw new TypeError('Failed to fetch'); });
    expect(await pictureFile({ currentSrc: '', src: 'blob:gone' } as HTMLImageElement)).toBeNull();
  });
});

describe('framesSoon', () => {
  afterEach(() => vi.unstubAllGlobals());

  /** frames.ts afresh, as it starts its worker once and keeps it. */
  async function fresh() {
    vi.resetModules();
    const { framesSoon } = await import('./frames');
    return framesSoon;
  }

  /** A worker that answers every ask with these frames, and keeps what it was sent. */
  function fakeWorker(sent: Array<{ ask: FramesAsk; moved: Transferable[] }>) {
    return class {
      onmessage: ((e: MessageEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      postMessage(ask: FramesAsk, moved: Transferable[]) {
        sent.push({ ask, moved });
        queueMicrotask(() => this.onmessage?.({ data: { id: ask.id, frames: { groups: [], panels: [{ x: 0, y: 0, w: 1, h: 0.5 }] } } } as MessageEvent));
      }
      terminate() {}
    };
  }

  it('sends a manga page’s file to the worker, and never reads its pixels here', async () => {
    const sent: Array<{ ask: FramesAsk; moved: Transferable[] }> = [];
    vi.stubGlobal('Worker', fakeWorker(sent));
    vi.stubGlobal('OffscreenCanvas', class {});
    vi.stubGlobal('createImageBitmap', () => null);
    vi.stubGlobal('fetch', async () => new Response(new Blob(['page'])));
    const createElement = vi.fn();
    vi.stubGlobal('document', { createElement });
    const img = { naturalWidth: 800, naturalHeight: 1136, currentSrc: 'blob:page-1', src: 'blob:page-1' } as HTMLImageElement;
    const framesSoon = await fresh();

    const frames = await framesSoon(img);

    expect(frames.panels).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect('file' in sent[0].ask).toBe(true);
    expect(sent[0].moved).toEqual([]);
    expect(createElement).not.toHaveBeenCalled();
  });

  it('asks once per picture', async () => {
    const sent: Array<{ ask: FramesAsk; moved: Transferable[] }> = [];
    vi.stubGlobal('Worker', fakeWorker(sent));
    vi.stubGlobal('OffscreenCanvas', class {});
    vi.stubGlobal('createImageBitmap', () => null);
    vi.stubGlobal('fetch', async () => new Response(new Blob(['page'])));
    const img = { naturalWidth: 800, naturalHeight: 1136, currentSrc: 'blob:page-2', src: 'blob:page-2' } as HTMLImageElement;
    const framesSoon = await fresh();
    await Promise.all([framesSoon(img), framesSoon(img)]);
    await framesSoon(img);
    expect(sent).toHaveLength(1);
  });

  it('where a worker can’t draw, sends greys drawn here, handed over rather than copied', async () => {
    const sent: Array<{ ask: FramesAsk; moved: Transferable[] }> = [];
    vi.stubGlobal('Worker', fakeWorker(sent));
    vi.stubGlobal('OffscreenCanvas', undefined);
    vi.stubGlobal('document', { createElement: () => fakeCanvas((w, h) => gridPage(w, h), []) });
    const img = { naturalWidth: 600, naturalHeight: 860, currentSrc: 'blob:page-3', src: 'blob:page-3' } as HTMLImageElement;
    const framesSoon = await fresh();

    await framesSoon(img);

    expect(sent).toHaveLength(1);
    const ask = sent[0].ask;
    expect('pic' in ask).toBe(true);
    if (!('pic' in ask)) return;
    expect(ask.pic.w).toBe(400);
    expect(sent[0].moved).toEqual([ask.pic.luma.buffer]);
  });

  it('finds nothing in a picture that won’t open', async () => {
    const sent: Array<{ ask: FramesAsk; moved: Transferable[] }> = [];
    vi.stubGlobal('Worker', fakeWorker(sent));
    const img = { naturalWidth: 0, naturalHeight: 0, currentSrc: 'blob:broken', src: 'blob:broken', decode: async () => { throw new Error('broken'); } } as unknown as HTMLImageElement;
    const framesSoon = await fresh();
    expect(await framesSoon(img)).toEqual({ groups: [], panels: [] });
    expect(sent).toHaveLength(0);
  });
});
