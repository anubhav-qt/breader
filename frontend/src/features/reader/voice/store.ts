import manifest from '@breader/shared/voice-files.json';

/*
 * The files reading aloud needs, kept in Cache Storage so voices work offline once fetched. Big
 * files come in parts (scripts/voices.mjs), each cached as it arrives, so a download that stops
 * picks up where it left off. A file is checked against its SHA-256 once, the first time it's whole.
 *
 * A phone short of space may refuse to keep a file. Then the other voices' files make room (they
 * download again if they're wanted), and if there's still none, the voice reads anyway, from what
 * was just downloaded, and downloads again next time.
 *
 * Works in the page and in the speech worker alike. A page opened over plain http (a phone trying
 * the dev server) has no Cache Storage or hashing: files are then kept in memory and not checked.
 */

export type HostedName = keyof typeof manifest.files;

export interface Want {
  /** What progress calls it. */
  name: string;
  /** Unpacked bytes, for progress; uploaded files guess until their download says. */
  size: number;
  sha256?: string;
  /** Cache keys, one per part. Hosted parts are also where they're fetched from. */
  keys: string[];
  /** Where each part is fetched from, when that isn't its key: an uploaded file's signed link. */
  from?: string[];
}

const CACHE = 'breader-voices-v1';
const PART = manifest.partBytes;
const files = manifest.files as Record<HostedName, { url?: string; path?: string; size: number; sha256: string }>;

interface Box {
  match(key: string): Promise<Response | undefined>;
  put(key: string, res: Response): Promise<void>;
  delete(key: string): Promise<boolean>;
  keys?(): Promise<readonly Request[]>;
}
const memory = new Map<string, Response>();
const inMemory: Box = {
  match: async (k) => memory.get(k)?.clone(),
  put: async (k, r) => { memory.set(k, r); },
  delete: async (k) => memory.delete(k),
};
const open = (): Promise<Box> => (typeof caches === 'undefined' ? Promise.resolve(inMemory) : caches.open(CACHE));
const verifiedKey = (sha: string) => `/voice-cache/verified/${sha}`;

/** Files this page or worker has used, which room is never made by clearing out. */
const held = new Set<string>();

/** Keeps one file, or part of one, making room if the device is out of it. */
async function stash(c: Box, key: string, bytes: Uint8Array) {
  const res = () => new Response(bytes as Uint8Array<ArrayBuffer>, { headers: { 'content-type': 'application/octet-stream' } });
  try {
    await c.put(key, res());
  } catch (e) {
    if ((e as DOMException | null)?.name !== 'QuotaExceededError' || !c.keys) return;
    for (const r of await c.keys()) {
      if (!held.has(r.url) && !r.url.includes('/voice-cache/verified/')) await c.delete(r.url);
    }
    await c.put(key, res()).catch(() => {});
  }
}

/** One of the files the app hosts (shared voice-files.json). */
export function hosted(name: HostedName): Want {
  const f = files[name];
  if (f.url) return { name, size: f.size, sha256: f.sha256, keys: [f.url] };
  const base = new URL(`/${f.path}`, self.location.origin).href;
  const n = Math.ceil(f.size / PART);
  return { name, size: f.size, sha256: f.sha256, keys: n === 1 ? [base] : Array.from({ length: n }, (_, i) => `${base}.${i}`) };
}

/** A file a reader uploaded. Before it's cached, `from` needs its signed link. */
export function uploaded(fileId: string, size: number): Want {
  return { name: fileId, size, keys: [new URL(`/voice-cache/files/${fileId}`, self.location.origin).href] };
}

export async function has(w: Want): Promise<boolean> {
  try {
    const c = await open();
    for (const k of w.keys) if (!(await c.match(k))) return false;
    return true;
  } catch {
    return false;
  }
}

/** Hands over a response's body as it arrives, counting the bytes. */
async function drain(res: Response, write: (chunk: Uint8Array) => void, onBytes: (n: number) => void, signal?: AbortSignal) {
  if (!res.body) {
    const b = new Uint8Array(await res.arrayBuffer());
    write(b);
    onBytes(b.byteLength);
    return;
  }
  const reader = res.body.getReader();
  for (;;) {
    if (signal?.aborted) { void reader.cancel(); throw new DOMException('Stopped', 'AbortError'); }
    const { done, value } = await reader.read();
    if (done) break;
    write(value);
    onBytes(value.byteLength);
  }
}

const hex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');

/**
 * The whole file, from the cache or the network. `onBytes` hears every byte, cached ones at once,
 * so progress starts from what's already here.
 *
 * Parts go straight into one buffer the size of the file as they come, so a model is held once,
 * not once in parts and again joined up (a phone may have little room for either).
 */
export async function load(w: Want, onBytes: (n: number) => void = () => {}, signal?: AbortSignal): Promise<Uint8Array> {
  const c = await open();
  for (const k of w.keys) held.add(k);
  let whole: Uint8Array | null = null;
  let at = 0;
  const write = (b: Uint8Array) => {
    if (!whole) whole = new Uint8Array(Math.max(w.size, b.byteLength));
    // Bigger than it said (an uploaded file's size is a guess until it's here).
    if (at + b.byteLength > whole.length) {
      const grown = new Uint8Array(Math.max(at + b.byteLength, whole.length * 1.5));
      grown.set(whole.subarray(0, at));
      whole = grown;
    }
    whole.set(b, at);
    at += b.byteLength;
  };
  let fresh = false;
  for (let i = 0; i < w.keys.length; i++) {
    const key = w.keys[i];
    const hit = await c.match(key);
    if (hit) {
      const b = new Uint8Array(await hit.arrayBuffer());
      onBytes(b.byteLength);
      // A file in one part is already whole.
      if (w.keys.length === 1) { whole = b; at = b.byteLength; }
      else write(b);
      continue;
    }
    const res = await fetch(w.from?.[i] ?? key, { cache: 'no-store' });
    if (!res.ok) throw new Error(`Breader couldn’t download a voice file (${res.status}).`);
    const from = at;
    await drain(res, write, onBytes, signal);
    await stash(c, key, (whole ?? new Uint8Array(0)).subarray(from, at));
    fresh = true;
  }
  const out = (whole ?? new Uint8Array(0)).subarray(0, at);
  if (w.sha256 && crypto.subtle && (fresh || !(await c.match(verifiedKey(w.sha256))))) {
    const got = hex(await crypto.subtle.digest('SHA-256', out));
    if (got !== w.sha256) {
      await forget(w);
      throw new Error('A voice file arrived damaged. Try again.');
    }
    await c.put(verifiedKey(w.sha256), new Response('')).catch(() => {});
  }
  return out;
}

/** Keeps a file this device already holds, one it just uploaded, so it needn't come back down. */
export async function keep(w: Want, bytes: Uint8Array) {
  const c = await open();
  held.add(w.keys[0]);
  await stash(c, w.keys[0], bytes);
}

export async function forget(w: Want) {
  const c = await open();
  await Promise.all(w.keys.map((k) => c.delete(k)));
  if (w.sha256) await c.delete(verifiedKey(w.sha256));
}
