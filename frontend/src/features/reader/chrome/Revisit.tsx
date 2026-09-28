import { useDeferredValue, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { LoadedBook } from '../../../books/types';
import { hasKey } from '../../../data/sync';
import { chapterName, type Chapter } from '../chapters';
import type { Loc } from '../FlowView';
import { merge, partsOf, readParts, SCOPES, type Job, type Notes, type Scope } from '../revisit';
import type { Block } from '../search';

/** The drop up from the bottom line: how far back to go. */
export function RevisitMenu({ chapters, current, loc, onPick }: { chapters: Chapter[]; current: number; loc: Loc | null; onPick: (s: Scope) => void }) {
  const pct = Math.round((loc?.progress ?? 0) * 100);
  const sub: Record<Scope, string> = {
    chapter: chapters.length > 1 ? chapterName(chapters, current) : 'What you’ve read of it',
    recent: `From ${chapterName(chapters, current - 4)}`,
    all: `${pct}% of the book`,
  };
  const shown = SCOPES.filter((s) => (s.v === 'recent' ? current >= 5 : s.v === 'all' ? current >= 1 : true));
  return (
    <div className="pnl">
      <div className="pnl-h">Revisit</div>
      <p className="p-note rv-about">Who’s who, where’s where, and the words to know, from what you’ve read.</p>
      {hasKey() ? (
        <div className="p-list rv-scopes">
          {shown.map((s) => (
            <button key={s.v} type="button" className="p-item rv-scope" onClick={() => onPick(s.v)}>
              <span className="rv-scope-t">
                <span className="p-item-t">{s.label}</span>
                <span className="rv-sub">{sub[s.v]}</span>
              </span>
            </button>
          ))}
        </div>
      ) : (
        <p className="p-note">Once this library has a key, Revisit can read what you’ve read.</p>
      )}
    </div>
  );
}

type Tab = 'people' | 'places' | 'terms';
const TABS: Array<{ v: Tab; label: string }> = [
  { v: 'people', label: 'People' },
  { v: 'places', label: 'Places' },
  { v: 'terms', label: 'Words' },
];
const EMPTY: Record<Tab, string> = {
  people: 'No one to remember here yet.',
  places: 'No places to remember here yet.',
  terms: 'No words that need explaining here.',
};

interface WindowProps {
  book: LoadedBook;
  chapters: Chapter[];
  current: number;
  loc: Loc;
  scope: Scope;
  read: (onRead?: (done: number, of: number) => void) => Promise<Block[]>;
}

/** The window in the middle: the scope's people, places and words, filling in as chapters are read. */
export function RevisitWindow({ book, chapters, current, loc, scope, read }: WindowProps) {
  const [job, setJob] = useState<Job | null>(null);
  const [reading, setReading] = useState(0);
  const [tab, setTab] = useState<Tab>('people');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<Set<string>>(() => new Set());

  // Where the reader is when it opens: reading on doesn't change what's being read.
  const [at] = useState(() => ({ loc, current }));
  useEffect(() => {
    let on = true;
    void read((done, of) => { if (on) setReading(done / of); }).then((blocks) => {
      if (on) setJob(readParts(book, scope, partsOf(blocks, chapters, at.current, at.loc, scope)));
    });
    return () => { on = false; };
  }, [book, chapters, scope, read, at]);

  const state = useSyncExternalStore(job?.subscribe ?? noop, () => job?.state ?? null);
  const parts = state?.parts ?? [];
  const done = parts.filter((p) => p.state === 'done');
  const notes: Notes = useMemo(() => merge(done.map((p) => ({ chapter: p.title, notes: p.notes! }))), [state]); // eslint-disable-line react-hooks/exhaustive-deps
  const many = new Set(parts.map((p) => p.chapter)).size > 1;

  const wanted = useDeferredValue(q.trim().toLowerCase());
  const has = (...s: string[]) => !wanted || s.some((x) => x.toLowerCase().includes(wanted));
  const people = notes.people.filter((p) => has(p.name, ...p.aka));
  const places = notes.places.filter((p) => has(p.name));
  const terms = notes.terms.filter((t) => has(t.term));
  const count: Record<Tab, number> = { people: people.length, places: places.length, terms: terms.length };

  const failed = parts.filter((p) => p.state === 'failed').length;
  const status = !state
    ? `Finding what you’ve read… ${Math.round(reading * 100)}%`
    : state.off
      ? state.off
      : !parts.length
        ? 'There’s not enough read here yet. Read on a little, then come back.'
        : state.going
          ? `Reading ${done.length} of ${parts.length}. The notes fill in as each is done.`
          : failed
            ? `${failed === parts.length ? 'None' : `${failed} of ${parts.length}`} couldn’t be read. ${state.why ?? ''}`
            : null;
  const toggle = (name: string) => setOpen((s) => { const n = new Set(s); if (n.has(name)) n.delete(name); else n.add(name); return n; });
  const title = SCOPES.find((s) => s.v === scope)!.label;

  return (
    <div className="pnl rv-pnl">
      <div className="rv-head">
        <div className="pnl-h">Revisit</div>
        <div className="rv-title">
          <span>{title}</span>
          {scope === 'chapter' && chapters.length > 1 && <small>{chapterName(chapters, at.current)}</small>}
        </div>
        <input
          className="vs-input rv-find"
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          enterKeyHint="search"
          placeholder="A name, a place or a word"
          autoComplete="off"
          spellCheck={false}
          aria-label="Find in these notes"
        />
        <div className="seg rv-tabs" role="tablist" aria-label="Notes">
          {TABS.map((t) => (
            <button key={t.v} type="button" role="tab" aria-selected={tab === t.v} className={tab === t.v ? 'is-on' : ''} onClick={() => setTab(t.v)}>
              {t.label}
              <small>{count[t.v]}</small>
            </button>
          ))}
        </div>
        {status && (
          <div className="rv-status" role="status">
            {state?.going && parts.length > 1 && (
              <span className="vs-prog-dots rv-dots" aria-hidden="true">
                {parts.map((p, i) => <i key={i} className={p.state === 'done' ? 'is-read' : p.state === 'reading' ? 'is-now' : ''} />)}
              </span>
            )}
            <p className="p-note">{status}</p>
            {!state?.going && failed > 0 && !state?.off && job && (
              <button type="button" className="rv-again" onClick={job.retry}>Try again</button>
            )}
          </div>
        )}
      </div>

      <div className="rv-list" role="tabpanel">
        {tab === 'people' &&
          people.map((p) => {
            const last = p.did[p.did.length - 1];
            const all = open.has(p.name);
            return (
              <div key={p.name} className="rv-item">
                <div className="rv-name">{p.name}</div>
                {p.aka.length > 0 && <div className="rv-aka">Also {p.aka.join(', ')}</div>}
                {p.who && <p className="rv-text">{p.who}</p>}
                {(all ? p.did : last ? [last] : []).map((d, i) => (
                  <p key={i} className="rv-text rv-did">
                    {many && <span className="rv-ch">{d.chapter}</span>}
                    {d.text}
                  </p>
                ))}
                {p.did.length > 1 && (
                  <button type="button" className="rv-more" onClick={() => toggle(p.name)} aria-expanded={all}>
                    {all ? 'Just the latest' : `Every chapter they’re in (${p.did.length})`}
                  </button>
                )}
              </div>
            );
          })}
        {tab === 'places' &&
          places.map((p) => (
            <div key={p.name} className="rv-item">
              <div className="rv-name">{p.name}</div>
              <p className="rv-text">{p.about}</p>
              {many && p.chapters > 1 && <div className="rv-aka">In {p.chapters} chapters</div>}
            </div>
          ))}
        {tab === 'terms' &&
          terms.map((t) => (
            <div key={t.term} className="rv-item">
              <div className="rv-name rv-term">{t.term}</div>
              <p className="rv-text">
                {many && <span className="rv-ch">{t.chapter}</span>}
                {t.meaning}
              </p>
            </div>
          ))}
        {count[tab] === 0 && state && !state.going && parts.length > 0 && done.length > 0 && (
          <p className="p-empty rv-empty">{wanted ? 'Nothing here goes by that.' : EMPTY[tab]}</p>
        )}
      </div>
    </div>
  );
}

const noop = () => () => {};
