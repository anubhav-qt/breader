import { useState } from 'react';
import { AI_DESIGNS, CAST_DESIGNS, FAKES, NAMES, PLAY_DESIGNS, setRound, useRound, type Round } from './round';
import './design-bar.css';

const OPEN = 'breader.design-bar.open.v1';

/** What the fake states are called on the strip. */
const FAKE_NAMES: Record<Round['fake'], string> = {
  live: 'live',
  off: 'off',
  queued: 'in line',
  working: 'reading',
  ready: 'ready',
};

function readOpen(): boolean {
  try {
    return localStorage.getItem(OPEN) !== '0';
  } catch {
    return true;
  }
}

/** Development only: this round's designs, one row per feature, and the AI state to show. */
export function DesignBar() {
  const r = useRound();
  const [open, setOpen] = useState(readOpen);
  const toggle = () => {
    const next = !open;
    setOpen(next);
    try {
      localStorage.setItem(OPEN, next ? '1' : '0');
    } catch {
      /* this visit only */
    }
  };

  if (!open) {
    return (
      <button type="button" className="dz dz-tab" onClick={toggle} title="Show the design switches">
        design ▸
      </button>
    );
  }

  return (
    <div className="dz" role="group" aria-label="Design switches">
      <button type="button" className="dz-head" onClick={toggle} title="Hide">
        design ◂
      </button>
      <Row label="ai" name={NAMES.ai[r.ai]} options={AI_DESIGNS} value={r.ai} names={NAMES.ai} onPick={(ai) => setRound({ ai })} />
      <Row label="play" name={NAMES.play[r.play]} options={PLAY_DESIGNS} value={r.play} names={NAMES.play} onPick={(play) => setRound({ play })} />
      <Row label="cast" name={NAMES.cast[r.cast]} options={CAST_DESIGNS} value={r.cast} names={NAMES.cast} onPick={(cast) => setRound({ cast })} />
      <div className="dz-row">
        <span className="dz-l">ai state</span>
        <span className="dz-opts is-words">
          {FAKES.map((f) => (
            <button key={f} type="button" aria-pressed={r.fake === f} onClick={() => setRound({ fake: f })} title={f === 'live' ? 'What the server really says' : 'Pretend every book with its switch on is here'}>
              {FAKE_NAMES[f]}
            </button>
          ))}
        </span>
      </div>
    </div>
  );
}

function Row<T extends string>({ label, name, options, value, names, onPick }: {
  label: string;
  name: string;
  options: readonly T[];
  value: T;
  names: Record<T, string>;
  onPick: (v: T) => void;
}) {
  return (
    <div className="dz-row">
      <span className="dz-l">{label} <b>{name}</b></span>
      <span className="dz-opts">
        {options.map((o) => (
          <button key={o} type="button" aria-pressed={value === o} onClick={() => onPick(o)} title={names[o]}>
            {o}
          </button>
        ))}
      </span>
    </div>
  );
}
