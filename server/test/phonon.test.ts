import { describe, expect, it, vi } from 'vitest';

/** Phonon's runtime, faked: each sentence gives one frame, and one may fail part way. */
const calls: string[] = [];
let failNext = false;

vi.mock('phonon-tts/raw', () => {
  class Model {
    private chunks = 0;
    private steps = 0;
    static async load() {
      return new Model();
    }
    add_voice() {
      return 0;
    }
    start_generation() {
      calls.push('start');
      this.chunks = 1;
      this.steps = 1;
    }
    next_chunk() {
      if (this.chunks === 0) return undefined;
      this.chunks--;
      return 1;
    }
    async generation_step() {
      if (failNext) {
        failNext = false;
        throw new Error('The sentence broke.');
      }
      if (this.steps === 0) return undefined;
      this.steps--;
      return new Float32Array([0.5, 0.5]);
    }
    stop_generation() {
      calls.push('stop');
    }
  }
  return { initSync: () => {}, Model };
});

const { Phonon } = await import('@breader/shared/speech');
const none = new Uint8Array(0);

describe('Phonon', () => {
  it('ends each sentence, so the next starts clean, even one that failed', async () => {
    const phonon = await Phonon.load({ wasm: none, model: none, tokenizer: none, config: none });
    phonon.addVoice('phonon:everly', none);
    failNext = true;
    await expect(phonon.say('phonon:everly', 'One.')).rejects.toThrow('The sentence broke.');
    const said = await phonon.say('phonon:everly', 'Two.');
    expect(said).toEqual(new Float32Array([0.5, 0.5]));
    expect(calls).toEqual(['start', 'stop', 'start', 'stop']);
  });
});
