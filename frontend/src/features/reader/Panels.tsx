import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { keepChapters, letGo, stopKeeping, useKept } from '../../books/kept';
import type { LoadedBook, MangaBook, TocItem } from '../../books/types';
import { duration, minutesFor } from '../../lib/format';
import { IconCheck } from '../../components/icons';
import { useBarHidden } from './focus';
import type { Loc } from './FlowView';
import { BOOK_COLORS } from '../../data/colors';
import { readMangaPrefs, writeMangaPrefs } from '../../lib/mangadex';
import { FONTS, MANGA_WIDTHS, MEASURES, SIZE_MAX, SIZE_MIN, SPACING, THEMES, TWO_COLORS, styleFor, type MangaDir, type MangaLayout, type MangaLook, type ReaderSettings, type StyleSettings } from './settings';

/* Contents */

/** A series from MangaDex: chapters kept in this browser to read offline, and keeping more. */
function Offline({ remote, at, kept, now, queued, failed }: { remote: NonNullable<MangaBook['remote']>; at: number } & ReturnType<typeof useKept>) {
  const hosted = remote.chapters.filter((c) => c.pages > 0);
  const from = Math.max(0, hosted.findIndex((c) => c.first + c.pages > at));
  const next = hosted.slice(from, from + 5).filter((c) => !kept[c.id]?.done);
  const done = Object.values(kept).filter((k) => k.done);
  const mb = Math.max(1, Math.round(done.reduce((n, k) => n + k.bytes, 0) / 1_000_000));
  const text = now
    ? `Keeping ${now.label}: ${now.done} of ${now.of} pages${queued ? `, then ${queued} more` : ''}`
    : failed
      ? `Not all of them came: ${failed}`
      : done.length
        ? `${done.length === 1 ? '1 chapter' : `${done.length} chapters`} kept to read offline, ${mb} MB`
        : 'Keep chapters in this browser to read them offline.';
  return (
    <div className="p-offline" aria-live="polite">
      <span>{text}</span>
      <span className="p-offline-b">
        {now ? (
          <button type="button" onClick={stopKeeping}>Stop</button>
        ) : next.length > 0 && (
          <button type="button" onClick={() => keepChapters(remote.series, next)}>{next.length === 1 ? `Keep ${next[0].label}` : `Keep the next ${next.length}`}</button>
        )}
        {!now && done.length > 0 && <button type="button" onClick={() => void letGo(remote.series)}>Let go of them</button>}
      </span>
    </div>
  );
}

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
  items.forEach((it, i) => { if (it.section <= section && !it.link && !it.reopen) current = i; });
  const remote = book.kind === 'manga' ? book.remote : undefined;
  const offline = useKept(remote?.series);

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
      {remote && (
        <>
          {remote.page ? (
            <a className="p-from" href={remote.page} target="_blank" rel="noopener noreferrer">From {remote.name}, made by its scanlation groups ↗</a>
          ) : (
            <span className="p-from">From {remote.name}, made by its scanlation groups</span>
          )}
          <Offline remote={remote} at={section} {...offline} />
        </>
      )}
      <div className="p-bar"><i style={{ width: `${pct}%` }} /></div>
      <div className="p-meta">
        <span>{pct}%</span>
        <span>{loc ? (loc.bookWordsLeft ? `${duration(minutesFor(loc.bookWordsLeft))} left` : 'Finished') : ''}</span>
      </div>
      <div className="p-list" ref={listRef}>
        {items.length === 0 && <p className="p-empty">This book has no table of contents.</p>}
        {items.map((it, i) => {
          const state = i < current ? 'done' : i === current ? 'now' : 'next';
          // Not open this time (a series from the reader's own server opens a few chapters at a time): it opens again there.
          if (it.reopen) {
            const at = it.reopen;
            return (
              <button key={`${it.title}-away-${i}`} type="button" className="p-item is-next is-away" style={{ paddingLeft: 10 + Math.min(it.level, 3) * 14, '--i': i } as CSSProperties} onClick={() => window.dispatchEvent(new CustomEvent('breader:reopen', { detail: { pos: at } }))}>
                <span className="p-item-t">{it.title}</span>
                <span className="p-item-s">Opens there</span>
              </button>
            );
          }
          // Read on its publisher's site: a link there, not a place here.
          if (it.link) {
            return (
              <a key={`${it.section}-link-${i}`} className={`p-item is-${state} is-link`} href={it.link} target="_blank" rel="noopener noreferrer" style={{ paddingLeft: 10 + Math.min(it.level, 3) * 14, '--i': i } as CSSProperties}>
                <span className="p-item-t">{it.title}</span>
                <span className="p-item-s">Official ↗</span>
              </a>
            );
          }
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
                {book.kind !== 'flow'
                  ? `${remote && offline.kept[remote.chapters[i]?.id]?.done ? 'Kept · ' : ''}p. ${it.section + 1}`
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
  kind: LoadedBook['kind'];
  update: (fn: (s: ReaderSettings) => ReaderSettings) => void;
  /** The book can read in 2 voices, so their colours can be picked. */
  two?: boolean;
  /** A manga: how it reads here, and the way to change that. */
  manga?: MangaControls;
}

/** `saver`: read from MangaDex, whose pages can come smaller. */
export interface MangaControls {
  look: MangaLook;
  pick: (patch: { layout?: MangaLayout; dir?: MangaDir }) => void;
  widen: (width: number) => void;
  saver: boolean;
}

export function Segmented<T extends string | number>({ label, value, options, onChange }: {
  label: string;
  value: T;
  /** `muted`: not ready yet. It looks off, and a tap still reaches onChange, which says why. */
  options: Array<{ v: T; label: string; content?: React.ReactNode; muted?: boolean }>;
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
            aria-disabled={o.muted || undefined}
            aria-label={o.content ? o.label : undefined}
            title={o.content ? o.label : undefined}
            className={value === o.v ? 'is-on' : o.muted ? 'is-muted' : ''}
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

/** MangaDex's smaller pages, for a slow or metered connection: this device's choice. */
function DataSaver() {
  const [saver, setSaver] = useState(() => readMangaPrefs().saver);
  const pick = (on: boolean) => {
    writeMangaPrefs({ ...readMangaPrefs(), saver: on });
    setSaver(on);
  };
  return <Segmented label="Quality" value={saver ? 'saver' : 'full'} onChange={(v) => pick(v === 'saver')} options={[{ v: 'full', label: 'Full quality' }, { v: 'saver', label: 'Data saver' }]} />;
}

/**
 * A manga's layout, the way its pages turn, and how wide they scroll. On a narrow screen it opens
 * scrolled, and keeps a layout there apart from wider ones; the column of pages is as wide as the screen.
 */
function MangaLookControls({ look, pick, widen, saver }: MangaControls) {
  const keeps = look.narrow ? 'Each manga keeps its own layout on a screen this narrow, apart from wider ones.' : 'Each manga keeps its own layout.';
  let note = `One page after another, down the screen. A panel held steps on to the next in the direction picked. ${keeps}`;
  if (look.layout === 'pages') {
    const shown = look.narrow ? 'One page at a time, and a spread printed across two pages whole: tap it twice to look closer.' : 'Two pages side by side when the screen is wide enough.';
    note = `${shown} Manga reads right to left, comics left to right. ${keeps}`;
  }
  if (look.layout === 'panels') {
    note = `One panel at a time, fitted to the screen, in the order it’s read: the arrows or a swipe glide on to the next, and after a page’s last panel, turn the page. Manga reads right to left, comics left to right. ${keeps}`;
  }
  return (
    <>
      <Segmented label="Layout" value={look.layout} onChange={(v) => pick({ layout: v })} options={[{ v: 'pages', label: 'Pages' }, { v: 'scroll', label: 'Scroll' }, { v: 'panels', label: 'Panels' }]} />
      <Segmented label="Direction" value={look.dir} onChange={(v) => pick({ dir: v })} options={[{ v: 'rtl', label: 'Right to left' }, { v: 'ltr', label: 'Left to right' }]} />
      {!look.narrow && look.layout === 'scroll' && (
        <Segmented label="Width" value={look.width} onChange={widen} options={MANGA_WIDTHS.map((w) => ({ v: w.v, label: w.label }))} />
      )}
      <p className="p-note">{note}</p>
      {saver && (
        <>
          <DataSaver />
          <p className="p-note">Data saver brings MangaDex’s smaller copy of each page, for a slow or metered connection. Pages kept offline stay as they were kept.</p>
        </>
      )}
    </>
  );
}

export function AppearancePanel({ settings, kind, update, two = false, manga }: LookProps) {
  const cur = settings[settings.style];
  const set = (patch: Partial<StyleSettings>) => update((s) => ({ ...s, [s.style]: { ...s[s.style], ...patch } }));
  // Immersive's voice bar, as the rest of the controls sleep (focus.ts).
  const [barHidden, setBarHidden] = useBarHidden();

  return (
    <div className="pnl">
      <div className="pnl-h">Appearance</div>
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
      {kind === 'manga' && manga ? (
        <MangaLookControls {...manga} />
      ) : kind === 'pdf' ? (
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
          {/* Pages read as Book, scrolling as Modern, each with its own type. */}
          <Segmented label="Layout" value={cur.layout} onChange={(v) => update((s) => ({ ...s, style: styleFor(v) }))} options={[{ v: 'pages', label: 'Pages' }, { v: 'scroll', label: 'Scroll' }]} />
          <div className="ctl tgrow">
            <span className="clbl">Justify</span>
            <button type="button" className="tg" role="switch" aria-checked={cur.justify} aria-label="Justify text" onClick={() => set({ justify: !cur.justify })} />
          </div>
        </>
      )}
      {kind !== 'manga' && (
        <div className="ctl tgrow">
          <span className="clbl">Always hide the voice bar</span>
          <button type="button" className="tg" role="switch" aria-checked={barHidden} aria-label="Always hide the voice bar in focus" onClick={() => setBarHidden(!barHidden)} />
        </div>
      )}
      {two && <TwoColors settings={settings} update={update} />}
    </div>
  );
}

/** 2 voices: the colour her lines light up in, and his. */
function TwoColors({ settings, update }: Pick<LookProps, 'settings' | 'update'>) {
  const now = settings.twoColors ?? TWO_COLORS;
  return (
    <div className="two">
      {(['F', 'M'] as const).map((g) => {
        const label = g === 'F' ? 'Her lines' : 'His lines';
        return (
          <div key={g} className="ctl">
            <div className="clbl">{label}</div>
            <div className="vc-sws" role="radiogroup" aria-label={label}>
              {BOOK_COLORS.map((c) => (
                <button
                  key={c.key}
                  type="button"
                  role="radio"
                  aria-checked={now[g] === c.key}
                  aria-label={c.label}
                  title={c.label}
                  className={`vc-sw${now[g] === c.key ? ' is-on' : ''}`}
                  style={{ background: `var(--bc-${c.key})` }}
                  onClick={() => update((s) => ({ ...s, twoColors: { ...(s.twoColors ?? TWO_COLORS), [g]: c.key } }))}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
