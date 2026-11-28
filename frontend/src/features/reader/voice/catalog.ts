import manifest from '@breader/shared/voice-files.json';
import { VOICES, voiceFile, type BuiltInVoice } from '@breader/shared/voices';
import { hosted, type HostedName, type Want } from './store';

/*
 * The voices that read aloud: Phonon's (ADR 0005), one model for all of them, each voice a small
 * file of its own. The voice list shows the 25 readers; the 12 character voices (a wizard, an
 * ogre, a snow queen…) are for the cast alone, where the AI marker gives them to people they suit.
 */

/** How the page reads: plainly, or dimmed with the words lighting up (Immersive). The same voices either way. */
export type Mode = 'normal' | 'immersive';

/** The one voice model. Kept on cast picks and audiobooks, so a second model can join later. */
export type Engine = 'phonon';
export const ENGINE: Engine = 'phonon';

export interface VoiceInfo {
  /** phonon:everly */
  key: string;
  engine: Engine;
  name: string;
  /** US or UK; a character voice may have neither. */
  accent?: string;
  /** Short lines in this voice, a bundled clip of each part of the sample. */
  sample: { parts: Record<SamplePart, string> };
  /** A woman's voice or a man's, for 2 voices. */
  gender: 'F' | 'M';
  /** A character voice: in the cast, not in the voice list. */
  character?: true;
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

function clip(key: string) {
  const name = key.replace(':', '-');
  const parts = {} as Record<SamplePart, string>;
  for (const p of SAMPLE_PARTS) parts[p] = `/voices/${name}-${p}.m4a`;
  return { parts };
}

function builtIn(v: BuiltInVoice): VoiceInfo {
  const info: VoiceInfo = { key: v.key, engine: ENGINE, name: v.name, gender: v.gender, sample: clip(v.key) };
  if (v.accent) info.accent = v.accent;
  if (v.character) info.character = true;
  return info;
}

/** Every voice, readers first, in the order shared/src/voices.ts has them. */
export const BUILT_IN: VoiceInfo[] = VOICES.map(builtIn);

/** The voices readers pick from. */
export const READER_VOICES: VoiceInfo[] = BUILT_IN.filter((v) => !v.character);

export const DEFAULT_VOICE = 'phonon:everly';

/** A voice by its key, if it's still there. */
export const voiceByKey = (key: string) => BUILT_IN.find((v) => v.key === key);

/** A voice's own file. */
export function voiceWant(v: VoiceInfo): Want {
  const built = VOICES.find((x) => x.key === v.key)!;
  return hosted(voiceFile(built) as HostedName);
}

/**
 * The engine's own files: its runtime, the model, and the model's tokenizer and settings. The
 * runtime is phonon-tts's plain build: its Relaxed SIMD one was slower on an M-series Mac (5.7 times
 * faster than speech against 8.5, 2026-11-28), and Safari can't run it.
 */
export function engineFiles() {
  return { wasm: hosted('phonon-wasm'), model: hosted('phonon'), tokenizer: hosted('phonon-tokenizer'), config: hosted('phonon-config') };
}

type Files = typeof manifest.files;
/** Bytes a download of these files weighs over the network. */
export function weight(wants: Want[]) {
  const files = manifest.files as Files;
  let n = 0;
  for (const w of wants) {
    const f = files[w.name as keyof Files] as { transfer?: number } | undefined;
    n += f?.transfer ?? w.size;
  }
  return n;
}
