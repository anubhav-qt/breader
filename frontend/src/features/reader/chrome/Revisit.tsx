import { useCallback, useDeferredValue, useEffect, useState } from 'react';
import type { RevisitEntry, RevisitResponse } from '@breader/shared/ai';
import { chapterAt, chapterName, type Chapter } from '../chapters';

/*
 * Revisit: who's who, where's where and the words to know, from what the reader has read. An AI
 * read the whole book ahead of time (the book's AI switch); the server only hands over what comes
 * before the reader's mark, so nothing here can give anything away.
 */

export type Scope = 'chapter' | 'recent' | 'all';
const SCOPES: Array<{ v: Scope; label: string }> = [
  { v: 'chapter', label: 'This chapter' },
  { v: 'recent', label: 'The last five' },
  { v: 'all', label: 'Everything so far' },
];

/** The drop up from the bottom line: how far back to go. `read` is how far the reader has really read. */
export function RevisitMenu({ chapters, current, read, onPick }: { chapters: Chapter[]; current: number; read: number; onPick: (s: Scope) => void }) {
  const sub: Record<Scope, string> = {
    chapter: chapters.length > 1 ? chapterName(chapters, current) : 'What you’ve read of it',
    recent: `From ${chapterName(chapters, Math.max(0, current - 4))}`,
    all: `${Math.round(read * 100)}% of the book`,
  };
  const shown = SCOPES.filter((s) => (s.v === 'recent' ? current >= 5 : s.v === 'all' ? current >= 1 : true));
  return (
    <div className="pnl">
      <div className="pnl-h">Revisit</div>
      <p className="p-note rv-about">Who’s who, where’s where, and the words to know, from what you’ve read.</p>
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

type Loaded = { notes: RevisitResponse; offline: boolean };

interface WindowProps {
  chapters: Chapter[];
  current: number;
  scope: Scope;
  load: () => Promise<Loaded>;
}

/** An entry as the scope shows it: only what happened in those chapters. */
interface Shown extends RevisitEntry {
  did: Array<[number, number, string]>;
  /** How many of the scope's chapters it's in. */
  chapters: number;
}

/** The window in the middle: the scope's people, places and words. */
export function RevisitWindow({ chapters, current, scope, load }: WindowProps) {
  const [got, setGot] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('people');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<Set<number>>(() => new Set());
  // The chapter it opened in: reading on underneath doesn't change what's shown.
  const [at] = useState(current);

  const fetchNotes = useCallback(() => {
    setError(null);
    let live = true;
    load()
      .then((g) => { if (live) setGot(g); })
      .catch(() => { if (live) setError('Revisit can’t reach your notes just now. Check the connection, then try again.'); });
    return () => { live = false; };
  }, [load]);
  useEffect(fetchNotes, [fetchNotes]);

  // The scope's sections: from its first chapter's start up to the next chapter after this one.
  const from = scope === 'chapter' ? at : scope === 'recent' ? Math.max(0, at - 4) : 0;
  const lo = from === 0 ? 0 : chapters[from]?.section ?? 0;
  const hi = scope === 'all' ? Infinity : chapters[at + 1]?.section ?? Infinity;
  const inScope = (section: number) => section >= lo && section < hi;
  const chapterOf = (section: number) => chapterAt(chapters, { section });
  const many = scope !== 'chapter' && chapters.length > 1;

  const wanted = useDeferredValue(q.trim().toLowerCase());
  const has = (e: RevisitEntry) => !wanted || [e.name, ...e.also].some((x) => x.toLowerCase().includes(wanted));
  const pick = (list: RevisitEntry[]): Shown[] =>
    list
      .filter((e) => e.seen.some(inScope) && has(e))
      .map((e) => ({ ...e, did: e.events.filter((d) => inScope(d[0])), chapters: new Set(e.seen.filter(inScope).map(chapterOf)).size }));
  const notes = got?.notes;
  const lists: Record<Tab, Shown[]> = { people: pick(notes?.people ?? []), places: pick(notes?.places ?? []), terms: pick(notes?.terms ?? []) };

  const toggle = (key: number) => setOpen((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  const title = SCOPES.find((s) => s.v === scope)!.label;
  const status = error ?? (!got ? 'Finding your notes…' : got.offline ? 'You’re offline, so these are your notes from last time.' : null);

  /** Events, each chapter's name before its first one when the scope has more than one. */
  const events = (did: Array<[number, number, string]>) =>
    did.map(([s, , text], i) => {
      const ch = chapterOf(s);
      const label = many && (i === 0 || chapterOf(did[i - 1][0]) !== ch);
      return (
        <p key={i} className="rv-text rv-did">
          {label && <span className="rv-ch">{chapterName(chapters, ch)}</span>}
          {text}
        </p>
      );
    });

  return (
    <div className="pnl rv-pnl">
      <div className="rv-head">
        <div className="pnl-h">Revisit</div>
        <div className="rv-title">
          <span>{title}</span>
          {scope === 'chapter' && chapters.length > 1 && <small>{chapterName(chapters, at)}</small>}
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
              <small>{lists[t.v].length}</small>
            </button>
          ))}
        </div>
        {status && (
          <div className="rv-status" role="status">
            <p className="p-note">{status}</p>
            {error && <button type="button" className="rv-again" onClick={fetchNotes}>Try again</button>}
          </div>
        )}
      </div>

      <div className="rv-list" role="tabpanel">
        {tab === 'people' &&
          lists.people.map((p) => {
            const all = open.has(p.key);
            const last = p.did[p.did.length - 1];
            return (
              <div key={p.key} className="rv-item">
                <div className="rv-name">{p.name}</div>
                {p.also.length > 0 && <div className="rv-aka">Also {p.also.join(', ')}</div>}
                {p.about && <p className="rv-text">{p.about}</p>}
                {events(all ? p.did : last ? [last] : [])}
                {p.did.length > 1 && (
                  <button type="button" className="rv-more" onClick={() => toggle(p.key)} aria-expanded={all}>
                    {all ? 'Just the latest' : p.chapters > 1 ? `Every chapter they’re in (${p.chapters})` : `All of it (${p.did.length})`}
                  </button>
                )}
              </div>
            );
          })}
        {tab === 'places' &&
          lists.places.map((p) => (
            <div key={p.key} className="rv-item">
              <div className="rv-name">{p.name}</div>
              {p.also.length > 0 && <div className="rv-aka">Also {p.also.join(', ')}</div>}
              {p.about && <p className="rv-text">{p.about}</p>}
              {events(p.did.slice(-1))}
              {many && p.chapters > 1 && <div className="rv-aka">In {p.chapters} chapters</div>}
            </div>
          ))}
        {tab === 'terms' &&
          lists.terms.map((t) => (
            <div key={t.key} className="rv-item">
              <div className="rv-name rv-term">{t.name}</div>
              {t.also.length > 0 && <div className="rv-aka">Also {t.also.join(', ')}</div>}
              <p className="rv-text">
                {many && <span className="rv-ch">{chapterName(chapters, chapterOf(t.first[0]))}</span>}
                {t.about}
              </p>
            </div>
          ))}
        {got && lists[tab].length === 0 && <p className="p-empty rv-empty">{wanted ? 'Nothing here goes by that.' : EMPTY[tab]}</p>}
      </div>
    </div>
  );
}
