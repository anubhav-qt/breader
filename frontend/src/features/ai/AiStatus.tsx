import { type CSSProperties } from 'react';
import { CHECK } from '../reader/chrome/icons';
import { DotIcon, Typed } from '../reader/chrome/parts';
import { colorVars } from '../../data/colors';
import { useRound, type AiDesign } from '../design/round';
import { FEATURE, FEATURE_ICON, SPARK, SPARK_DIM } from './glyphs';
import { FEATURES, PHASES, useAiProgress, type AiFeature, type AiProgress } from './progress';
import { OFFER, phaseState, sentence, stageText, STATE_WORD, STEPS, stepText } from './words';
import './ai.css';

/*
 * The AI's progress for one book, drawn the way each design of this round draws it (design/round.ts):
 *
 *   A Unlocks    what it unlocks as four tiles, each saying whether it's ready
 *   B Dot meter  one row of square dots across its four passes, like the book's progress
 *   C Glyph      a spark that beats while it reads and lights in the book's colour when done
 *   D Steps      its passes as a list of steps, ticked off as they finish
 *   E Note       a sentence or two, typed in, saying where it is and what comes next
 */

/** The spark: beating while it reads or waits, lit when done, faint while off. */
export function Spark({ p, className = '' }: { p: AiProgress; className?: string }) {
  return (
    <span className={`ai-spark is-${p.stage} ${className}`} aria-hidden="true">
      <span className="ai-spark-a"><DotIcon rows={SPARK} /></span>
      <span className="ai-spark-b"><DotIcon rows={SPARK_DIM} /></span>
    </span>
  );
}

