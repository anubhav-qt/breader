import { useState } from 'react';
import { Modal } from '../../components/Modal';
import { IconCheck } from '../../components/icons';
import { useLabels } from '../../data/labels';
import { useSyncStatus, type SyncStatus } from '../../data/sync';
import { normalizeKey } from '../../lib/key';
import { FreshKey } from './FreshKey';
import './add.css';

interface Props {
  libraryKey: string | null;
  /** Shown once, right after the key is created. */
  fresh?: boolean;
  onClose: () => void;
  /** Adds someone's key as a shared library of its own: the box's usual answer. */
  onShared?: (key: string) => Promise<void>;
  /** Opens the library behind another key, replacing the books in this browser: only for the reader's own. */
  onOpen?: (key: string) => Promise<void>;
  /** Logged out: offers to log in instead of keeping the key. */
  onLogin?: () => void;
  loggedIn?: boolean;
}

function syncLine(s: SyncStatus): string | null {
  const waiting = s.pending === 1 ? '1 change waiting to sync' : `${s.pending} changes waiting to sync`;
  switch (s.state) {
    case 'syncing': return 'Syncing…';
    case 'synced': return s.pending ? waiting : `Synced${s.via === 'fallback' ? ' through the backup server' : ''}.`;
    case 'offline': return `Offline.${s.pending ? ` ${waiting}.` : ''} Your books are safe in this browser.`;
    case 'error': return s.message ?? 'Sync stopped. Breader will try again.';
    default: return null;
  }
}

export function KeyDialog({ libraryKey, fresh, onClose, onShared, onOpen, onLogin, loggedIn }: Props) {
  const labels = useLabels();
  const [copied, setCopied] = useState(false);
  const [entered, setEntered] = useState('');
  const [busy, setBusy] = useState(false);
  /** Asked to swap this browser's books for the key's: one more tap says so. */
  const [swapping, setSwapping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sync = useSyncStatus();

  const copy = async () => {
    if (!libraryKey) return;
    try {
      await navigator.clipboard.writeText(libraryKey);
      setCopied(true);
    } catch {
      const el = document.querySelector('.key-box');
      if (el) window.getSelection()?.selectAllChildren(el);
    }
  };

  const valid = normalizeKey(entered) !== null;

  const run = async (go: ((key: string) => Promise<void>) | undefined) => {
    if (!go || !valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      await go(entered);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Breader couldn’t open that library.');
    } finally {
      setBusy(false);
    }
  };

  const status = libraryKey && !fresh ? syncLine(sync) : null;

  return (
    <Modal title={fresh ? 'Your personal key' : 'Library key'} onClose={onClose} width={480}>
      <div className="add">
        {fresh && libraryKey ? (
          <FreshKey libraryKey={libraryKey} onLogin={onLogin} onDone={onClose} />
        ) : libraryKey ? (
          <>
            <p className="add-keynote">
              {loggedIn
                ? 'Your account keeps this key. It opens your private books in any browser, without logging in.'
                : 'This key opens your private books in any browser. Keep it somewhere safe: Breader can’t recover it.'}
            </p>
            <div className="key-box">{libraryKey}</div>
            {status && <p className="add-local" role="status">{status}</p>}
            <div className="add-actions">
              <button type="button" className="btn btn-quiet" onClick={() => void copy()}>{copied ? <><IconCheck /> Copied</> : 'Copy key'}</button>
            </div>
          </>
        ) : (
          <p className="add-keynote">You’ll get a key when you add your first private book.</p>
        )}
        {!fresh && <>
        <div className="add-sep" />
        <label className="add-label" htmlFor="enter-key">Someone else’s key</label>
        <input
          id="enter-key"
          className="add-input key-input"
          placeholder="BRDR-XXXX-XXXX-XXXX-XXXX-XXXX"
          value={entered}
          onChange={(e) => { setEntered(e.target.value.toUpperCase()); setError(null); setSwapping(false); }}
          onKeyDown={(e) => { if (e.key === 'Enter') void run(swapping ? onOpen : onShared); }}
          spellCheck={false}
          autoComplete="off"
          disabled={busy}
        />
        {error ? (
          <p className="add-local key-error" role="alert">{error}</p>
        ) : swapping ? (
          <p className="add-local key-error" role="alert">
            {libraryKey
              ? 'Only for your own key from another browser: the books in this browser, and where you are in them, are swapped for that library’s. Keep your current key to come back to these.'
              : 'Only for your own key from another browser: the books in this browser, and where you are in them, are swapped for that library’s.'}
          </p>
        ) : (
          <p className="add-local">Their shared books open as a shared library of their own. Nothing of theirs comes into {labels.mine}.</p>
        )}
        <div className="add-actions">
          {swapping ? (
            <>
              <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => { setSwapping(false); setError(null); }}>Cancel</button>
              <button type="button" className="btn btn-primary" disabled={!valid || busy || !onOpen} onClick={() => void run(onOpen)}>
                {busy ? 'Opening…' : 'Swap to this library'}
              </button>
            </>
          ) : (
            <>
              {onOpen && !loggedIn && <button type="button" className="btn btn-ghost" disabled={!valid || busy} onClick={() => { setSwapping(true); setError(null); }}>It’s my own key</button>}
              <button type="button" className="btn btn-primary" disabled={!valid || busy || !onShared} onClick={() => void run(onShared)}>
                {busy ? 'Opening…' : 'Add shared library'}
              </button>
            </>
          )}
        </div>
        </>}
      </div>
    </Modal>
  );
}
