import { modelOfVoice } from '../speech/files.ts';
import type { Model } from './scheduler.ts';

/*
 * The engine's models, and what a worker holding one uses. Measured 2026-11-07 (ADR 0002), native
 * ONNX Runtime with its memory arena, after a few runs: a Piper voice (medium) 0.23 GB, the panel
 * model 0.47 GB. Rounded up. (The heavy voices, Kokoro, run on devices only.)
 */

export const PANELS = 'panels';

/** A voice's model, by the voice's key (piper:kristin…). */
export function voiceModel(voice: string): Model {
  const key = modelOfVoice(voice);
  return { key, mb: 250 };
}

export const panelModel: Model = { key: PANELS, mb: 500 };
