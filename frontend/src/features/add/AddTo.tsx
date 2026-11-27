import { useEffect, useMemo, useRef, useState } from 'react';
import type { BookRecord } from '../../books/types';
import { IconCheck, IconDash, IconGlobe, IconLock, IconPeople } from '../../components/icons';
import { Modal } from '../../components/Modal';
import { colorVars } from '../../data/colors';
import { createLibrary, useShared, warmLibrary } from '../../data/shelf';
import { ApiError } from '../../lib/api';
import { doneLine, holds, placeBooks, targetsOf, tickOf, type Hands, type Place, type Target, type Tick } from './places';
import './addTo.css';

/** A book as its card shows it: its name and colour, the reader's own where they changed them. */
export interface Shown {
  id: string;
  title: string;
  color: string;
}

interface Props {
  /** The books the sheet is for, as records: the reader's own, or someone else's as their card. */
  entries: BookRecord[];
  shown: Shown[];
  /** The reader's own books, to tell where each one is. */
  records: BookRecord[];
  /** Someone else's books: the reader's own books are a row too. */
  theirs: boolean;
  /** The name of the reader's own books, Personal or as they named it. */
  personal: string;
  /** "Dune" or "3 books", for the line on Done. */
  what: string;
  hands: Hands;
  /** Says a new library was made, with its key to give out. */
  onMade: (label: string, key: string) => void;
  /** Closes it, with the one line saying what changed, or null when nothing did. */
  onClose: (line: string | null) => void;
}

const ICONS = { lock: IconLock, globe: IconGlobe, people: IconPeople };

/**
 * Add to: every library the reader may add to, one ticked list. A tick puts the books in at once,
 * an untick takes them out; a dash says only some of them are in it. A new library can be made at
 * the foot, and the books go straight into it. Done says what changed, in one line.
 */
export function AddTo({ entries, shown, records, theirs, personal, what, hands, onMade, onClose }: Props) {
  const sharing = useShared();
  const targets = useMemo(() => targetsOf(sharing, theirs, personal), [sharing, theirs, personal]);
  // What the reader ticked, shown at once while it reaches the libraries.
  const [want, setWant] = useState<Record<Place, boolean>>({});
  const [busy, setBusy] = useState<Set<Place>>(() => new Set());
  // The same, at once: a second click before the next draw finds its row still going.
  const going = useRef(new Set<Place>());
  const makingNow = useRef(false);
  // Each row's tick before the reader first changed it, and the order they changed them in.
  const before = useRef(new Map<Place, Tick>());
  const [name, setName] = useState('');
  const [making, setMaking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Each library's books, fresh, to tick the right rows.
  useEffect(() => {
    for (const t of targetsOf(sharing, theirs, personal)) {
      if (t.place !== 'personal' && t.place !== 'own') warmLibrary(t.place);
    }
    // Once, as it opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const tickAt = (place: Place): Tick => {
    if (place in want) {
      if (want[place]) return 'true';
      return 'false';
    }
    return tickOf(entries.map((e) => holds(sharing, records, place, e)));
  };

  const setBusyAt = (place: Place, on: boolean) => {
    if (on) going.current.add(place);
    else going.current.delete(place);
    setBusy((b) => {
      const next = new Set(b);
      if (on) next.add(place);
      else next.delete(place);
      return next;
    });
  };

  const put = async (place: Place, on: boolean) => {
    setBusyAt(place, true);
    setError(null);
    setWant((w) => ({ ...w, [place]: on }));
    try {
      await placeBooks(hands, entries, place, on);
    } catch (err) {
      // Back to what it was: the tick shows where the books really are.
      setWant((w) => {
        const next = { ...w };
        delete next[place];
        return next;
      });
      if (err instanceof ApiError) setError(err.message);
      else setError('Couldn’t change that library. Check your connection and try again.');
    } finally {
      setBusyAt(place, false);
    }
  };

  /** A tick everywhere, or off where all of them are in already. */
  const flip = (t: Target) => {
    if (going.current.has(t.place)) return;
    const now = tickAt(t.place);
    if (!before.current.has(t.place)) before.current.set(t.place, now);
    void put(t.place, now !== 'true');
  };

  const make = async () => {
    const clean = name.trim();
    if (!clean || makingNow.current) return;
    makingNow.current = true;
    setMaking(true);
    setError(null);
    try {
      const made = await createLibrary(clean);
      onMade(made.label, made.key);
      setName('');
      before.current.set(made.token, 'false');
      await put(made.token, true);
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
      else setError('Couldn’t make that library. Check your connection and try again.');
    } finally {
      makingNow.current = false;
      setMaking(false);
    }
  };

  const close = () => {
    const changes: Array<{ name: string; on: boolean }> = [];
    for (const [place, was] of before.current) {
      if (!(place in want)) continue;
      const on = want[place];
      if (on && was === 'true') continue;
      if (!on && was === 'false') continue;
      const t = targets.find((x) => x.place === place);
      if (t) changes.push({ name: t.name, on });
    }
    onClose(doneLine(what, changes));
  };

  return (
    <Modal title="Add to" onClose={close} width={420} className="at">
      <div className="at-what">
        <span className="at-spines" aria-hidden="true">
          {shown.slice(0, 3).map((b) => <span key={b.id} className="at-spine" style={colorVars(b.color)} />)}
        </span>
        <p>{shown.length === 1 ? shown[0].title : what}</p>
      </div>
      <div className="at-list">
        {targets.map((t) => {
          const tick = tickAt(t.place);
          const Icon = ICONS[t.icon];
          return (
            <button
              key={t.place}
              type="button"
              role="checkbox"
              aria-checked={tick}
              aria-busy={busy.has(t.place) || undefined}
              className="at-row"
              onClick={() => flip(t)}
            >
              <span className="at-icon"><Icon /></span>
              <span className="at-name">{t.name}</span>
              <span className="at-box">
                {tick === 'true' && <IconCheck />}
                {tick === 'mixed' && <IconDash />}
              </span>
            </button>
          );
        })}
      </div>
      <form className="at-new" onSubmit={(e) => { e.preventDefault(); void make(); }}>
        <input
          value={name}
          maxLength={60}
          placeholder="New shared library"
          aria-label="New shared library"
          onChange={(e) => { setName(e.target.value); setError(null); }}
        />
        <button type="submit" className="btn btn-quiet" disabled={!name.trim() || making}>{making ? 'Making…' : 'Make'}</button>
      </form>
      {error && <p className="at-error" role="alert">{error}</p>}
      <div className="at-foot">
        <button type="button" className="btn btn-primary" onClick={close}>Done</button>
      </div>
    </Modal>
  );
}
