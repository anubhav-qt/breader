import { baseUrl, type ApiBase } from '../lib/api';
import { STEPS, UPLOAD_STEPS, type Admin, type Marker, type Snapshot, type Working } from './types';

/*
 * The admin page's server: /admin/stream pushes everything the page shows the moment it changes
 * (server/src/routes/admin.ts), read with fetch so it can carry the admin token, and each button
 * posts to /admin. It talks to the laptop, and to the fallback while the laptop doesn't answer,
 * asking the laptop again every minute, as the app does (lib/api.ts). The AI accounts are the
 * laptop's only.
 *
 * The token is kept for the tab (sessionStorage), never anywhere else.
 */

const TOKEN_KEY = 'breader.admin';
/** How long to wait for the stream to start, and between tries after it breaks. */
const OPEN_MS = 6000;
const AGAIN_MS = [1000, 2000, 5000, 10_000];
/** Nothing down the stream for this long, not even its ping every 20 s, means it's gone. */
const SILENT_MS = 50_000;
const PROBE_MS = 60_000;
const GATEWAY = new Set([502, 503, 504, 530]);
/** How long a sign-in has to finish once its address is pasted. */
const SIGN_IN_MS = 60_000;

export function savedToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function saveToken(token: string | null) {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* kept for this page only */
  }
}

/** The server turned the token down. */
export class NotAdmin extends Error {}

const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

/** What the server sends, with the marker's view made safe for the page: an older marker says less. */
function snapshotOf(raw: Snapshot & { request?: Snapshot['status']['request'] }): Snapshot {
  const status = { ...raw.status };
  if (raw.request) status.request = raw.request;
  if (!status.request) status.request = { ip: '', from: '', headers: {} };
  return { status, marker: markerOf(raw.marker), accounts: raw.accounts ?? null };
}

function markerOf(m: Marker | null): Marker | null {
  if (!m || !m.settings) return null;
  const working = (m.working ?? []).map((w): Working => {
    let steps = STEPS[w.task] ?? STEPS.marks;
    if (w.upload) steps = UPLOAD_STEPS;
    let step = w.step;
    if (!steps.some((s) => s.key === step)) step = steps[0].key;
    return {
      ...w,
      step,
      skipped: (w.skipped ?? []).filter((k) => k !== step),
      since: w.since ?? m.at,
      stepSince: w.stepSince ?? w.since ?? m.at,
      parts: w.parts ?? [],
      model: w.model ?? null,
      account: w.account ?? null,
      calls: w.calls ?? 0,
      log: w.log ?? [],
    };
  });
  return { ...m, working, queue: (m.queue ?? []).filter((q) => q.id) };
}

/** Each "event: …" and "data: …" block of a stream, as it arrives. */
function* events(text: string): Generator<{ event: string; data: string }> {
  for (const block of text.split('\n\n')) {
    let event = 'message';
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (data.length) yield { event, data: data.join('\n') };
  }
}

