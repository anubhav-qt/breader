import manifest from './files.json';

/*
 * The files reading aloud needs, kept in Cache Storage so voices work offline once fetched. Big
 * files come in parts (scripts/voices.mjs), each cached as it arrives, so a download that stops
 * picks up where it left off. A file is checked against its SHA-256 once, the first time it's whole.
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
}
const memory = new Map<string, Response>();
const inMemory: Box = {
  match: async (k) => memory.get(k)?.clone(),
  put: async (k, r) => { memory.set(k, r); },
  delete: async (k) => memory.delete(k),
};
const open = (): Promise<Box> => (typeof caches === 'undefined' ? Promise.resolve(inMemory) : caches.open(CACHE));
const verifiedKey = (sha: string) => `/voice-cache/verified/${sha}`;

/** One of the files the app hosts (files.json). */
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

/** Reads a response's body, counting bytes as they arrive. */
async function drain(res: Response, onBytes: (n: number) => void, signal?: AbortSignal): Promise<Uint8Array> {
  if (!res.body) {
    const b = new Uint8Array(await res.arrayBuffer());
    onBytes(b.byteLength);
    return b;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    if (signal?.aborted) { void reader.cancel(); throw new DOMException('Stopped', 'AbortError'); }
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
    onBytes(value.byteLength);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out;
}

const hex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');

/**
 * The whole file, from the cache or the network. `onBytes` hears every byte, cached ones at once,
 * so progress starts from what's already here.
 */
export async function load(w: Want, onBytes: (n: number) => void = () => {}, signal?: AbortSignal): Promise<Uint8Array> {
  const c = await open();
  const parts: Uint8Array[] = [];
  let fresh = false;
  for (let i = 0; i < w.keys.length; i++) {
    const key = w.keys[i];
    const hit = await c.match(key);
    if (hit) {
      const b = new Uint8Array(await hit.arrayBuffer());
      onBytes(b.byteLength);
      parts.push(b);
      continue;
    }
    const res = await fetch(w.from?.[i] ?? key, { cache: 'no-store' });
    if (!res.ok) throw new Error(`Breader couldn’t download a voice file (${res.status}).`);
    const b = await drain(res, onBytes, signal);
    await c.put(key, new Response(b, { headers: { 'content-type': 'application/octet-stream' } }));
    parts.push(b);
    fresh = true;
  }
  const size = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = parts.length === 1 ? parts[0] : new Uint8Array(size);
  if (parts.length > 1) {
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.byteLength; }
  }
  if (w.sha256 && crypto.subtle && (fresh || !(await c.match(verifiedKey(w.sha256))))) {
    const got = hex(await crypto.subtle.digest('SHA-256', out));
    if (got !== w.sha256) {
      await forget(w);
      throw new Error('A voice file arrived damaged. Try again.');
    }
    await c.put(verifiedKey(w.sha256), new Response(''));
  }
  return out;
}

export async function forget(w: Want) {
  const c = await open();
  await Promise.all(w.keys.map((k) => c.delete(k)));
  if (w.sha256) await c.delete(verifiedKey(w.sha256));
}
