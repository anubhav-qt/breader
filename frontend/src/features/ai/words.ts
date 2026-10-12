import { FEATURE } from './glyphs';
import { FEATURES, inLine, PHASES, type AiFeature, type AiPhase, type AiProgress, type FeatureState } from './progress';

/*
 * What the AI's progress says, in words, wherever it shows: one line for where it is, and for the
 * plainer designs, a sentence or two.
 */

/** Where it is, in a few words: off, in line, reading (how far), or done. */
export function stageText(p: AiProgress): string {
  if (p.stage === 'off') return 'Off';
  if (p.stage === 'queued') return inLine(p);
  if (p.stage === 'done') return 'All ready';
  return `Reading it · ${p.percent ?? 0}%`;
}

/** The step it's on, with how many parts are done when it goes part by part. */
export function stepText(p: AiProgress): string {
  if (!p.step) return '';
  if (!p.of) return p.step;
  return `${p.step}, ${p.parts ?? 0} of ${p.of}`;
}

/** Names joined as said: "a", "a and b", "a, b and c". */
export function joined(names: string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function named(features: AiFeature[], lower: boolean): string[] {
  return features.map((f, i) => {
    const name = FEATURE[f].name;
    if (!lower || i === 0 || f === 'revisit') return name;
    return name.toLowerCase();
  });
}

export function featuresIn(p: AiProgress, state: FeatureState): AiFeature[] {
  return FEATURES.filter((f) => p.features[f] === state);
}

/** What it would do, for a book whose switch is off. */
export const OFFER = '2 voices, character voices, music and Revisit.';

/** Where it is and what's coming, as a person would say it. */
export function sentence(p: AiProgress): string {
  if (p.stage === 'off') return OFFER;
  if (p.stage === 'done') return `All read. ${joined(named(FEATURES, true))} are ready.`;
  if (p.stage === 'queued') {
    const before = p.ahead && p.ahead > 1 ? `${p.ahead} books before it` : 'next';
    return `In line, ${before}.`;
  }
  const ready = featuresIn(p, 'ready');
  const making = featuresIn(p, 'making');
  let out = `Reading it now: ${stepText(p).toLowerCase()}.`;
  if (ready.length) out += ` ${readyText(ready)}.`;
  if (making.length) out += ` ${joined(named(making, true))} next.`;
  return out;
}

/** A pass's place: done, being made, or still to come. */
export function phaseState(p: AiProgress, phase: AiPhase): FeatureState {
  if (p.stage === 'done') return 'ready';
  if (p.stage !== 'working' || !p.phase) return 'waiting';
  const at = PHASES.indexOf(p.phase);
  const i = PHASES.indexOf(phase);
  if (i < at) return 'ready';
  if (i === at) return 'making';
  return 'waiting';
}

/** Each pass as a step: what it does, and what it unlocks. */
export const STEPS: Array<{ phase: AiPhase; name: string; unlocks: AiFeature[] }> = [
  { phase: 'cast', name: 'Who’s in it', unlocks: [] },
  { phase: 'marks', name: 'Who says each line', unlocks: ['two', 'cast'] },
  { phase: 'music', name: 'The music for each scene', unlocks: ['music'] },
  { phase: 'notes', name: 'Notes on who’s who', unlocks: ['revisit'] },
];

export const STATE_WORD: Record<FeatureState, string> = { waiting: 'Waiting', making: 'Making', ready: 'Ready' };

/** Where it is, in one short line over the bottom of the reader (E). */
export function hintText(p: AiProgress): string {
  if (p.stage === 'queued') return `AI · ${inLine(p).toLowerCase()}`;
  if (p.stage === 'done') return 'AI · read it all, everything’s on';
  const ready = featuresIn(p, 'ready');
  let out = `AI · reading it, ${p.percent ?? 0}%`;
  if (ready.length) out += ` · ${joined(named(ready, true))} ready`;
  return out;
}

/** Parts that just became ready, as said over the bottom of the reader. */
export function readyText(features: AiFeature[]): string {
  let verb = 'is';
  if (features.length > 1 || features[0] === 'two' || features[0] === 'cast') verb = 'are';
  return `${joined(named(features, true))} ${verb} ready`;
}