export function liveAdmin(token: string): Admin {
  let via: ApiBase = 'primary';

  const headers = (json: boolean): HeadersInit => {
    const h: Record<string, string> = { authorization: `Bearer ${token}` };
    if (json) h['content-type'] = 'application/json';
    return h;
  };

  /** One try at one copy of the server: null when it can't be reached. */
  async function attempt(base: ApiBase, path: string, init: RequestInit): Promise<Response | null> {
    try {
      const res = await fetch(baseUrl(base) + path, { ...init, cache: 'no-store' });
      if (GATEWAY.has(res.status)) return null;
      return res;
    } catch {
      return null;
    }
  }

  /** A request where the stream is, then the other copy when that one can't be reached. The JSON answer, or what went wrong. */
  async function send<T>(method: string, path: string, body?: unknown, raw?: string): Promise<T> {
    const init: RequestInit = { method, headers: headers(body !== undefined || raw !== undefined) };
    if (raw !== undefined) init.body = raw;
    else if (body !== undefined) init.body = JSON.stringify(body);
    const other: ApiBase = via === 'primary' ? 'fallback' : 'primary';
    let res = await attempt(via, path, init);
    if (!res) res = await attempt(other, path, init);
    if (!res) throw new Error('Neither server answered.');
    const data = await res.json().catch(() => null);
    if (res.status === 401) throw new NotAdmin(data?.message ?? 'That isn’t the admin token.');
    if (!res.ok) throw new Error(data?.message ?? `The server answered ${res.status}.`);
    return data as T;
  }

  /** The laptop alone: the AI accounts are only there. */
  async function laptop<T>(method: string, path: string, body?: unknown): Promise<T> {
    const init: RequestInit = { method, headers: headers(body !== undefined) };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await attempt('primary', path, init);
    if (!res) throw new Error('The ThinkPad isn’t answering.');
    const data = await res.json().catch(() => null);
    if (res.status === 401) throw new NotAdmin(data?.message ?? 'That isn’t the admin token.');
    if (!res.ok) throw new Error(data?.message ?? `The server answered ${res.status}.`);
    return data as T;
  }

  /** Buttons don't wait: what went wrong goes to the page's error line. */
  let failed: (message: string) => void = () => {};
  const fire = (method: string, path: string, body?: unknown) => {
    send(method, path, body).catch((e: unknown) => failed(e instanceof Error ? e.message : String(e)));
  };
  const queue = (action: string, id: string, task: string, held?: boolean) => fire('POST', '/admin/queue', { action, id, task, held });

  return {
    watch(on, link, error) {
      let stopped = false;
      let ctrl: AbortController | null = null;
      let probe = 0;
      if (error) failed = error;

      /** Reads one stream until it ends, breaks, or goes quiet. */
      const read = async (base: ApiBase): Promise<'ended' | 'unreachable'> => {
        ctrl = new AbortController();
        const mine = ctrl;
        const opening = window.setTimeout(() => mine.abort(), OPEN_MS);
        let res: Response;
        try {
          res = await fetch(`${baseUrl(base)}/admin/stream`, { headers: headers(false), cache: 'no-store', signal: mine.signal });
        } catch {
          return 'unreachable';
        } finally {
          window.clearTimeout(opening);
        }
        if (res.status === 401) {
          const data = await res.json().catch(() => null);
          throw new NotAdmin(data?.message ?? 'That isn’t the admin token.');
        }
        if (!res.ok || !res.body || GATEWAY.has(res.status)) return 'unreachable';
        via = base;
        watchLaptop();
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let quiet = window.setTimeout(() => mine.abort(), SILENT_MS);
        let rest = '';
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) return 'ended';
            window.clearTimeout(quiet);
            quiet = window.setTimeout(() => mine.abort(), SILENT_MS);
            rest += value;
            const end = rest.lastIndexOf('\n\n');
            if (end < 0) continue;
            const whole = rest.slice(0, end);
            rest = rest.slice(end + 2);
            for (const e of events(whole)) {
              if (e.event !== 'snapshot') continue;
              on(snapshotOf(JSON.parse(e.data)));
              link?.('live');
            }
          }
        } catch {
          return 'ended';
        } finally {
          window.clearTimeout(quiet);
        }
      };

      /** While on the fallback, the laptop is asked every minute whether it's back, and taken back to. */
      const watchLaptop = () => {
        window.clearInterval(probe);
        if (via !== 'fallback') return;
        probe = window.setInterval(async () => {
          const res = await attempt('primary', '/health', {});
          if (res?.ok) {
            via = 'primary';
            window.clearInterval(probe);
            ctrl?.abort();
          }
        }, PROBE_MS);
      };

      const run = async () => {
        let tries = 0;
        while (!stopped) {
          link?.('connecting');
          const first = via;
          const other: ApiBase = first === 'primary' ? 'fallback' : 'primary';
          try {
            let how = await read(first);
            if (how === 'unreachable' && !stopped) how = await read(other);
            if (how === 'ended') tries = 0;
          } catch (e) {
            if (e instanceof NotAdmin) {
              link?.('denied');
              return;
            }
          }
          if (stopped) return;
          const wait = AGAIN_MS[Math.min(tries, AGAIN_MS.length - 1)];
          tries++;
          await sleep(wait);
        }
      };
      void run();

      return () => {
        stopped = true;
        window.clearInterval(probe);
        ctrl?.abort();
      };
    },
    settings: (patch) => fire('POST', '/admin/settings', patch),
    next: (id, task) => queue('next', id, task),
    hold: (id, task, held) => queue('hold', id, task, held),
    retry: (id, task) => queue('retry', id, task),
    stop: (id, task) => queue('stop', id, task),
    redoStep: (id, task) => queue('redo', id, task),
    first: (library, id) => fire('POST', '/admin/first', { library, id }),
    runJob: (name) => fire('POST', `/admin/jobs/${encodeURIComponent(name)}/run`, {}),
    jobOn: (name, on) => fire('POST', `/admin/jobs/${encodeURIComponent(name)}/on`, { on }),
    useFirst: (id) => {
      laptop('POST', `/admin/accounts/${encodeURIComponent(id)}/first`, {}).catch((e: unknown) => failed(e instanceof Error ? e.message : String(e)));
    },
    async removeAccount(id) {
      await laptop('DELETE', `/admin/accounts/${encodeURIComponent(id)}`);
    },
    async startSignIn(kind) {
      return laptop<{ url: string; state: string }>('POST', '/admin/accounts/connect', { kind });
    },
    async finishSignIn(state, address) {
      await laptop('POST', '/admin/accounts/finish', { state, redirectUrl: address });
      const until = Date.now() + SIGN_IN_MS;
      while (Date.now() < until) {
        const s = await laptop<{ status: 'wait' | 'ok' | 'error'; error?: string }>('GET', `/admin/accounts/status?state=${encodeURIComponent(state)}`);
        if (s.status === 'ok') return;
        if (s.status === 'error') throw new Error(s.error ?? 'The sign-in failed.');
        await sleep(1000);
      }
      throw new Error('The sign-in didn’t finish. Try again.');
    },
    async uploadMusic(text) {
      try {
        JSON.parse(text);
      } catch {
        throw new Error('That file isn’t JSON.');
      }
      const r = await send<{ cues: number; tracks: number; soundtrack: number }>('POST', '/admin/music', undefined, text);
      return `${r.cues} cues, ${r.tracks} tracks`;
    },
  };
}
