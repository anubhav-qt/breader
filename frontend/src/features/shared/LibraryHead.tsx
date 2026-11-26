import { useState, type MouseEvent } from 'react';
import type { FeedLibrary } from '@breader/shared/protocol';
import { LIBRARY_NAME_CHARS } from '@breader/shared/limits';
import { IconBack, IconCheck, IconPencil, IconPlus } from '../../components/icons';
import { factsLine, feedName } from './facts';
import './shared.css';

interface Props {
  library: FeedLibrary;
  /** The reader's own, or theirs to make public: nothing to save. */
  yours: boolean;
  saved: boolean;
  now: number;
  onBack: () => void;
  onSave: () => void;
  /** Names it, where it's the reader's to name: the same name as in Shared's list. */
  onRename?: (name: string) => void;
}

/** Over a library opened from the public feed: back to the feed, its name and facts, and Save; a pencil to rename it, where it's the reader's. */
export function LibraryHead({ library, yours, saved, now, onBack, onSave, onRename }: Props) {
  const [draft, setDraft] = useState<string | null>(null);

  /** A double click saves once: its second click would only take it off again. */
  const saveOnce = (e: MouseEvent<HTMLButtonElement>) => {
    if (e.detail > 1) return;
    onSave();
  };

  const finish = () => {
    if (draft === null) return;
    setDraft(null);
    if (draft.trim() === (library.name ?? '')) return;
    onRename?.(draft);
  };

  let save = null;
  if (!yours) {
    save = (
      <button type="button" className={`btn btn-quiet pub-save${saved ? ' is-on' : ''}`} aria-pressed={saved} onClick={saveOnce}>
        {saved ? <IconCheck aria-hidden="true" /> : <IconPlus aria-hidden="true" />}
        <span>{saved ? 'Saved' : 'Save'}</span>
      </button>
    );
  }

  let title = <h2>{feedName(library)}</h2>;
  if (draft !== null) {
    title = (
      <input
        className="pub-name-input"
        autoFocus
        value={draft}
        maxLength={LIBRARY_NAME_CHARS}
        placeholder={feedName({ ...library, name: null })}
        aria-label={`Name for ${feedName(library)}`}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={finish}
        onKeyDown={(e) => {
          if (e.key === 'Enter') finish();
          if (e.key === 'Escape') { e.stopPropagation(); setDraft(null); }
        }}
      />
    );
  }

  let rename = null;
  if (onRename && draft === null) {
    rename = (
      <button type="button" className="btn btn-ghost hdr-icon pub-rename" aria-label={`Rename ${feedName(library)}`} title="Rename" onClick={() => setDraft(library.name ?? '')}>
        <IconPencil aria-hidden="true" />
      </button>
    );
  }

  return (
    <div className="pub-head">
      <button type="button" className="btn btn-ghost hdr-icon" aria-label="Back to Public" onClick={onBack}>
        <IconBack aria-hidden="true" />
      </button>
      <div className="pub-title">
        <div className="pub-name">
          {title}
          {rename}
        </div>
        <p>{factsLine(library, yours, now)}</p>
      </div>
      {save}
    </div>
  );
}
