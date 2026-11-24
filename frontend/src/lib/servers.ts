/*
 * Which servers the app may talk to, and which it picks (ADR 0001, the app picks the server).
 * Any number, anywhere: VITE_API_SERVERS lists their addresses, the home server first. The home
 * server is the one with the voices and the panel model (api.laptop); the rest run the same API.
 */

/** How much slower than the quickest other server home may be and still be picked, in ms. */
export const MUCH_SLOWER = 300;

export interface ServerEnv {
  VITE_API_SERVERS?: string;
  VITE_API_URL?: string;
  VITE_API_FALLBACK_URL?: string;
}

function clean(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/**
 * The servers' addresses, home first, each once. VITE_API_SERVERS when set; else the older
 * VITE_API_URL and VITE_API_FALLBACK_URL; else, in development, :8787 and :8788 of the page's host.
 */
export function serverList(env: ServerEnv, here: string): string[] {
  let raw: string[] = [];
  if (env.VITE_API_SERVERS) {
    raw = env.VITE_API_SERVERS.split(',');
  } else {
    raw.push(env.VITE_API_URL || `${here}:8787`);
    raw.push(env.VITE_API_FALLBACK_URL || `${here}:8788`);
  }
  const out: string[] = [];
  for (const r of raw) {
    const url = clean(r);
    if (!url) continue;
    if (out.includes(url)) continue;
    out.push(url);
  }
  return out;
}

/** How long a server took to answer /health, in ms; null when it didn't answer well. */
export type Timings = Map<string, number | null>;

/** What a server's /health says of itself that the picking heeds (ADR 0004). */
export interface Signs {
  /** Its month's egress is near its limit (GCP): it's never used, even when others are down. */
  near: boolean;
  /** It's busy just now: not picked, but tried when nothing else answers. */
  busy: boolean;
}

/** The signs in a /health answer; none in one that isn't an object. */
export function signsOf(health: unknown): Signs {
  const signs: Signs = { near: false, busy: false };
  if (typeof health !== 'object' || health === null) return signs;
  const h = health as { busy?: unknown; egress?: { near?: unknown } };
  if (h.busy === true) signs.busy = true;
  if (h.egress?.near === true) signs.near = true;
  return signs;
}

/** The quickest server that answered, other than home; null when none did. */
function quickestOther(servers: string[], timings: Timings): string | null {
  let best: string | null = null;
  let bestMs = Infinity;
  for (const s of servers.slice(1)) {
    const ms = timings.get(s);
    if (ms === null || ms === undefined) continue;
    if (ms < bestMs) {
      best = s;
      bestMs = ms;
    }
  }
  return best;
}

/**
 * The server to use: home, unless it didn't answer or is much slower than the quickest other
 * (a reader far from it); then the quickest other. Home when nothing answered.
 */
export function pickServer(servers: string[], timings: Timings): string {
  const home = servers[0];
  const homeMs = timings.get(home);
  const other = quickestOther(servers, timings);
  if (other === null) return home;
  if (homeMs === null || homeMs === undefined) return other;
  const otherMs = timings.get(other)!;
  if (homeMs > otherMs + MUCH_SLOWER) return other;
  return home;
}

/**
 * The order to try the servers in when `first` can't be reached: `first`, then those that
 * answered quickest, then the ones not heard from (or busy). None that are `near`.
 */
export function tryOrder(servers: string[], first: string, timings: Timings, near: ReadonlySet<string> = new Set()): string[] {
  const rest: string[] = [];
  for (const s of servers) {
    if (s === first) continue;
    if (near.has(s)) continue;
    rest.push(s);
  }
  const ms = (s: string) => {
    const t = timings.get(s);
    if (t === null || t === undefined) return Infinity;
    return t;
  };
  rest.sort((a, b) => ms(a) - ms(b));
  return [first, ...rest];
}
