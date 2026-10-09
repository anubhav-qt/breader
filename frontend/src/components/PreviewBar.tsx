import { useEffect, useRef } from 'react';
import { PREVIEW_MODES, type PreviewMode } from '../data/library';
import { FALLBACKS, type Fallback } from '../features/reader/steps';
import './preview-bar.css';

export type AppTheme = 'auto' | 'light' | 'dark';

interface Props {
  mode: PreviewMode;
  onMode: (m: PreviewMode) => void;
  theme: AppTheme;
  onTheme: (t: AppTheme) => void;
  /** A manga page held where no panel can be told apart (steps.ts). */
  held: Fallback;
  onHeld: (f: Fallback) => void;
  onReset: () => void;
}

/** Development only: switch between real data and placeholder libraries, force a theme, and try what a manga page held off its panels does. */
export function PreviewBar({ mode, onMode, theme, onTheme, held, onHeld, onReset }: Props) {
  const bar = useRef<HTMLDivElement>(null);

  // Its height, so the library switch on phones can sit above it rather than under it.
  useEffect(() => {
    const el = bar.current;
    if (!el) return;
    const root = document.documentElement;
    const keep = () => root.style.setProperty('--pv-room', `${el.offsetHeight + 12}px`);
    keep();
    const watch = new ResizeObserver(keep);
    watch.observe(el);
    return () => {
      watch.disconnect();
      root.style.removeProperty('--pv-room');
    };
  }, []);

  return (
    <div ref={bar} className="pv" role="group" aria-label="Preview controls">
      <span className="pv-tag">preview</span>
      {PREVIEW_MODES.map((m) => (
        <button key={m.id} type="button" aria-pressed={mode === m.id} onClick={() => onMode(m.id)}>
          {m.label}
        </button>
      ))}
      <span className="pv-sep" />
      {(['auto', 'light', 'dark'] as const).map((t) => (
        <button key={t} type="button" aria-pressed={theme === t} onClick={() => onTheme(t)}>
          {t}
        </button>
      ))}
      <span className="pv-sep" />
      <span className="pv-tag" title="A manga page held where no panel can be told apart">held</span>
      {FALLBACKS.map((f) => (
        <button key={f.v} type="button" aria-pressed={held === f.v} onClick={() => onHeld(f.v)}>
          {f.label}
        </button>
      ))}
      <span className="pv-sep" />
      <button type="button" onClick={onReset} title="Clear this browser's Breader data and reload">
        reset
      </button>
    </div>
  );
}
