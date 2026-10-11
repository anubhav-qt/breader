import { useSyncExternalStore } from 'react';
import type { ListedVoice } from '@breader/shared/protocol';
import manifest from '@breader/shared/voice-files.json';
import { VOICES, voicesOf, type BuiltInVoice } from '@breader/shared/voices';
import { hosted, uploaded, type HostedName, type Want } from './store';

/*
 * The voices that read aloud. Each engine has thirty built in, hosted with the app, plus any voices
 * readers uploaded (data from GET /v1/voices):
 *
 *   Normal     Piper voices on the CPU, trained on public-domain or CC-licensed recordings: sixteen
 *              of rhasspy/piper-voices' own, about 64 MB each, and fourteen speakers of one 77 MB
 *              model of LibriVox readers (agentvibes/piper-custom-voices), which they share.
 *   Heavy      Kokoro-82M voices (Apache 2.0), one 326 MB model for all of them, on the GPU. It
 *              has to be full precision: the fp16 and q4f16 models only give NaNs on WebGPU. Fifteen
 *              are its own, and fifteen are two of those blended half and half, as its users do.
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
  /** Kokoro only: the two voices it's a blend of, by name. */
  blend?: [string, string];
  /** A woman's voice or a man's, for 2 voices; neither for an upload not tagged either. */
  gender?: 'F' | 'M';
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

/** Kokoro blends, by their voice id: the two packs averaged, and how it says words. */
const mixes = manifest.mixes as Record<string, { of: string[]; british: boolean }>;
/** Speakers of one Piper model, by their voice id (voice-files.json). */
const speakers = manifest.speakers as Record<string, { model: string; id: number }>;

function builtIn(v: BuiltInVoice): VoiceInfo {
  const [engine, id] = v.key.split(':') as [Engine, string];
  const info: VoiceInfo = { key: v.key, engine, name: v.name, accent: v.accent, gender: v.gender, sample: clip(v.key) };
  if (engine === 'kokoro') info.british = v.accent === 'UK';
  const mix = mixes[id];
  if (mix) {
    const nameOf = (pack: string) => VOICES.find((x) => x.key === `kokoro:${pack}`)!.name;
    info.blend = [nameOf(mix.of[0]), nameOf(mix.of[1])];
  }
  return info;
}

/** Thirty of each, in the order shared/src/voices.ts has them. */
export const BUILT_IN: Record<Mode, VoiceInfo[]> = {
  normal: voicesOf('piper').map(builtIn),
  immersive: voicesOf('kokoro').map(builtIn),
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
    ...(v.gender === 'F' || v.gender === 'M' ? { gender: v.gender } : {}),
    sample: v.sampleId ? { fileId: v.sampleId } : undefined,
    upload: v,
  };
}

/**
 * What a voice needs besides its engine: Piper's model and settings, and which of the model's
 * speakers it is when it has several; or a Kokoro pack, and the second one a blend averages it with.
 */
export function filesOf(v: VoiceInfo): { model?: Want; config?: Want; speaker?: number; pack?: Want; mix?: Want } {
  const id = v.key.split(':')[1];
  if (v.upload) {
    const u = v.upload;
    return v.engine === 'kokoro'
      ? { pack: uploaded(u.fileId, u.fileSize) }
      : { model: uploaded(u.fileId, u.fileSize), config: uploaded(u.configId!, 5_000) };
  }
  if (v.engine === 'kokoro') {
    const mix = mixes[id];
    if (mix) return { pack: hosted(`kokoro-${mix.of[0]}` as HostedName), mix: hosted(`kokoro-${mix.of[1]}` as HostedName) };
    return { pack: hosted(`kokoro-${id}` as HostedName) };
  }
  const one = speakers[id];
  if (one) return { model: hosted(`piper-${one.model}` as HostedName), config: hosted(`piper-${one.model}-config` as HostedName), speaker: one.id };
  return { model: hosted(`piper-${id}` as HostedName), config: hosted(`piper-${id}-config` as HostedName) };
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
