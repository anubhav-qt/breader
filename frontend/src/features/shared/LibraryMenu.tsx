import { useEffect, useState, type FormEvent } from 'react';
import { motion } from 'motion/react';
import { ASK_NOTE_CHARS } from '@breader/shared/protocol';
import { IconClose, IconGlobe, IconKey, IconPencil, IconPeople, IconPlus, IconStar } from '../../components/icons';
import { addLibrary, answerAsk, askToChange, createLibrary, libraryKey, libraryName, loadAsks, loadOwnPublic, removeLibrary, renameLibrary, setDefaultLibrary, setPublic, type Shared, type Showing } from '../../data/shelf';
import { ApiError } from '../../lib/api';
import { springs } from '../../lib/springs';
import './shared.css';

interface Props {
  sharing: Shared;
  /** How many books the reader shares. */
  ownCount: number;
  /** The library shown in the tab, or about to be. */
  onShow: (which: Showing) => void;
  onClose: () => void;
  say: (text: string) => void;
  /** Opened to type someone's key in: the box has the cursor. */
  focusKey?: boolean;
}

/**
 * The shared libraries tab's list: the libraries opened with someone's key, Shared 1, 2 and on,
 * then the reader's own shared books, Shared. Each can be named; others' come off the list with ×.
 * The star picks the one the tab opens at, the first unless the reader picks another. A key pasted
 * below adds one, and a name makes a new one only to share, with its own key. Others see the
 * reader's shared books by the name they give their own.
 *
 * A copy saved from Public asks its original's owner to let the reader change it, with a note or
 * none. The owner sees each ask under that library's row, says yes or no, and can take a yes back.
 */
