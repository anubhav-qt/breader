import type { ReactNode } from 'react';
import './steps.css';

/*
 * The layout for dialogs that ask a few things in order, as the audiobook's does: the content on
 * the middle line (Modal's className "is-centered"), each question a numbered step whose number and
 * title sit at the left edge, and the answers as cards side by side, all of one height.
 */

/** A step: its number and title at the left edge. */
export function Step({ n, title, id, children, group = true }: { n: number; title: string; id?: string; children: ReactNode; group?: boolean }) {
  return (
    <section className="step">
      <h3 className="step-h" id={id}><span className="step-n" aria-hidden="true">{n}</span>{title}</h3>
      <div className="step-b" role={group ? 'radiogroup' : undefined} aria-label={group ? title : undefined}>{children}</div>
    </section>
  );
}

/**
 * An answer, as a card: its name, a word aside, and a few words on what it means under it. A radio dot before the name
 * when it's one of several to pick; an icon instead where picking it goes on at once.
 */
export function Choice({ on = false, off, name, aside, line, icon, radio = true, onPick }: {
  on?: boolean;
  off?: boolean;
  name: string;
  aside?: string;
  line?: string;
  icon?: ReactNode;
  radio?: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      role={radio ? 'radio' : undefined}
      aria-checked={radio ? on : undefined}
      aria-disabled={off || undefined}
      className={`choice${on ? ' is-on' : ''}${off ? ' is-off' : ''}`}
      onClick={() => { if (!off) onPick(); }}
    >
      <span className="choice-top">
        {radio ? <span className="choice-dot" aria-hidden="true" /> : icon}
        <span className="choice-name">{name}</span>
      </span>
      {aside && <span className="choice-aside">{aside}</span>}
      {line && <span className="choice-line">{line}</span>}
    </button>
  );
}
