import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * Where reading aloud happens (prefs.ts readsOnServer): a phone has a switch, on to start with;
 * anything else reads on the server only when it can't keep up.
 */

vi.mock('../able', () => ({ voiceHere: () => true }));
vi.mock('./list', () => ({ listedVoices: () => [] }));
vi.mock('./server', () => ({ serverHas: () => true, speechAllowed: () => true }));

// The tests run in Node: this device's storage, kept in a map.
const kept = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => kept.get(k) ?? null,
  setItem: (k: string, v: string) => { kept.set(k, v); },
});

const load = async () => {
  vi.resetModules();
  return import('./prefs');
};

describe('read on server', () => {
  beforeEach(() => kept.clear());

  it('is on for a phone to start with', async () => {
    const m = await load();
    expect(m.voicePrefs().server).toBe(true);
    expect(m.readsOnServer(true, true, true)).toBe(true);
  });

  it('a phone with it off reads itself, even a slow one', async () => {
    const m = await load();
    m.setVoicePrefs({ server: false });
    expect(m.readsOnServer(true, true, true)).toBe(false);
    expect(m.readsOnServer(true, false, true)).toBe(false);
  });

  it('is kept on this device', async () => {
    const first = await load();
    first.setVoicePrefs({ server: false });
    const again = await load();
    expect(again.voicePrefs().server).toBe(false);
  });

  it('never reads on the server where it is not open to this account', async () => {
    const m = await load();
    expect(m.readsOnServer(false, false, true)).toBe(false);
    expect(m.readsOnServer(false, false, false)).toBe(false);
  });

  it('a computer reads on the server only when too slow, whatever the switch', async () => {
    const m = await load();
    expect(m.readsOnServer(true, true, false)).toBe(false);
    expect(m.readsOnServer(true, false, false)).toBe(true);
    m.setVoicePrefs({ server: false });
    expect(m.readsOnServer(true, false, false)).toBe(true);
  });
});
