import { useState } from 'react';
import { IconLock, IconPeople } from '../../components/icons';
import { Modal } from '../../components/Modal';
import { useLabels } from '../../data/labels';
import { libraryName, useShared } from '../../data/shelf';

/** Personal, or the shared libraries picked. */
export interface Where {
  tokens: string[];
}

interface Props {
  onChoose: (where: Where | null) => void;
}

/** Where a book being added goes: the reader's own books, or the shared libraries they tick. */
export function AddWhere({ onChoose }: Props) {
  const sharing = useShared();
  const labels = useLabels();
  const open = sharing.saved.filter((l) => sharing.libs[l.token]?.state !== 'closed');
  const [toShared, setToShared] = useState(false);
  const [ticked, setTicked] = useState<string[]>(() => {
    if (open.length === 1) return [open[0].token];
    return [];
  });

  const toggle = (token: string) => {
    if (ticked.includes(token)) setTicked(ticked.filter((t) => t !== token));
    else setTicked([...ticked, token]);
  };

  const add = () => {
    if (toShared) onChoose({ tokens: ticked });
    else onChoose({ tokens: [] });
  };

  return (
    <Modal title="Add to" onClose={() => onChoose(null)} width={420}>
      <div className="add">
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
          <div className="add-where" role="group" aria-label={labels.shelf}>
            {open.map((l) => {
              const on = ticked.includes(l.token);
              return (
                <button key={l.token} type="button" role="checkbox" aria-checked={on} className={`add-where-row${on ? ' is-on' : ''}`} onClick={() => toggle(l.token)}>
                  <i className="add-check" />
                  <span>{libraryName(sharing, l.token)}</span>
                </button>
              );
            })}
          </div>
        )}
        <div className="add-actions">
          <button type="button" className="btn btn-ghost" onClick={() => onChoose(null)}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={toShared && ticked.length === 0} onClick={add}>Add</button>
        </div>
      </div>
    </Modal>
  );
}
