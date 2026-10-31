import { useState, type FormEvent } from 'react';
import { motion } from 'motion/react';
import { IconClose, IconKey, IconPencil, IconPlus, IconStar } from '../../components/icons';
import { addLibrary, createLibrary, libraryKey, libraryName, removeLibrary, renameLibrary, setDefaultLibrary, type Shared, type Showing } from '../../data/shelf';
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
}

/**
 * The shared libraries tab's list: the libraries opened with someone's key, Shared 1, 2 and on,
 * then the reader's own shared books, Shared. Each can be named; others' come off the list with ×.
 * The star picks the one the tab opens at, the first unless the reader picks another. A key pasted
 * below adds one, and a name makes a new one only to share, with its own key. Others see the
 * reader's shared books by the name they give their own.
 */
export function LibraryMenu({ sharing, ownCount, onShow, onClose, say }: Props) {
  const [renaming, setRenaming] = useState<Showing | null>(null);
  const [draft, setDraft] = useState('');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** A new library's name, while one is being made. */
  const [making, setMaking] = useState<string | null>(null);

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
    renameLibrary(renaming, draft);
    setRenaming(null);
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
                    {closed ? 'its key has changed' : count === null ? 'opening…' : `${count} ${count === 1 ? 'book' : 'books'}`}
                    {choosing && isDefault ? ', opens first' : ''}
                    {theirs && theirs !== name ? <>, “{theirs}” to its owner</> : null}
                  </span>
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
              {which !== 'own' && !closed && (
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
            </div>
          );
        })}
      </div>
      <form className="lm-add" onSubmit={(e) => void open(e)}>
        <input
          className="lm-input"
          value={key}
          placeholder="Someone’s key: BRDR-…"
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
          New shared library
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
