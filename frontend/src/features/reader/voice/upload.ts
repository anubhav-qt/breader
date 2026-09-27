import JSZip from 'jszip';
import { KOKORO_PACK_BYTES, LIMITS } from '@breader/shared/limits';
import { storeFile } from '../../../data/sync';
import { checkGpu, fromListed, SAMPLE_LINE, type Engine } from './catalog';
import { putVoice } from './list';
import { drop, failed, missing, synth, wav } from './speaker';
import { forget, keep, uploaded } from './store';
import type { PiperConfig } from './tts.worker';

/*
 * Adding a voice: Piper's model and its .onnx.json for Normal, or a Kokoro pack (a .bin, or the
 * .pt PyTorch saves) for Immersive. It's tried on this device first, saying the sample line that
 * goes up with it, so a voice that can't speak never reaches the list.
 */

export type Accent = 'US' | 'UK';

export interface Draft {
  engine: Engine;
  /** Piper's model, or the pack as raw floats. */
  model: Uint8Array;
  /** Piper's settings. */
  config?: Uint8Array;
  name: string;
  accent: Accent;
  /** Piper's eSpeak voice: en-us, en-gb-x-rp… */
  espeak?: string;
}

const titled = (s: string) => s.replace(/[_-]+/g, ' ').trim().replace(/\b\p{Ll}/gu, (c) => c.toUpperCase()).slice(0, 60);
const bytesOf = async (f: Blob) => new Uint8Array(await f.arrayBuffer());

/** Reads the files picked for a voice, or says what's wrong with them. */
export async function readVoice(files: File[]): Promise<Draft> {
  const ending = (re: RegExp) => files.filter((f) => re.test(f.name.toLowerCase()));
  const onnx = ending(/\.onnx$/);
  const json = ending(/\.json$/);
  const packs = ending(/\.(bin|pt)$/);
  if (onnx.length) {
    if (onnx.length > 1 || json.length !== 1) throw new Error('A Piper voice is two files, its .onnx and its .onnx.json. Pick both.');
    const [m, c] = [onnx[0], json[0]];
    if (m.size > LIMITS.key.fileBytes) throw new Error('That model is too big to upload.');
    if (c.size > LIMITS.voiceSideBytes) throw new Error('That .json is too big to be a voice’s settings.');
    const config = await bytesOf(c);
    let cfg: Partial<PiperConfig> & { language?: { code?: string }; dataset?: string };
    try {
      cfg = JSON.parse(new TextDecoder().decode(config));
    } catch {
      throw new Error('That .json can’t be read.');
    }
    if (!cfg.phoneme_id_map || !cfg.audio?.sample_rate) throw new Error('That .json isn’t a Piper voice’s settings.');
    const espeak = (cfg.espeak?.voice || 'en-us').toLowerCase();
    if (!/^en(-[a-z0-9]{1,12}){0,3}$/.test(espeak)) throw new Error('Only English voices can read aloud for now.');
    const us = espeak.startsWith('en-us') || /_us$/i.test(cfg.language?.code ?? '');
    // en_US-kristin-medium.onnx: the name is in the middle.
    const parts = m.name.replace(/\.onnx$/i, '').split('-');
    const name = cfg.dataset || (parts.length >= 3 ? parts.slice(1, -1).join(' ') : parts.join(' '));
    return { engine: 'piper', model: await bytesOf(m), config, name: titled(name), accent: us ? 'US' : 'UK', espeak };
  }
  if (packs.length === 1 && !json.length) {
    const f = packs[0];
    let model = await bytesOf(f);
    if (f.name.toLowerCase().endsWith('.pt')) {
      // PyTorch's file is a zip, and the numbers are its data/0.
      const zip = await JSZip.loadAsync(model).catch(() => null);
      const data = zip && Object.values(zip.files).find((z) => /(^|\/)data\/0$/.test(z.name));
      if (!data) throw new Error('That .pt isn’t a Kokoro voice pack.');
      model = await data.async('uint8array');
    }
    if (model.byteLength !== KOKORO_PACK_BYTES) throw new Error('That isn’t a Kokoro voice pack, which holds 510 × 256 numbers.');
    // af_nicole.pt: a for American or b for British, f or m, then the name.
    const m = f.name.match(/^([ab])[fm]_(.+)\.(bin|pt)$/i);
    return { engine: 'kokoro', model, name: titled(m ? m[2] : f.name.replace(/\.(bin|pt)$/i, '')), accent: m?.[1].toLowerCase() === 'b' ? 'UK' : 'US' };
  }
  throw new Error('Pick a Piper voice (its .onnx and .onnx.json) or one Kokoro pack (.bin or .pt).');
}

export type Step = 'trying' | 'uploading';

/**
 * Tries the voice, uploads it with its sample line and lists it as this library's. Returns its
 * key. A Kokoro pack is only tried where Immersive already runs; elsewhere it goes up without a
 * sample.
 */
export async function uploadVoice(d: Draft, as: { name: string; accent: Accent; open: boolean }, onStep: (s: Step) => void): Promise<string> {
  const lang = as.accent === 'US' ? 'en-us' : d.espeak && !d.espeak.startsWith('en-us') ? d.espeak : 'en-gb';
  const base = { name: as.name.trim().slice(0, 60) || 'My voice', engine: d.engine, lang, public: as.open, addedAt: Date.now(), fileSize: d.model.byteLength, mine: true, words: 0 };

  onStep('trying');
  const tmp = `try-${crypto.randomUUID()}`;
  const trial = fromListed({ ...base, id: tmp, fileId: tmp, configId: d.config ? `${tmp}-c` : null, sampleId: null });
  const files = [uploaded(tmp, d.model.byteLength), ...(d.config ? [uploaded(`${tmp}-c`, d.config.byteLength)] : [])];
  await keep(files[0], d.model);
  if (d.config) await keep(files[1], d.config);
  let sample: Blob | null = null;
  try {
    if (d.engine === 'piper' || ((await checkGpu()) && (await missing(trial)).bytes === 0)) {
      const clip = await synth(trial, SAMPLE_LINE, 1);
      if (!clip.audio.length || clip.audio.some((x) => Number.isNaN(x))) throw new Error('it made no sound');
      sample = wav(clip.audio, clip.rate);
    }
  } catch (e) {
    failed(null);
    throw new Error(`This voice couldn’t speak on this device (${e instanceof Error ? e.message : e}).`);
  } finally {
    await drop(trial);
    for (const w of files) await forget(w);
  }

  onStep('uploading');
  const fileId = await storeFile(new Blob([d.model as Uint8Array<ArrayBuffer>]), 'application/octet-stream', 'voice');
  const configId = d.config ? await storeFile(new Blob([d.config as Uint8Array<ArrayBuffer>]), 'application/json', 'voice') : null;
  const sampleId = sample ? await storeFile(sample, 'audio/wav', 'sample') : null;
  await keep(uploaded(fileId, d.model.byteLength), d.model);
  if (configId && d.config) await keep(uploaded(configId, d.config.byteLength), d.config);
  const id = crypto.randomUUID();
  putVoice({ ...base, id, fileId, configId, sampleId });
  return `user:${id}`;
}
