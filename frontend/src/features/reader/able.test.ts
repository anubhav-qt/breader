import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * What a device does itself (able.ts): each rule on its own, with the processor's score, the
 * graphics chip and the device faked.
 */

const fake = { pace: 6, score: 1 as number | undefined };

vi.mock('../audiobook/speed', () => ({
  devicePace: () => fake.pace,
  measure: () => Promise.resolve(),
  processorScore: () => fake.score,
}));

const load = async () => {
  vi.resetModules();
  const m = await import('./able');
  await m.checkDevice();
  return m;
};

const own = (key: string, value: unknown) => Object.defineProperty(navigator, key, { value, configurable: true });
const memory = (gb: number | undefined) => own('deviceMemory', gb);
const gpu = (yes: boolean) => own('gpu', { requestAdapter: () => Promise.resolve(yes ? {} : null) });
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';

describe('what this device does itself', () => {
  beforeEach(() => {
    Object.assign(fake, { pace: 6, score: 1 });
    memory(undefined);
    gpu(true);
    own('userAgent', ANDROID);
    own('maxTouchPoints', 5);
    // Node has no workers on the page; a browser does.
    vi.stubGlobal('Worker', class {});
  });

  it('leaves reading aloud to the server where there are no workers to run a voice', async () => {
    vi.stubGlobal('Worker', undefined);
    expect((await load()).voiceHere()).toBe(false);
  });

  it('reads aloud and finds panels itself, where it can', async () => {
    const m = await load();
    expect(m.voiceHere()).toBe(true);
    expect(m.panelsHere()).toBe(true);
  });

  it('leaves reading aloud to the server where it can’t keep up', async () => {
    fake.pace = 1.2;
    expect((await load()).voiceHere()).toBe(false);
    fake.pace = 1.5;
    expect((await load()).voiceHere()).toBe(true);
  });

  it('leaves reading aloud to the server with under 2 GB', async () => {
    memory(1);
    expect((await load()).voiceHere()).toBe(false);
    memory(2);
    expect((await load()).voiceHere()).toBe(true);
  });

  it('leaves panels to the server on an iPhone or iPad, whose tab the model crashed', async () => {
    own('userAgent', IPHONE);
    expect((await load()).panelsHere()).toBe(false);
    // An iPad says it's a Mac, with a touch screen.
    own('userAgent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15');
    expect((await load()).panelsHere()).toBe(false);
    own('maxTouchPoints', 0);
    expect((await load()).panelsHere()).toBe(true);
  });

  it('leaves panels to the server with under 4 GB, or once the model broke here', async () => {
    memory(3);
    expect((await load()).panelsHere()).toBe(false);
    memory(4);
    const m = await load();
    expect(m.panelsHere()).toBe(true);
    m.modelBroke();
    expect(m.panelsHere()).toBe(false);
  });

  it('finds panels without a graphics chip only on a quick processor', async () => {
    gpu(false);
    fake.score = 0.3;
    expect((await load()).panelsHere()).toBe(false);
    fake.score = 0.8;
    expect((await load()).panelsHere()).toBe(true);
    // Not measured: taken as able, so the server isn't asked for nothing.
    fake.score = undefined;
    expect((await load()).panelsHere()).toBe(true);
  });
});
