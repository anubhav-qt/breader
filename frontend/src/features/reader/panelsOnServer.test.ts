import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * Panels on server (serverPanels.ts): a switch on every device that can find panels itself, off to
 * start with, kept on this device. Away from the Panels layout it asks nothing of the server.
 */

const asked: string[] = [];
vi.mock('../../lib/api', () => ({
  ApiError: class extends Error {},
  api: {
    get: async () => ({}),
    laptop: {
      get: async (path: string) => { asked.push(path); return { allowed: true, round: 21, used: 0, seats: 8 }; },
      post: async (path: string) => { asked.push(path); return { seated: true, used: 1, seats: 8 }; },
      raw: async () => new Response(null),
    },
  },
}));
vi.mock('../../lib/mangadex', () => ({ readMangaPrefs: () => ({ saver: false }) }));
vi.mock('./able', () => ({ checkDevice: async () => {}, gpuHere: async () => true, panelModelBroke: () => false, panelsHere: () => true }));
vi.mock('./panelModel', () => ({}));
vi.mock('./frames', () => ({}));
vi.mock('./settings', () => ({ panelled: () => true }));

// The tests run in Node: this device's storage, kept in a map.
const kept = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => kept.get(k) ?? null,
  setItem: (k: string, v: string) => { kept.set(k, v); },
});

const load = async () => {
  vi.resetModules();
  return import('./serverPanels');
};

describe('panels on server', () => {
  beforeEach(() => {
    kept.clear();
    asked.length = 0;
  });

  it('is off to start with', async () => {
    const m = await load();
    expect(m.panelsOnServer()).toBe(false);
  });

  it('stays as it was turned, on this device', async () => {
    let m = await load();
    m.setPanelsOnServer(true);
    expect(m.panelsOnServer()).toBe(true);
    m = await load();
    expect(m.panelsOnServer()).toBe(true);
    m.setPanelsOnServer(false);
    m = await load();
    expect(m.panelsOnServer()).toBe(false);
  });

  it('flips each time, however fast', async () => {
    const m = await load();
    for (let i = 0; i < 5; i++) m.setPanelsOnServer(!m.panelsOnServer());
    expect(m.panelsOnServer()).toBe(true);
  });

  it('takes no seat while no manga is open in the Panels layout', async () => {
    const m = await load();
    m.setPanelsOnServer(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(asked).toEqual([]);
  });

  it('reads a broken note as off', async () => {
    kept.set('breader.panels.server.v1', '{"on":"yes"}');
    const m = await load();
    expect(m.panelsOnServer()).toBe(false);
  });
});
