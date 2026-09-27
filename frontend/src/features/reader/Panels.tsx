import { useEffect, useRef, type CSSProperties } from 'react';
import type { LoadedBook, TocItem } from '../../books/types';
import { duration, minutesFor } from '../../lib/format';
import { IconCheck } from '../../components/icons';
import type { Loc } from './FlowView';
import { canFullscreen, useFullscreen } from './fullscreen';
import { canNarrate, RATES, setVoicePrefs, useVoicePrefs, useVoices } from './narration';
import { FONTS, MEASURES, SIZE_MAX, SIZE_MIN, SPACING, THEMES, type ReaderSettings, type StyleSettings } from './settings';

/* Contents */

interface ContentsProps {
  book: LoadedBook;
  title?: string;
  loc: Loc | null;
  canRemove: boolean;
  onGo: (item: TocItem) => void;
  onRemove: () => void;
}

export function ContentsPanel({ book, title, loc, canRemove, onGo, onRemove }: ContentsProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const items: TocItem[] = book.toc.length
    ? book.toc
    : book.kind === 'flow'
      ? book.sections.map((s, i) => ({ title: s.title, section: i, level: 0 }))
      : [];
  const section = loc?.section ?? 0;
  let current = -1;
  items.forEach((it, i) => { if (it.section <= section) current = i; });

  const minutes = (i: number) => {
    if (book.kind !== 'flow') return '';
    const from = items[i].section;
    const to = items.slice(i + 1).find((it) => it.section > from)?.section ?? book.sections.length;
    let w = 0;
    for (let s = from; s < to; s++) w += book.sections[s]?.words ?? 0;
    return w ? duration(minutesFor(w)) : '';
  };

  useEffect(() => {
    listRef.current?.querySelector('.p-item.is-now')?.scrollIntoView({ block: 'center' });
  }, []);

  const pct = Math.round((loc?.progress ?? 0) * 100);
  return (
    <div className="pnl">
      <div className="pnl-h">Contents</div>
      <div className="p-title">{title || book.title}</div>
      {book.author && <div className="p-auth">{book.author}</div>}
      <div className="p-bar"><i style={{ width: `${pct}%` }} /></div>
      <div className="p-meta">
        <span>{pct}%</span>
        <span>{loc ? (loc.bookWordsLeft ? `${duration(minutesFor(loc.bookWordsLeft))} left` : 'Finished') : ''}</span>
      </div>
      <div className="p-list" ref={listRef}>
        {items.length === 0 && <p className="p-empty">This book has no table of contents.</p>}
        {items.map((it, i) => {
          const state = i < current ? 'done' : i === current ? 'now' : 'next';
          return (
            <button
              key={`${it.section}-${it.anchor ?? ''}-${i}`}
              type="button"
              className={`p-item is-${state}`}
              style={{ paddingLeft: 10 + Math.min(it.level, 3) * 14, '--i': i } as CSSProperties}
              onClick={() => onGo(it)}
            >
              <span className="p-item-t">{it.title}</span>
              <span className="p-item-s">
                {book.kind === 'pdf'
                  ? `p. ${it.section + 1}`
                  : state === 'done'
                    ? <IconCheck />
                    : state === 'now' && loc
                      ? `${duration(minutesFor(loc.sectionWordsLeft))} left`
                      : minutes(i)}
              </span>
            </button>
          );
        })}
      </div>
      {canRemove && (
        <button type="button" className="btn btn-ghost p-remove" onClick={onRemove}>Remove from library</button>
      )}
    </div>
  );
}

/* Appearance */

interface LookProps {
  settings: ReaderSettings;
  isPdf: boolean;
  update: (fn: (s: ReaderSettings) => ReaderSettings) => void;
}

