/// <reference lib="webworker" />
import { Phonon, PHONON_RATE } from '@breader/shared/speech';
import { load, type Want } from './store';

/*
 * Turns sentences into sound, off the page's thread, with Phonon (ADR 0005): one model for every
 * voice, on the CPU, one thread (more would need a cross-origin isolated page, which would break
 * covers and logins). Each voice is a small file loaded into it.
 *
 * The page sends requests with an id and gets one reply per id, plus progress while files load.
 */

export type Request =
  /** The runtime and the model: the page picks the runtime this browser can compile. */
  | { type: 'start'; files: { wasm: Want; model: Want; tokenizer: Want; config: Want } }
  /** Loads a voice's file. */
  | { type: 'voice'; key: string; file: Want }
  | { type: 'say'; key: string; text: string };

export type Reply =
  | { id: number; ok: true; audio?: Float32Array; rate?: number }
  | { id: number; ok: false; error: string }
  | { id: number; progress: { name: string; bytes: number } };

const scope = self as unknown as DedicatedWorkerGlobalScope;
let phonon: Phonon | null = null;

const post = (r: Reply, transfer: Transferable[] = []) => scope.postMessage(r, transfer);

async function fetchAll(id: number, wants: Want[]) {
  return Promise.all(wants.map((w) => load(w, (bytes) => post({ id, progress: { name: w.name, bytes } }))));
}

async function start(id: number, m: Extract<Request, { type: 'start' }>) {
  if (phonon) return;
  const f = m.files;
  const [wasm, model, tokenizer, config] = await fetchAll(id, [f.wasm, f.model, f.tokenizer, f.config]);
  phonon = await Phonon.load({ wasm, model, tokenizer, config });
}

async function loadVoice(id: number, m: Extract<Request, { type: 'voice' }>) {
  if (!phonon) throw new Error('The voice engine hasn’t started.');
  if (phonon.hasVoice(m.key)) return;
  const [file] = await fetchAll(id, [m.file]);
  phonon.addVoice(m.key, file);
}

async function say(m: Extract<Request, { type: 'say' }>) {
  if (!phonon) throw new Error('The voice engine hasn’t started.');
  return { audio: await phonon.say(m.key, m.text), rate: PHONON_RATE };
}

async function handle(m: Request & { id: number }) {
  try {
    if (m.type === 'start') {
      await start(m.id, m);
    } else if (m.type === 'voice') {
      await loadVoice(m.id, m);
    } else {
      const { audio, rate } = await say(m);
      post({ id: m.id, ok: true, audio, rate }, [audio.buffer]);
      return;
    }
    post({ id: m.id, ok: true });
  } catch (err) {
    post({ id: m.id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

// One request at a time: the model can't run twice at once.
let queue = Promise.resolve();
scope.onmessage = (e: MessageEvent<Request & { id: number }>) => {
  queue = queue.then(() => handle(e.data));
};
