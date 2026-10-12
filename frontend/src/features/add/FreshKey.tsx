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

  let added = '';
  if (count > 1) added = `Your ${count} books are in ${labels.mine}. `;
  else if (title) added = `“${title}” is in ${labels.mine}. `;

  return (
    <>
      <p className="add-keynote">{added}Keep this key safe: it can’t be recovered.</p>
      <div className="key-box">{libraryKey}</div>
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
