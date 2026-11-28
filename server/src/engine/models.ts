import { SPEECH_MODEL } from '../speech/files.ts';
import type { Model } from './scheduler.ts';

/*
 * The engine's models, and what a worker holding one uses. The panel model measured 2026-11-07
 * (ADR 0002), native ONNX Runtime with its memory arena, after a few runs: 0.47 GB. Phonon, the
 * voice model (ADR 0005), held its whole process at about 380 MB on an M-series Mac with a voice
 * loaded and read (2026-11-28); each voice it holds adds a quarter of a megabyte. Rounded up.
 */

export const PANELS = 'panels';

/** The voices' model: one for all of them. */
export const voiceModel: Model = { key: SPEECH_MODEL, mb: 400 };

export const panelModel: Model = { key: PANELS, mb: 500 };
