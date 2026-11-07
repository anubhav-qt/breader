/// <reference lib="webworker" />
import { Mp3Encoder } from '@breezystack/lamejs';

/*
 * Encodes an audiobook's paragraphs as MP3 off the page: a page in the background gets its timers
 * slowed to a crawl, a worker doesn't, so a book keeps being made while the reader is elsewhere.
 */

const KBPS = 48;
const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = (e: MessageEvent<{ id: number; audio: Float32Array; rate: number }>) => {
  const { id, audio, rate } = e.data;
  try {
    const enc = new Mp3Encoder(1, rate, KBPS);
    const pcm = new Int16Array(audio.length);
    for (let i = 0; i < audio.length; i++) pcm[i] = Math.max(-1, Math.min(1, audio[i])) * 0x7fff;
    const parts: Uint8Array[] = [];
    for (let i = 0; i < pcm.length; i += 1152) parts.push(enc.encodeBuffer(pcm.subarray(i, i + 1152)));
    parts.push(enc.flush());
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    scope.postMessage({ id, mp3: out }, [out.buffer]);
  } catch (err) {
    scope.postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