/** A: what it unlocks, one tile each, with where each one is. */
export function Tiles({ p, compact = false }: { p: AiProgress; compact?: boolean }) {
  return (
    <ul className={`ai-tiles${compact ? ' is-compact' : ''}`}>
      {FEATURES.map((f) => {
        const state = p.stage === 'off' ? 'off' : p.features[f];
        let word = 'Unlocks';
        if (state !== 'off') word = STATE_WORD[state];
        return (
          <li key={f} className={`ai-tile is-${state}`}>
            <span className="ai-tile-i"><DotIcon rows={FEATURE_ICON[f]} /></span>
            <span className="ai-tile-t">
              <b>{FEATURE[f].name}</b>
              {!compact && <span className="ai-tile-a">{FEATURE[f].about}</span>}
            </span>
            <span className="ai-tile-s">{state === 'ready' && <DotIcon rows={CHECK} />}{word}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** How many dots each pass gets in the meter, by how long it takes. */
const METER: Record<string, number> = { cast: 3, marks: 12, music: 6, notes: 7 };
const METER_DOTS = 28;
const METER_NAMES: Record<string, string> = { cast: 'Cast', marks: 'Voices', music: 'Music', notes: 'Notes' };

/** B: one row of dots over its four passes, lit as far as it's got, the dot it's on blinking. */
export function Meter({ p, labels = true }: { p: AiProgress; labels?: boolean }) {
  let lit = 0;
  if (p.stage === 'done') lit = METER_DOTS;
  else if (p.stage === 'working') lit = Math.floor(((p.percent ?? 0) / 100) * METER_DOTS);
  const working = p.stage === 'working';
  const dots: Array<{ k: number; phase: string; first: boolean }> = [];
  for (const phase of PHASES) {
    for (let i = 0; i < METER[phase]; i++) dots.push({ k: dots.length, phase, first: i === 0 && phase !== 'cast' });
  }
  // Each name under its pass's dots, and never narrower than itself.
  const columns = PHASES.map((ph) => `minmax(max-content, ${METER[ph]}fr)`).join(' ');
  return (
    <div className={`ai-meter is-${p.stage}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={p.percent ?? 0} aria-label="How far the AI has read">
      <span className="ai-meter-dots" aria-hidden="true">
        {dots.map((d) => {
          let cls = '';
          if (d.k < lit) cls = 'is-read';
          else if (d.k === lit && working) cls = 'is-now';
          if (d.first) cls += ' is-split';
          return <i key={d.k} className={cls} />;
        })}
      </span>
      {labels && (
        <span className="ai-meter-names" style={{ gridTemplateColumns: columns } as CSSProperties} aria-hidden="true">
          {PHASES.map((ph) => <span key={ph} className={`is-${phaseState(p, ph)}`}>{METER_NAMES[ph]}</span>)}
        </span>
      )}
    </div>
  );
}

/** D: the passes as steps, each with what it unlocks; the one it's on says how far. */
export function Steps({ p }: { p: AiProgress }) {
  return (
    <ol className="ai-steps">
      {STEPS.map((s, i) => {
        const state = phaseState(p, s.phase);
        let mark = <span className="ai-step-n">{i + 1}</span>;
        if (state === 'ready') mark = <span className="ai-step-n"><DotIcon rows={CHECK} /></span>;
        return (
          <li key={s.phase} className={`ai-step is-${state}`}>
            {mark}
            <span className="ai-step-t">
              <b>{s.name}</b>
              {state === 'making' && p.step && <span className="ai-step-now">{stepText(p)}</span>}
              {s.unlocks.length > 0 && (
                <span className="ai-step-u">
                  {s.unlocks.map((f) => (
                    <span key={f} className={`ai-chip is-${p.stage === 'off' ? 'off' : p.features[f]}`}>
                      <DotIcon rows={FEATURE_ICON[f]} />
                      {FEATURE[f].name}
                    </span>
                  ))}
                </span>
              )}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** E: a sentence or two, typed in afresh whenever it changes. */
export function Note({ p }: { p: AiProgress }) {
  return <p className="ai-note"><Typed text={sentence(p)} /></p>;
}

/** Where it is, in a word or two, with the spark: the line above the bigger designs. */
export function StageLine({ p }: { p: AiProgress }) {
  return (
    <span className={`ai-stage is-${p.stage}`}>
      <Spark p={p} />
      <span>{stageText(p)}</span>
    </span>
  );
}

/** The whole status, as the design picked draws it. `compact`: the reader's sheet, with less room. */
export function Status({ p, design, compact = false }: { p: AiProgress; design: AiDesign; compact?: boolean }) {
  if (design === 'A') {
    return (
      <div className="ai-status">
        {p.stage !== 'off' && <StageLine p={p} />}
        <Tiles p={p} compact={compact} />
      </div>
    );
  }
  if (design === 'B') {
    return (
      <div className="ai-status">
        <StageLine p={p} />
        <Meter p={p} />
        {p.stage === 'working' && <span className="ai-sub">{stepText(p)}</span>}
      </div>
    );
  }
  if (design === 'C') {
    return (
      <div className="ai-status">
        <StageLine p={p} />
        <ul className="ai-list">
          {FEATURES.map((f) => <FeatureRow key={f} f={f} p={p} />)}
        </ul>
      </div>
    );
  }
  if (design === 'D') {
    return (
      <div className="ai-status">
        <StageLine p={p} />
        <Steps p={p} />
      </div>
    );
  }
  return (
    <div className="ai-status">
      <Note p={p} />
    </div>
  );
}

function FeatureRow({ f, p }: { f: AiFeature; p: AiProgress }) {
  const state = p.stage === 'off' ? 'off' : p.features[f];
  let word = 'Off';
  if (state !== 'off') word = STATE_WORD[state];
  return (
    <li className={`ai-row is-${state}`}>
      <DotIcon rows={FEATURE_ICON[f]} />
      <span>{FEATURE[f].name}</span>
      <em>{word}</em>
    </li>
  );
}

/**
 * The AI switch where a book is added or edited, with what it unlocks drawn by the design picked,
 * and once on, how far it's got. `locked`: on for good, as an edited book's is once said yes to.
 */
export function AiSwitch({ id, label, why, on, locked = false, p, style, compact = false, onChange }: {
  id: string;
  /** The reader's sheet, with less room. */
  compact?: boolean;
  style?: CSSProperties;
  label: string;
  why: string;
  on: boolean;
  locked?: boolean;
  /** A book already in the library: its progress, asked again while this shows. Adding one has none. */
  p?: AiProgress;
  onChange: (on: boolean) => void;
}) {
  const { ai } = useRound();
  const shown: AiProgress = p ?? { stage: 'off', features: { two: 'waiting', cast: 'waiting', music: 'waiting', revisit: 'waiting' } };
  const offer = !on || !p;
  return (
    <div className={`ai ai-switch is-${ai}${on ? ' is-on' : ''}`} style={style}>
      <div className="ai-head">
        {ai === 'C' && <Spark p={on ? shown : { ...shown, stage: 'off' }} className="is-big" />}
        <span className="ai-label" id={`${id}-l`}>{label}</span>
        <button type="button" className="switch" role="switch" aria-checked={on} aria-labelledby={`${id}-l`} aria-describedby={`${id}-why`} disabled={locked} onClick={() => onChange(!on)} />
      </div>
      {offer ? <Offer design={ai} on={on} compact={compact} /> : <Status p={shown} design={ai} compact={compact} />}
      <p className="ai-why" id={`${id}-why`}>{why}</p>
    </div>
  );
}

/** A book in the library: its switch, on for good once said yes to, and its progress, asked again while it shows. */
export function BookAiSwitch({ bookId, color, on, label, why, onTurnOn }: {
  bookId: string;
  color: string;
  on: boolean;
  label: string;
  why: string;
  onTurnOn: () => void;
}) {
  const p = useAiProgress(bookId, on);
  return <AiSwitch id="ep-ai" label={label} why={why} on={on} locked={on} p={p} style={colorVars(color)} onChange={onTurnOn} />;
}

/** What it unlocks, before it's on: the same parts each design shows once it is, all still to come. */
function Offer({ design, on, compact = false }: { design: AiDesign; on: boolean; compact?: boolean }) {
  const none: AiProgress = { stage: 'off', features: { two: 'waiting', cast: 'waiting', music: 'waiting', revisit: 'waiting' } };
  if (design === 'A') return <Tiles p={none} compact={compact} />;
  if (design === 'B') {
    return (
      <div className="ai-status">
        <Meter p={none} />
        <span className="ai-sub">{on ? 'Joins the line once it’s added' : 'Four things this unlocks, made one after another'}</span>
      </div>
    );
  }
  if (design === 'C') return <p className="ai-offer">Unlocks 2 voices, character voices, music and Revisit for this book.</p>;
  if (design === 'D') return <Steps p={none} />;
  return <p className="ai-note">{OFFER}</p>;
}

/** B, up top in the reader: the meter, small, with how far. */
function MiniMeter({ p }: { p: AiProgress }) {
  let lit = 0;
  if (p.stage === 'done') lit = MINI_DOTS;
  else if (p.stage === 'working') lit = Math.floor(((p.percent ?? 0) / 100) * MINI_DOTS);
  return (
    <span className={`ai-mini is-${p.stage}`} aria-hidden="true">
      {Array.from({ length: MINI_DOTS }, (_, k) => {
        let cls = '';
        if (k < lit) cls = 'is-read';
        else if (k === lit && p.stage === 'working') cls = 'is-now';
        return <i key={k} className={cls} />;
      })}
    </span>
  );
}
const MINI_DOTS = 10;

/**
 * Up top in the reader, for a book an AI reads along with: the spark (C) or the small meter (B),
 * opening how far it's got. The other designs keep it in the voice sheet.
 */
export function AiHeadButton({ p, open, onClick }: { p: AiProgress; open: boolean; onClick: () => void }) {
  const { ai } = useRound();
  if (p.stage === 'off') return null;
  if (ai !== 'B' && ai !== 'C') return null;
  return (
    <button
      type="button"
      className={`i3-side i3-icon i3-ai is-${ai}${open ? ' is-open' : ''}`}
      onClick={onClick}
      aria-label={`AI reading along: ${stageText(p)}`}
      aria-expanded={open}
      aria-haspopup="dialog"
      data-tip={`AI reading along · ${stageText(p)}`}
    >
      {ai === 'C' ? <Spark p={p} /> : <MiniMeter p={p} />}
    </button>
  );
}

/** The drop from that button: the whole status, as the design draws it. */
export function AiPanel({ p }: { p: AiProgress }) {
  const { ai } = useRound();
  return (
    <div className="pnl ai-pnl">
      <div className="pnl-h">AI reading along</div>
      <Status p={p} design={ai} />
      <p className="p-note ai-pnl-note">Each part turns on here by itself as soon as it’s made.</p>
    </div>
  );
}

/** At the top of the voice sheet: what an AI reading along gives this book, and how far it's got. */
export function SheetAi({ p, onAi }: { p: AiProgress; onAi?: (on: boolean) => void }) {
  const on = p.stage !== 'off';
  if (!on && !onAi) return null;
  let why = 'It never keeps your book or learns from it. Once on, it stays on, for everyone who has this book.';
  if (on) why = 'Each part turns on here by itself as soon as it’s made.';
  return (
    <div className="ai-sheet">
      <AiSwitch id="vs-ai" label="AI reading along" why={why} on={on} locked={on} p={on ? p : undefined} compact onChange={(v) => onAi?.(v)} />
    </div>
  );
}
