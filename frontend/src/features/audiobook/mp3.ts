/*
 * MP3, as Breader's computer makes it (server speech/worker.ts): mono, 48 kilobits a second, clear
 * for speech and about 22 MB an hour. MP3 plays on every phone, computer, car and speaker, and
 * MP3s of one kind put end to end are one MP3, so an audiobook's parts become one file to keep.
 */

let worker: Worker | null = null;
let next = 1;
const waiting = new Map<number, { resolve: (b: Uint8Array) => void; reject: (e: Error) => void }>();

/** A paragraph's sound as MP3, made in a worker of its own (mp3.worker.ts). */
export function encode(audio: Float32Array, rate: number): Promise<Uint8Array> {
  if (!worker) {
    worker = new Worker(new URL('./mp3.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<{ id: number; mp3?: Uint8Array; error?: string }>) => {
      const w = waiting.get(e.data.id);
      if (!w) return;
      waiting.delete(e.data.id);
      if (e.data.mp3) w.resolve(e.data.mp3);
      else w.reject(new Error(e.data.error ?? 'It couldn’t be made into MP3.'));
    };
  }
  const id = next++;
  const w = worker;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    w.postMessage({ id, audio, rate }, [audio.buffer as ArrayBuffer]);
  });
}

/** Done making audiobooks here: the encoder goes. */
export function releaseEncoder() {
  worker?.terminate();
  worker = null;
  for (const w of waiting.values()) w.reject(new Error('Stopped'));
  waiting.clear();
}

export function join(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** An ID3 tag, so players show the book's title and author instead of the file's name. */
export function tag(title: string, author: string): Uint8Array {
  const frame = (id: string, text: string) => {
    // UTF-16 with its byte order mark, which ID3 2.3 reads everywhere.
    const body = new Uint8Array(3 + text.length * 2);
    body[0] = 1;
    body[1] = 0xff;
    body[2] = 0xfe;
    for (let i = 0; i < text.length; i++) {
      body[3 + i * 2] = text.charCodeAt(i) & 0xff;
      body[4 + i * 2] = text.charCodeAt(i) >> 8;
    }
    const head = new Uint8Array(10);
    for (let i = 0; i < 4; i++) head[i] = id.charCodeAt(i);
    new DataView(head.buffer).setUint32(4, body.length);
    return join([head, body]);
  };
  const frames = join([
    frame('TIT2', title),
    frame('TALB', title),
    ...(author ? [frame('TPE1', author)] : []),
    frame('TCON', 'Audiobook'),
  ]);
  const head = new Uint8Array(10);
  head.set([0x49, 0x44, 0x33, 3, 0, 0]);
  // Its size, seven bits to a byte.
  const n = frames.length;
  head[6] = (n >> 21) & 0x7f;
  head[7] = (n >> 14) & 0x7f;
  head[8] = (n >> 7) & 0x7f;
  head[9] = n & 0x7f;
  return join([head, frames]);
}
