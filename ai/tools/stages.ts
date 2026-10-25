import { HARNESS_STAGES, stagePick, type Stage, type StagePick } from '../../shared/src/admin.ts';
import { control } from './control.ts';
import { current } from './jobs.ts';

/*
 * Who does each stage of the pipeline, as the admin page picked it (shared/src/admin.ts): NVIDIA
 * or Gemini, for one book or for books to come. A call says which stage it is by its label, the
 * one it's logged with (balancer.ts, harness.ts).
 */

/** The stage a call is, by its label. `redo`: a call on the first model only, marking parts again. */
export function stageOf(label: Record<string, unknown>, redo = false): Stage | null {
  if ('research' in label) return 'research';
  if ('soundtrack' in label) return 'music.gather';
  if ('music' in label) {
    const m = label.music;
    if (m === 'plan') return 'music.plan';
    if (typeof m === 'number') return 'music.score';
    return 'music.check';
  }
  if ('notes' in label) {
    const n = label.notes;
    if (n === 'roster' || n === 'roster-fix') return 'notes.roster';
    if (n === 'review') return 'notes.review';
    if (typeof n === 'number') return 'notes.write';
    return 'notes.check';
  }
  if (label.cast === 'pass') return 'marks.cast';
  if (label.cast === 'voices') return 'marks.voices';
  if ('settle' in label) return 'marks.settle';
  if (redo && ('part' in label || 'fix' in label)) return 'marks.redo';
  if ('fix' in label) return 'marks.check';
  if ('part' in label) return 'marks.mark';
  return null;
}

/** Who does this stage, for the book whose job this is: null for the usual. */
export function pickFor(stage: Stage | null): StagePick | null {
  if (!stage) return null;
  return stagePick(control, stage, current()?.id);
}

/** Whether a stage works with tools: Gemini's, unless the page says otherwise. */
export const usesTools = (stage: Stage) => HARNESS_STAGES.includes(stage);