function Segmented<T extends string | number>({ label, value, options, onChange }: {
  label: string;
  value: T;
  options: Array<{ v: T; label: string; content?: React.ReactNode; disabled?: boolean }>;
  onChange: (v: T) => void;
}) {
  return (
    <div className="ctl">
      <div className="clbl">{label}</div>
      <div className="seg" role="radiogroup" aria-label={label}>
        {options.map((o) => (
          <button
            key={String(o.v)}
            type="button"
            role="radio"
            aria-checked={value === o.v}
            aria-label={o.content ? o.label : undefined}
            title={o.disabled ? 'Not designed yet' : o.content ? o.label : undefined}
            disabled={o.disabled}
            className={value === o.v ? 'is-on' : ''}
            onClick={() => onChange(o.v)}
          >
            {o.content ?? o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

const lines = (gap: number) => (
  <svg viewBox="0 0 22 16" aria-hidden="true"><path d={`M3 ${8 - gap}h16M3 8h16M3 ${8 + gap}h16`} stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
);
const margins = (inset: number) => (
  <svg viewBox="0 0 22 16" aria-hidden="true">
    <rect x="1" y="1" width="20" height="14" rx="2" fill="none" stroke="currentColor" strokeWidth="1.2" opacity=".5" />
    <path d={`M${inset} 5h${22 - inset * 2}M${inset} 8h${22 - inset * 2}M${inset} 11h${22 - inset * 2}`} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);

export function AppearancePanel({ settings, isPdf, update }: LookProps) {
  const cur = settings[settings.style];
  const set = (patch: Partial<StyleSettings>) => update((s) => ({ ...s, [s.style]: { ...s[s.style], ...patch } }));

  return (
    <div className="pnl">
      <div className="pnl-h">Appearance</div>
      {!isPdf && (
        <Segmented
          label="Style"
          value={settings.style}
          onChange={(v) => update((s) => ({ ...s, style: v }))}
          options={[
            { v: 'book', label: 'Book' },
            { v: 'modern', label: 'Modern' },
            { v: 'immersive' as 'book', label: 'Immersive', disabled: true },
          ]}
        />
      )}
      <div className="ctl">
        <div className="clbl">Theme</div>
        <div className="sws" role="radiogroup" aria-label="Theme">
          {THEMES.map((t) => (
            <button
              key={t.key}
              type="button"
              role="radio"
              aria-checked={settings.theme === t.key}
              aria-label={t.label}
              title={t.label}
              className={`sw t-${t.key}${settings.theme === t.key ? ' is-on' : ''}`}
              onClick={() => update((s) => ({ ...s, theme: t.key }))}
            >
              {t.key === 'auto' ? '' : 'Aa'}
            </button>
          ))}
        </div>
      </div>
      {isPdf ? (
        <>
          <Segmented label="Layout" value={settings.pdfLayout} onChange={(v) => update((s) => ({ ...s, pdfLayout: v }))} options={[{ v: 'pages', label: 'Pages' }, { v: 'scroll', label: 'Scroll' }]} />
          <p className="p-note">PDF pages keep their own layout, so typeface and size don’t apply.</p>
        </>
      ) : (
        <>
          <div className="ctl">
            <div className="clbl">Typeface</div>
            <div className="tfs" role="radiogroup" aria-label="Typeface">
              {FONTS.map((f) => (
                <button
                  key={f.key}
                  type="button"
                  role="radio"
                  aria-checked={cur.font === f.key}
                  className={cur.font === f.key ? 'is-on' : ''}
                  style={{ fontFamily: f.family }}
                  onClick={() => set({ font: f.key })}
                >
                  {f.label}
                  {f.note && <small>{f.note}</small>}
                </button>
              ))}
            </div>
          </div>
          <div className="ctl">
            <div className="clbl">Size</div>
            <div className="stp">
              <button type="button" aria-label="Smaller text" disabled={cur.size <= SIZE_MIN} onClick={() => set({ size: Math.max(SIZE_MIN, cur.size - 1) })}>A−</button>
              <span className="stp-v" aria-live="polite">{cur.size}</span>
              <button type="button" aria-label="Larger text" disabled={cur.size >= SIZE_MAX} onClick={() => set({ size: Math.min(SIZE_MAX, cur.size + 1) })}>A+</button>
            </div>
          </div>
          <div className="two">
            <Segmented label="Spacing" value={cur.lh} onChange={(v) => set({ lh: v })} options={SPACING.map((o, i) => ({ v: o.v, label: o.label, content: lines(4 + i) }))} />
            <Segmented label="Margins" value={cur.measure} onChange={(v) => set({ measure: v })} options={MEASURES.map((o, i) => ({ v: o.v, label: o.label, content: margins(4 + i * 2) }))} />
          </div>
          <Segmented label="Layout" value={cur.layout} onChange={(v) => set({ layout: v })} options={[{ v: 'pages', label: 'Pages' }, { v: 'scroll', label: 'Scroll' }]} />
          <div className="ctl tgrow">
            <span className="clbl">Justify</span>
            <button type="button" className="tg" role="switch" aria-checked={cur.justify} aria-label="Justify text" onClick={() => set({ justify: !cur.justify })} />
          </div>
        </>
      )}
      {canNarrate && <VoiceRows />}
      {canFullscreen() && <FullscreenRow />}
    </div>
  );
}

/** The voice that reads aloud and how fast; the device's own voices, the reader's language first. */
function VoiceRows() {
  const { voice, rate } = useVoicePrefs();
  const voices = useVoices();
  const lang = (navigator.language || 'en').split('-')[0].toLowerCase();
  const near = voices.filter((v) => v.lang.toLowerCase().startsWith(lang));
  const far = voices.filter((v) => !v.lang.toLowerCase().startsWith(lang));
  return (
    <>
      <div className="ctl">
        <label className="clbl" htmlFor="rd-voice">Voice</label>
        <div className="sel">
          <select id="rd-voice" value={voice ?? ''} onChange={(e) => setVoicePrefs({ voice: e.target.value || null })}>
            <option value="">Device default</option>
            {near.map((v) => <option key={v.voiceURI} value={v.voiceURI}>{v.name}</option>)}
            {far.length > 0 && (
              <optgroup label="Other languages">
                {far.map((v) => <option key={v.voiceURI} value={v.voiceURI}>{v.name} · {v.lang}</option>)}
              </optgroup>
            )}
          </select>
        </div>
      </div>
      <Segmented label="Speed" value={rate} onChange={(v) => setVoicePrefs({ rate: v })} options={RATES.map((r) => ({ v: r, label: `${r}×` }))} />
    </>
  );
}

function FullscreenRow() {
  const [on, toggle] = useFullscreen();
  return (
    <div className="ctl tgrow">
      <span className="clbl">Full screen</span>
      <button type="button" className="tg" role="switch" aria-checked={on} aria-label="Full screen" onClick={toggle} />
    </div>
  );
}
