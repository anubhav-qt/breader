import { describe, expect, it } from 'vitest';
import { MUCH_SLOWER, pickServer, serverList, signsOf, standbyList, tryOrder, type Timings } from './servers';

const HOME = 'https://home.example';
const EU = 'https://eu.example';
const US = 'https://us.example';
const ALL = [HOME, EU, US];

const times = (pairs: [string, number | null][]): Timings => new Map(pairs);

describe('serverList', () => {
  it('reads the list, home first, trimmed, each once', () => {
    const list = serverList({ VITE_API_SERVERS: ` ${HOME}/ ,${EU},, ${US}, ${EU}/` }, 'http://localhost');
    expect(list).toEqual(ALL);
  });

  it('takes one server alone', () => {
    expect(serverList({ VITE_API_SERVERS: HOME }, 'http://localhost')).toEqual([HOME]);
  });

  it('falls back to the older two names', () => {
    const list = serverList({ VITE_API_URL: HOME, VITE_API_FALLBACK_URL: EU }, 'http://localhost');
    expect(list).toEqual([HOME, EU]);
  });

  it('uses the page’s own host while developing', () => {
    expect(serverList({}, 'http://127.0.0.1')).toEqual(['http://127.0.0.1:8787', 'http://127.0.0.1:8788']);
  });

  it('prefers the list over the older names', () => {
    expect(serverList({ VITE_API_SERVERS: US, VITE_API_URL: HOME }, 'http://localhost')).toEqual([US]);
  });
});

describe('standbyList', () => {
  it('is empty when none is set', () => {
    expect(standbyList({}, ALL)).toEqual([]);
    expect(standbyList({ VITE_API_STANDBY: ' , ' }, ALL)).toEqual([]);
  });

  it('keeps each once, trimmed, and none already a server', () => {
    const env = { VITE_API_STANDBY: ' https://az.example/ ,https://az.example,https://eu.example' };
    expect(standbyList(env, ALL)).toEqual(['https://az.example']);
  });
});

describe('pickServer', () => {
  it('keeps home when it is about as quick', () => {
    expect(pickServer(ALL, times([[HOME, 120], [EU, 80], [US, 300]]))).toBe(HOME);
  });

  it('keeps home at exactly the margin', () => {
    expect(pickServer(ALL, times([[HOME, 80 + MUCH_SLOWER], [EU, 80]]))).toBe(HOME);
  });

  it('takes the quickest other when home is much slower', () => {
    expect(pickServer(ALL, times([[HOME, 81 + MUCH_SLOWER], [EU, 200], [US, 80]]))).toBe(US);
  });

  it('takes the quickest other when home does not answer', () => {
    expect(pickServer(ALL, times([[HOME, null], [EU, 900], [US, null]]))).toBe(EU);
  });

  it('stays home when nothing answered', () => {
    expect(pickServer(ALL, times([[HOME, null], [EU, null], [US, null]]))).toBe(HOME);
    expect(pickServer(ALL, new Map())).toBe(HOME);
  });

  it('stays home when it is the only server', () => {
    expect(pickServer([HOME], times([[HOME, null]]))).toBe(HOME);
  });
});

describe('tryOrder', () => {
  it('starts with the one in use, then the quickest, then the unheard', () => {
    expect(tryOrder(ALL, EU, times([[HOME, null], [US, 50]]))).toEqual([EU, US, HOME]);
  });

  it('keeps list order among the unheard', () => {
    expect(tryOrder(ALL, US, new Map())).toEqual([US, HOME, EU]);
  });

  it('leaves out the servers near their egress limit', () => {
    expect(tryOrder(ALL, EU, times([[HOME, 90], [US, 50]]), new Set([US]))).toEqual([EU, HOME]);
  });
});

describe('signsOf', () => {
  it('reads busy and near from a health answer', () => {
    expect(signsOf({ ok: true })).toEqual({ near: false, busy: false, jsonOnly: false });
    expect(signsOf({ ok: true, busy: true })).toEqual({ near: false, busy: true, jsonOnly: false });
    expect(signsOf({ ok: true, egress: { usedMb: 900, limitMb: 800, near: true } })).toEqual({ near: true, busy: false, jsonOnly: false });
  });

  it('reads that a server sends JSON alone, and only from a true', () => {
    expect(signsOf({ ok: true, jsonOnly: true })).toEqual({ near: false, busy: false, jsonOnly: true });
    expect(signsOf({ ok: true, jsonOnly: 'yes' })).toEqual({ near: false, busy: false, jsonOnly: false });
  });

  it('takes nothing from an answer that isn’t one', () => {
    expect(signsOf(null)).toEqual({ near: false, busy: false, jsonOnly: false });
    expect(signsOf('busy')).toEqual({ near: false, busy: false, jsonOnly: false });
    expect(signsOf({ busy: 'yes', egress: { near: 1 } })).toEqual({ near: false, busy: false, jsonOnly: false });
  });
});
