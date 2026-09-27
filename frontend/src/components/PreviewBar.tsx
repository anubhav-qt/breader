import { PREVIEW_MODES, type PreviewMode } from '../data/library';
import { SERIES_LOOKS, type SeriesLook } from '../features/gallery/series';
import './preview-bar.css';

export type AppTheme = 'auto' | 'light' | 'dark';

interface Props {
  mode: PreviewMode;
  onMode: (m: PreviewMode) => void;
  theme: AppTheme;
  onTheme: (t: AppTheme) => void;
  series: SeriesLook;
  onSeries: (s: SeriesLook) => void;
  onReset: () => void;
}

/** Development only: switch between real data and placeholder libraries, force a theme, and try the series designs. */
export function PreviewBar({ mode, onMode, theme, onTheme, series, onSeries, onReset }: Props) {
  return (
    <div className="pv" role="group" aria-label="Preview controls">
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
      <span className="pv-tag">series</span>
      {SERIES_LOOKS.map((s) => (
        <button key={s} type="button" aria-pressed={series === s} onClick={() => onSeries(s)}>
          {s}
        </button>
      ))}
      <span className="pv-sep" />
      <button type="button" onClick={onReset} title="Clear this browser's Breader data and reload">
        reset
      </button>
    </div>
  );
}