export function LibraryMenu({ sharing, ownCount, onShow, onClose, say, focusKey = false }: Props) {
  const [renaming, setRenaming] = useState<Showing | null>(null);
  const [draft, setDraft] = useState('');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** A new library's name, while one is being made. */
  const [making, setMaking] = useState<string | null>(null);
  /** The library whose Make public is being asked. */
  const [asking, setAsking] = useState<Showing | null>(null);
  /** The copy whose ask to change its original is being written, and its note. */
  const [askingFor, setAskingFor] = useState<Showing | null>(null);
  const [note, setNote] = useState('');
  /** An ask being answered, so a second click does nothing. */
  const [answering, setAnswering] = useState<string | null>(null);
  useEffect(() => { void loadOwnPublic(); }, []);
  // The asks to change each library the reader may answer for: their own, and those made only to share.
  const answerable = sharing.saved.filter((l) => sharing.libs[l.token]?.mayPublish === true).map((l) => l.token).join(' ');
  useEffect(() => {
    void loadAsks('own');
    for (const token of answerable.split(' ')) {
      if (token) void loadAsks(token);
    }
  }, [answerable]);

  /** It's in the public feed. */
  const isPublic = (which: Showing) => {
    if (which === 'own') return sharing.ownPublic === true;
    return sharing.libs[which]?.public === true;
  };
  /** The reader may put it in the feed: their own, or one made only to share they have the key to. */
  const mayPublish = (which: Showing) => {
    if (which === 'own') return sharing.ownPublic !== null;
    return sharing.libs[which]?.mayPublish === true;
  };
  const publish = async (which: Showing, on: boolean, name: string) => {
    setAsking(null);
    try {
      await setPublic(which, on);
      say(on ? `${name} is public` : `Only its key opens ${name} now`);
    } catch (err) {
      say(err instanceof ApiError ? err.message : 'Couldn’t change that. Check your connection and try again.');
    }
  };
  const flipPublic = (which: Showing, name: string) => {
    if (isPublic(which)) { void publish(which, false, name); return; }
    if (asking === which) { setAsking(null); return; }
    setAsking(which);
  };

  /** Asks the copy's original's owner to let the reader change it. */
  const sendAsk = async (which: Showing, name: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await askToChange(which, note);
      setAskingFor(null);
      setNote('');
      say(`Asked to change the original of “${name}”`);
    } catch (err) {
      say(err instanceof ApiError ? err.message : 'Couldn’t ask. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  };
  /** Yes or no to an ask, or a yes taken back. */
  const answer = async (which: Showing, id: string, give: boolean) => {
    if (answering) return;
    setAnswering(id);
    try {
      const state = await answerAsk(which, id, give);
      if (state === 'given') say('They can change it now');
      if (state === 'taken') say('Took it back');
    } catch (err) {
      say(err instanceof ApiError ? err.message : 'Couldn’t answer. Check your connection and try again.');
    } finally {
      setAnswering(null);
    }
  };

  const rows: Array<{ which: Showing; count: number | null; closed: boolean }> = [
    ...sharing.saved.map((l) => ({ which: l.token, count: sharing.libs[l.token]?.books.length ?? null, closed: sharing.libs[l.token]?.state === 'closed' })),
    { which: 'own', count: ownCount, closed: false },
  ];
  /** Only one library: it's the default, with nothing to pick. */
  const choosing = rows.length > 1;

  const startRename = (which: Showing) => {
    setRenaming(which);
    setDraft(which === 'own' ? sharing.ownName ?? '' : libraryName(sharing, which));
  };
  const saveRename = () => {
    if (renaming === null) return;
    setRenaming(null);
    renameLibrary(renaming, draft).catch((err: unknown) => {
      say(err instanceof ApiError ? err.message : 'Couldn’t rename it. Check your connection and try again.');
    });
  };

  const open = async (e: FormEvent) => {
    e.preventDefault();
    if (!key.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await addLibrary(key);
      setKey('');
      onShow(r.own ? 'own' : r.token);
      say(r.own ? 'That’s your own key: these are the books you share with it.' : `Added ${r.label} to your shared libraries`);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t open that library. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  const make = async (e: FormEvent) => {
    e.preventDefault();
    if (!making?.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await createLibrary(making);
      setMaking(null);
      onShow(r.token);
      await navigator.clipboard.writeText(r.key).then(
        () => say(`Made “${r.label}”. Its key is copied: give it to the people it’s for.`),
        () => say(`Made “${r.label}”. Its key: ${r.key}`),
      );
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t make that library. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  /** Copies a library's key to give to more people, when it's one made only to share. */
  const copyKey = async (which: string, name: string) => {
    try {
      const k = await libraryKey(which);
      if (!k) return say(`Only the owner of “${name}” can give out its key.`);
      await navigator.clipboard.writeText(k).then(
        () => say(`Copied the key to “${name}”`),
        () => say(`The key to “${name}”: ${k}`),
      );
    } catch (err) {
      say(err instanceof ApiError ? err.message : 'Couldn’t get that key. Check your connection and try again.');
    }
  };

  return (
    <motion.div
      className="lm"
      role="dialog"
      aria-label="Shared libraries"
      initial={{ opacity: 0, y: -4, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -4, transition: { duration: 0.12 } }}
      transition={springs.snappy}
    >
      <div className="lm-list">
        {rows.map(({ which, count, closed }) => {
          const name = libraryName(sharing, which);
          const on = sharing.showing === which;
          const isDefault = sharing.byDefault === which;
          // What its owner calls it, when that isn't the name it has here.
          const theirs = which === 'own' ? null : sharing.libs[which]?.name;
          const copy = which === 'own' ? undefined : sharing.libs[which]?.copy;
          // A copy may ask to change its original while it's public, until it's waiting or given.
          let mayAsk = false;
          if (copy?.live) mayAsk = copy.asked !== 'asked' && copy.asked !== 'given';
          const asks = sharing.asks[which] ?? [];
          const waiting = asks.filter((a) => a.state === 'asked').length;
          let size: string;
          if (closed) {
            size = 'its key has changed';
          } else if (count === null) {
            size = 'opening…';
          } else if (count === 1) {
            size = '1 book';
          } else {
            size = `${count} books`;
          }
          if (choosing && isDefault) size += ', opens first';
          let facts = '';
          if (isPublic(which)) facts += ', public';
          if (copy?.asked === 'asked') facts += ', asked its owner';
          if (copy?.grant) facts += ', can change the original';
          if (waiting > 0) facts += `, ${waiting} asking`;
          return (
            <div key={which} className={`lm-row${on ? ' is-on' : ''}`}>
              {renaming === which ? (
                <input
                  className="lm-input"
                  autoFocus
                  value={draft}
                  maxLength={60}
                  placeholder={which === 'own' ? 'Shared' : name}
                  aria-label={`Name for ${name}`}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={saveRename}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') saveRename();
                    if (e.key === 'Escape') { e.stopPropagation(); setRenaming(null); }
                  }}
                />
              ) : (
                <button type="button" className="lm-pick" aria-current={on} onClick={() => { onShow(which); onClose(); }}>
                  <span className="lm-name">{name}</span>
                  <span className="lm-sub">
                    <span>{size}</span>
                    {theirs && theirs !== name ? <span>{`, “${theirs}” to its owner`}</span> : null}
                    <span>{facts}</span>
                  </span>
                </button>
              )}
              {mayPublish(which) && (
                <button
                  type="button"
                  className="lm-pub"
                  role="switch"
                  aria-checked={isPublic(which) || asking === which}
                  title="Public"
                  aria-label={`Public: ${name} in the feed`}
                  onClick={() => flipPublic(which, name)}
                >
                  <i><IconGlobe /></i>
                </button>
              )}
              {mayAsk && (
                <button
                  type="button"
                  className="lm-icon"
                  title="Ask to change the original"
                  aria-label={`Ask to change the original of ${name}`}
                  aria-expanded={askingFor === which}
                  onClick={() => { setAskingFor(askingFor === which ? null : which); setNote(''); }}
                >
                  <IconPeople />
                </button>
              )}
              {choosing && (
                <button
                  type="button"
                  className={`lm-icon lm-star${isDefault ? ' is-on' : ''}`}
                  title={isDefault ? 'The tab opens here' : 'Open the tab here'}
                  aria-label={`Open the shared tab at ${name}`}
                  aria-pressed={isDefault}
                  onClick={() => { if (!isDefault) { setDefaultLibrary(which); say(`The shared tab opens at ${name} from now on`); } }}
                >
                  <IconStar />
                </button>
              )}
              {which !== 'own' && !closed && sharing.libs[which]?.access !== 'public' && (
                <button type="button" className="lm-icon" title="Copy its key" aria-label={`Copy the key to ${name}`} onClick={() => void copyKey(which, name)}>
                  <IconKey />
                </button>
              )}
              <button type="button" className="lm-icon" title="Rename" aria-label={`Rename ${name}`} onClick={() => startRename(which)}>
                <IconPencil />
              </button>
              {which !== 'own' && (
                <button
                  type="button"
                  className="lm-icon"
                  title="Remove from your list"
                  aria-label={`Remove ${name} from your list`}
                  onClick={() => { removeLibrary(which); say(`Took “${name}” off your list. Books of theirs you’ve started stay in yours.`); }}
                >
                  <IconClose />
                </button>
              )}
              {askingFor === which && (
                <form className="lm-ask" onSubmit={(e) => { e.preventDefault(); void sendAsk(which, name); }}>
                  <input
                    className="lm-input"
                    autoFocus
                    value={note}
                    maxLength={ASK_NOTE_CHARS}
                    placeholder="A note to its owner (optional)"
                    aria-label={`A note with your ask to change ${name}`}
                    onChange={(e) => setNote(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setAskingFor(null); } }}
                  />
                  <div>
                    <button type="button" className="btn btn-quiet" onClick={() => setAskingFor(null)}>Cancel</button>
                    <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Asking…' : 'Ask'}</button>
                  </div>
                </form>
              )}
              {asks.length > 0 && (
                <ul className="lm-asks-list" aria-label={`Asks to change ${name}`}>
                  {asks.map((a) => (
                    <li key={a.id}>
                      <p>
                        <b>{a.tag}</b>
                        {a.note ? <span>{a.note}</span> : null}
                      </p>
                      {a.state === 'asked' ? (
                        <div>
                          <button type="button" className="btn btn-quiet" disabled={answering === a.id} onClick={() => void answer(which, a.id, false)}>No</button>
                          <button type="button" className="btn btn-primary" disabled={answering === a.id} onClick={() => void answer(which, a.id, true)}>Let them</button>
                        </div>
                      ) : (
                        <div>
                          <button type="button" className="btn btn-quiet" disabled={answering === a.id} onClick={() => void answer(which, a.id, false)}>Take back</button>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {asking === which && (
                <div className="lm-ask">
                  <p>Anyone can find and open it.</p>
                  <div>
                    <button type="button" className="btn btn-quiet" onClick={() => setAsking(null)}>Cancel</button>
                    <button type="button" className="btn btn-primary" onClick={() => void publish(which, true, name)}>Make public</button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <form className="lm-add" onSubmit={(e) => void open(e)}>
        <input
          className="lm-input"
          value={key}
          placeholder="Someone’s key: BRDR-…"
          autoFocus={focusKey}
          aria-label="Someone’s key, to open their shared library"
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setKey(e.target.value)}
        />
        <button type="submit" className="btn btn-primary" disabled={!key.trim() || busy}>{busy ? 'Opening…' : 'Open'}</button>
      </form>
      {making === null ? (
        <button type="button" className="lm-new" onClick={() => { setMaking(''); setError(null); }}>
          <IconPlus />
          <span>New shared library</span>
        </button>
      ) : (
        <form className="lm-add" onSubmit={(e) => void make(e)}>
          <input
            className="lm-input"
            autoFocus
            value={making}
            maxLength={60}
            placeholder="Its name, like Book club"
            aria-label="Name for the new shared library"
            onChange={(e) => setMaking(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setMaking(null); } }}
          />
          <button type="submit" className="btn btn-primary" disabled={!making.trim() || busy}>{busy ? 'Making…' : 'Make'}</button>
        </form>
      )}
      {error && <p className="lm-error" role="alert">{error}</p>}
      <p className="lm-note">
        Your key opens your whole library. Give it only to people you trust.
      </p>
    </motion.div>
  );
}
