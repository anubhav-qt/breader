import { useSyncExternalStore } from 'react';
import type { ListedVoice } from '@breader/shared/protocol';
import manifest from './files.json';
import { hosted, uploaded, type HostedName, type Want } from './store';

/*
 * The voices that read aloud. Each engine has five built in, hosted with the app, plus any voices
 * readers uploaded (data from GET /v1/voices):
 *
 *   Normal     Piper voices, about 64 MB each, on the CPU. Trained on public-domain or CC-licensed
 *              recordings (rhasspy/piper-voices).
 *   Heavy      Kokoro-82M voices (Apache 2.0), one 326 MB model for all of them, on the GPU. It
 *              has to be full precision: the fp16 and q4f16 models only give NaNs on WebGPU.
 *
 * Normal mode reads with Normal voices; Immersive with either (prefs.ts).
 */

export type Mode = 'normal' | 'immersive';
export type Engine = 'piper' | 'kokoro';
export const engineOf = (m: Mode): Engine => (m === 'normal' ? 'piper' : 'kokoro');

export interface VoiceInfo {
  /** piper:kristin, kokoro:af_heart, or user:<id> for uploaded ones. */
  key: string;
  engine: Engine;
  name: string;
  /** US, UK… */
  accent: string;
  /** Short lines in this voice: a bundled clip of each part of the sample, or an uploaded sample's file id. */
  sample?: { parts: Record<SamplePart, string> } | { fileId: string };
  /** Kokoro only: says words the British way. */
  british?: boolean;
  /** Uploaded voices. */
  upload?: ListedVoice;
}

/**
 * What each voice's sample says, in three parts to hear one at a time: a greeting, a line of a
 * story, and a question, so its tone, its pace and how it rises and falls can all be heard before
 * picking it.
 */
export type SamplePart = 'greeting' | 'narration' | 'question';
export const SAMPLE_PARTS: SamplePart[] = ['greeting', 'narration', 'question'];
export const SAMPLES: Record<SamplePart, string> = {
  greeting: "Hello, I'll be reading to you today.",
  narration: 'It was the best of times, it was the worst of times, it was the age of wisdom, it was the age of foolishness.',
  question: 'Shall we turn the page, and see what happens next?',
};
/** An uploaded voice keeps one sample: all three in a row. */
export const SAMPLE_LINE = SAMPLE_PARTS.map((p) => SAMPLES[p]).join(' ');

const clip = (key: string) => ({
  parts: Object.fromEntries(SAMPLE_PARTS.map((p) => [p, `/voices/${key.replace(':', '-')}-${p}.m4a`])) as Record<SamplePart, string>,
});

const piper = (id: string, name: string, accent: string): VoiceInfo => ({ key: `piper:${id}`, engine: 'piper', name, accent, sample: clip(`piper:${id}`) });
const kokoro = (id: string, name: string, accent: string): VoiceInfo => ({ key: `kokoro:${id}`, engine: 'kokoro', name, accent, british: accent === 'UK', sample: clip(`kokoro:${id}`) });

export const BUILT_IN: Record<Mode, VoiceInfo[]> = {
  normal: [
    piper('kristin', 'Kristin', 'US'),
    piper('norman', 'Norman', 'US'),
    piper('cori', 'Cori', 'UK'),
    piper('northern', 'Northern', 'UK'),
    piper('ljspeech', 'Linda', 'US'),
  ],
  immersive: [
    kokoro('af_heart', 'Heart', 'US'),
    kokoro('am_michael', 'Michael', 'US'),
    kokoro('bf_emma', 'Emma', 'UK'),
    kokoro('bm_george', 'George', 'UK'),
    kokoro('af_bella', 'Bella', 'US'),
  ],
};

export const DEFAULT_VOICE: Record<Mode, string> = { normal: 'piper:kristin', immersive: 'kokoro:af_heart' };

/** US for American English, UK for the rest of the English eSpeak knows. */
export const accentOf = (lang: string) => (lang.toLowerCase().startsWith('en-us') ? 'US' : 'UK');

export function fromListed(v: ListedVoice): VoiceInfo {
  return {
    key: `user:${v.id}`,
    engine: v.engine,
    name: v.name,
    accent: accentOf(v.lang),
    british: v.engine === 'kokoro' && accentOf(v.lang) === 'UK',
    sample: v.sampleId ? { fileId: v.sampleId } : undefined,
    upload: v,
  };
}

/** What a voice needs besides its engine: Piper's model and settings, or a Kokoro pack. */
export function filesOf(v: VoiceInfo): { model?: Want; config?: Want; pack?: Want } {
  const id = v.key.split(':')[1];
  if (v.upload) {
    const u = v.upload;
    return v.engine === 'kokoro'
      ? { pack: uploaded(u.fileId, u.fileSize) }
      : { model: uploaded(u.fileId, u.fileSize), config: uploaded(u.configId!, 5_000) };
  }
  return v.engine === 'kokoro'
    ? { pack: hosted(`kokoro-${id}` as HostedName) }
    : { model: hosted(`piper-${id}` as HostedName), config: hosted(`piper-${id}-config` as HostedName) };
}

/** The engine's own files: its runtime, and Kokoro's model. */
export const engineFiles = (e: Engine): Want[] => (e === 'kokoro' ? [hosted('ort-gpu'), hosted('kokoro')] : [hosted('ort-cpu')]);

type Files = typeof manifest.files;
/** Bytes a download of these files weighs over the network. */
export function weight(wants: Want[]) {
  const files = manifest.files as Files;
  return wants.reduce((n, w) => n + ((files[w.name as keyof Files] as { transfer?: number } | undefined)?.transfer ?? w.size), 0);
}

/*
 * Can this browser run Immersive voices? Having WebGPU isn't enough: some browsers have it but no
 * graphics chip to lend it (the iOS Simulator, older phones, a blocklisted driver), so it's asked
 * for one. Null until then.
 */
type Gpu = { requestAdapter: () => Promise<unknown> };
let gpu: boolean | null = typeof navigator !== 'undefined' && 'gpu' in navigator ? null : false;
let asking: Promise<boolean> | null = null;
const gpuSubs = new Set<() => void>();
const setGpu = (v: boolean) => { gpu = v; gpuSubs.forEach((f) => f()); };

export function checkGpu(): Promise<boolean> {
  if (gpu !== null) return Promise.resolve(gpu);
  asking ??= (navigator as Navigator & { gpu: Gpu }).gpu.requestAdapter().then((a) => !!a, () => false).then((ok) => { setGpu(ok); return ok; });
  return asking;
}
/** False once this browser is known not to run them; true until then. */
export const hasGpu = () => gpu !== false;
/** Immersive failed to start on this device's graphics: read with Normal's voices from now on. */
export const noGpu = () => setGpu(false);
export const useGpu = () => useSyncExternalStore((f) => { gpuSubs.add(f); return () => { gpuSubs.delete(f); }; }, () => gpu);
