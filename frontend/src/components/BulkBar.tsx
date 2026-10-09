import type { ReactNode } from 'react';
import './library-switch.css';

/** Something to do with every book picked. */
export interface BulkAction {
  key: string;
  label: string;
  /** Shown in place of the word, which is left for screen readers and the tooltip. */
  icon: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  run: (fromKeyboard: boolean) => void;
}

interface Props {
  /** How many books are ticked. */
  count: number;
  /** What the library they're in lets the reader do with them. */
  actions: BulkAction[];
  onDone: () => void;
}

/**
 * While picking books to act on together, the switch between libraries becomes this bar, in its
 * place: at the header's end on wide screens, floating at the bottom on phones. The actions are icons.
 */
export function BulkBar({ count, actions, onDone }: Props) {
  return (
    <div className="ls ls-bulk" role="toolbar" aria-label="Picked">
      <div className="ls-seg">
        <span className="ls-picked" role="status">{count} picked</span>
        {actions.map((a) => (
          <button
            key={a.key}
            type="button"
            className={`ls-tab ls-act${a.danger ? ' is-danger' : ''}`}
            title={a.label}
            disabled={count === 0 || a.disabled}
            onClick={(e) => a.run(e.detail === 0)}
          >
            {a.icon}
            <span className="ls-act-label">{a.label}</span>
          </button>
        ))}
        <button type="button" className="ls-tab is-done" onClick={onDone}>
          Done
        </button>
      </div>
    </div>
  );
}
