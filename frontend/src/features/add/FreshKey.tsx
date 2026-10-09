import { useState } from 'react';
import { IconCheck } from '../../components/icons';
import { useLabels } from '../../data/labels';
import './add.css';

interface Props {
  libraryKey: string;
  /** The book that made the key, named first. */
  title?: string;
  /** Added together with others: how many. */
  count?: number;
  /** Unset once logged in: the account keeps the key already. */
  onLogin?: () => void;
  onDone: () => void;
}

/** A new key, shown once: keep it, or log in so an account keeps the books instead. */
export function FreshKey({ libraryKey, title, count = 1, onLogin, onDone }: Props) {
  const [copied, setCopied] = useState(false);
  const labels = useLabels();

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(libraryKey);
      setCopied(true);
    } catch {
      const el = document.querySelector('.key-box');
      if (el) window.getSelection()?.selectAllChildren(el);
    }
  };

  return (
    <>
      <p className="add-keynote">
        {count > 1 ? `Your ${count} books are in ${labels.mine}. ` : title ? `“${title}” is in ${labels.mine}. ` : ''}This is your personal key. Store it somewhere safe: it can’t be recovered.
      </p>
      <div className="key-box">{libraryKey}</div>
      <p className="add-local">
        {onLogin
          ? 'Log in to keep your books and details with an account, or use this key to open them in any browser.'
          : 'Your account keeps this key too. It opens your books in any browser.'}
      </p>
      <div className="add-actions key-actions">
        <button type="button" className="btn btn-quiet" onClick={() => void copy()}>
          {copied ? <><IconCheck /> Copied</> : 'Copy key'}
        </button>
        {onLogin && <button type="button" className="btn btn-ghost" onClick={onLogin}>Log in</button>}
        <button type="button" className="btn btn-primary" onClick={onDone}>Use this key</button>
      </div>
    </>
  );
}
