import { useState, type FormEvent } from 'react';
import { motion } from 'motion/react';
import { IconClose, IconPencil } from '../../components/icons';
import { addLibrary, libraryName, removeLibrary, renameLibrary, type Shared, type Showing } from '../../data/shelf';
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
 * The shared libraries tab's list: the reader's own shared books, then the libraries they opened
 * with someone's key. Each can be named; others' come off the list with ×. A key pasted below adds
 * one. Others see the reader's shared books by the name they give their own.
 */
export function LibraryMenu({ sharing, ownCount, onShow, onClose, say }: Props) {
  const [renaming, setRenaming] = useState<Showing | null>(null);
  const [draft, setDraft] = useState('');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rows: Array<{ which: Showing; count: number | null; closed: boolean }> = [
    { which: 'own', count: ownCount, closed: false },
    ...sharing.saved.map((l) => ({ which: l.token, count: sharing.libs[l.token]?.books.length ?? null, closed: sharing.libs[l.token]?.state === 'closed' })),
  ];

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
      say(r.own ? 'That’s your own key: these are the books you share with it.' : `Added ${r.name ? `“${r.name}”` : 'their library'} to your shared libraries`);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t open that library. Check your connection and try again.');
    } finally {
      setBusy(false);
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
          return (
            <div key={which} className={`lm-row${on ? ' is-on' : ''}`}>
              {renaming === which ? (
                <input
                  className="lm-input"
                  autoFocus
                  value={draft}
                  maxLength={60}
                  placeholder={which === 'own' ? 'Your shared library' : name}
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
                    {which === 'own' ? 'Yours, ' : ''}
                    {closed ? 'its key has changed' : count === null ? 'opening…' : `${count} ${count === 1 ? 'book' : 'books'}`}
                  </span>
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
      {error && <p className="lm-error" role="alert">{error}</p>}
      <p className="lm-note">
        Your key opens the books you share for anyone you give it to: they can read them and keep a copy, never change yours.
        It opens your whole library too, so give it to people you trust.
      </p>
    </motion.div>
  );
}
