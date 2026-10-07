import { useEffect, useRef } from 'react';
import { PREVIEW_MODES, type PreviewMode } from '../data/library';
import { SWITCH_STYLES, type SwitchStyle } from './switchStyles';
import './preview-bar.css';

export type AppTheme = 'auto' | 'light' | 'dark';

interface Props {
  mode: PreviewMode;
  onMode: (m: PreviewMode) => void;
  theme: AppTheme;
  onTheme: (t: AppTheme) => void;
  /** The way between the reader's own library and the shared ones, to pick one. */
  switchLook: SwitchStyle;
  onSwitchLook: (s: SwitchStyle) => void;
  onReset: () => void;
}

/**
 * Development only: switch between real data and placeholder libraries, try the ways between the
 * libraries, and force a theme.
 */
export function PreviewBar({ mode, onMode, theme, onTheme, switchLook, onSwitchLook, onReset }: Props) {
  const bar = useRef<HTMLDivElement>(null);

  // Its height, so the bottom switch can sit above it rather than under it.
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
      {SWITCH_STYLES.map((s) => (
        <button key={s.id} type="button" aria-pressed={switchLook === s.id} onClick={() => onSwitchLook(s.id)}>
          {s.label}
        </button>
      ))}
      <span className="pv-sep" />
      {(['auto', 'light', 'dark'] as const).map((t) => (
        <button key={t} type="button" aria-pressed={theme === t} onClick={() => onTheme(t)}>
          {t}
        </button>
      ))}
      <span className="pv-sep" />
      <button type="button" onClick={onReset} title="Clear this browser's Breader data and reload">
        reset
      </button>
    </div>
  );
}
