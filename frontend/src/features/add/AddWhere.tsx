import { useState } from 'react';
import { IconLock, IconPeople } from '../../components/icons';
import { Modal } from '../../components/Modal';
import { useLabels } from '../../data/labels';
import { createLibrary, libraryName, useShared } from '../../data/shelf';
import { ApiError } from '../../lib/api';

/** Personal, or the shared library picked. */
export interface Where {
  tokens: string[];
}

interface Props {
  onChoose: (where: Where | null) => void;
  /** Says a new library was made, with its key to give out. */
  onCreated?: (label: string, key: string) => void;
}

/** The dropdown's entry for making a library there and then. */
const NEW = 'new';

/**
 * Where a book or series being added goes: the reader's own (Personal), or one shared library,
 * picked from a dropdown. A new one can be made from the same dropdown, by its name.
 */
export function AddWhere({ onChoose, onCreated }: Props) {
  const sharing = useShared();
  const labels = useLabels();
  const open = sharing.saved.filter((l) => sharing.libs[l.token]?.state !== 'closed');
  const [toShared, setToShared] = useState(false);
  // The one showing in the shared tab, when it's one that can be added to; else the first, or a new one.
  const [picked, setPicked] = useState<string>(() => {
    if (open.some((l) => l.token === sharing.showing)) return sharing.showing;
    return open[0]?.token ?? NEW;
  });
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const making = toShared && picked === NEW;
  const ready = !toShared || (making ? name.trim().length > 0 : true);

  const add = async () => {
    if (!toShared) return onChoose({ tokens: [] });
    if (!making) return onChoose({ tokens: [picked] });
    setBusy(true);
    setError(null);
    try {
      const made = await createLibrary(name);
      onCreated?.(made.label, made.key);
      onChoose({ tokens: [made.token] });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t make that library. Check your connection and try again.');
      setBusy(false);
    }
  };

  return (
    <Modal title="Add to" onClose={() => onChoose(null)} width={420}>
      <form className="add" onSubmit={(e) => { e.preventDefault(); if (ready && !busy) void add(); }}>
        <div className="add-choices" role="radiogroup" aria-label="Add to">
          <button type="button" role="radio" aria-checked={!toShared} className={`add-choice${!toShared ? ' is-on' : ''}`} onClick={() => setToShared(false)}>
            <IconLock />
            <span><b>{labels.mine}</b></span>
            <i className="add-radio" />
          </button>
          <button type="button" role="radio" aria-checked={toShared} className={`add-choice${toShared ? ' is-on' : ''}`} onClick={() => setToShared(true)}>
            <IconPeople />
            <span><b>{labels.shelf}</b></span>
            <i className="add-radio" />
          </button>
        </div>
        {toShared && (
          <div className="add-where">
            <label className="add-pick">
              <span className="sr-only">Shared library</span>
              <select value={picked} autoFocus={open.length > 0} onChange={(e) => { setPicked(e.target.value); setError(null); }}>
                {open.map((l) => <option key={l.token} value={l.token}>{libraryName(sharing, l.token)}</option>)}
                <option value={NEW}>New shared library…</option>
              </select>
            </label>
            {making && (
              <input
                className="add-new-name"
                autoFocus
                value={name}
                maxLength={60}
                placeholder="Its name, like Book club"
                aria-label="Name for the new shared library"
                onChange={(e) => setName(e.target.value)}
              />
            )}
            {making && <p className="add-found">It gets its own key, to give to the people it’s for.</p>}
            {error && <p className="add-error" role="alert">{error}</p>}
          </div>
        )}
        <div className="add-actions">
          <button type="button" className="btn btn-ghost" onClick={() => onChoose(null)}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={!ready || busy}>{busy ? 'Making…' : making ? 'Make and add' : 'Add'}</button>
        </div>
      </form>
    </Modal>
  );
}
