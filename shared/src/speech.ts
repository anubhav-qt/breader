import { initSync, Model } from 'phonon-tts/raw';

/*
 * Phonon, the one voice model (ADR 0005): phonon-tts's WebAssembly build, on the CPU, one thread.
 * The same code reads in the reader's worker (frontend voice/tts.worker.ts) and in the ThinkPad's
 * engine (server engine/worker.ts), so both say a sentence alike. Phonon cleans up the text itself
 * (numbers, money, titles), as English.
 */

/** Phonon's sound comes at this many samples a second. */
export const PHONON_RATE = 24_000;

/** How freely it reads, and its seed: the same as Phonon's own packages, so a line always sounds the same. */
const TEMPERATURE = 0.3;
const SEED = 4242424242424242n;

/** What Phonon needs to start: the runtime, the model, and the model's tokenizer and settings. */
export interface PhononFiles {
  wasm: Uint8Array;
  model: Uint8Array;
  tokenizer: Uint8Array;
  config: Uint8Array;
}

export class Phonon {
  /** Each voice loaded, by its key, as the model numbers it. */
  private voices = new Map<string, number>();
  private model: Model;

  private constructor(model: Model) {
    this.model = model;
  }

  /** Starts the runtime (once in this worker) and loads the model. */
  static async load(files: PhononFiles): Promise<Phonon> {
    initSync({ module: files.wasm });
    const model = await Model.load(files.model, files.tokenizer, files.config, 'q8', 'en', 'default', null, 'cpu');
    return new Phonon(model);
  }

  hasVoice(key: string): boolean {
    return this.voices.has(key);
  }

  /** Loads a voice from its file (a .safetensors of the voice catalogue). */
  addVoice(key: string, file: Uint8Array) {
    if (this.voices.has(key)) return;
    this.voices.set(key, this.model.add_voice(file));
  }

  /** `text` in the voice `key`, as mono samples at PHONON_RATE. */
  async say(key: string, text: string): Promise<Float32Array> {
    const voice = this.voices.get(key);
    if (voice === undefined) throw new Error('That voice isn’t loaded.');
    this.model.start_generation(voice, text, TEMPERATURE, SEED);
    const frames: Float32Array[] = [];
    let length = 0;
    try {
      while (this.model.next_chunk() !== undefined) {
        for (;;) {
          const frame = (await this.model.generation_step()) as Float32Array | undefined;
          if (frame === undefined) break;
          frames.push(frame);
          length += frame.length;
        }
      }
    } finally {
      this.stop();
    }
    const out = new Float32Array(length);
    let at = 0;
    for (const f of frames) {
      out.set(f, at);
      at += f.length;
    }
    return out;
  }

  /** Ends a sentence, done or failed, so the next one starts clean (as phonon-tts's own worker does). */
  private stop() {
    try {
      this.model.stop_generation();
    } catch {
      // After a WebAssembly trap every call on the model throws; the first error is the one to keep.
    }
  }
}
