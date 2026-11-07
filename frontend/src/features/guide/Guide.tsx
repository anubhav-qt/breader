import { useMemo, useRef, useState } from 'react';
import { Modal } from '../../components/Modal';
import { IconSearch } from '../../components/icons';
import { KEY_LIST } from '../reader/keys';
import { FEATURES, GROUPS, type Feature, type Go } from './list';
import { forgetTold, setTips, useGuideKept } from './seen';
import './guide.css';

/*
 * The guide: everything Breader does, each in a line with where it's found, grouped, with a box to
 * find one by a word. What came since it was last opened is New, at the top. Some have Show me,
 * which goes there. Then the keys, and the switch for tips.
 */

interface Props {
  /** When it was last opened, before this time: what came since is New. */
  seenAt: number;
  /** What it looks for as it opens. */
  initial?: string;
  /** Goes where a feature is; absent for what can't be gone to from here just now. */
  go: (g: Go) => (() => void) | undefined;
  onClose: () => void;
}

/** Keys in the library, and while an audiobook plays. */
const LIBRARY_KEYS: Array<[string, string]> = [['?', 'This guide']];
const AUDIOBOOK_KEYS: Array<[string, string]> = [
  ['Space  K', 'Play or pause'],
  ['←  →', 'Back or on 5 seconds'],
  ['J  L', 'Back or on 10 seconds'],
  [',  .', 'The paragraph before or after'],
];

const hasMouse = () => typeof window !== 'undefined' && window.matchMedia('(hover: hover) and (pointer: fine)').matches;

export function Guide({ seenAt, initial = '', go, onClose }: Props) {
  const [q, setQ] = useState(initial);
  const bar = useRef<HTMLDivElement>(null);
  // A new search starts at the top of what it finds.
  const find = (text: string) => {
    setQ(text);
    bar.current?.closest('.modal')?.scrollTo({ top: 0 });
  };
  const kept = useGuideKept();
  const mouse = useMemo(hasMouse, []);
  const all = useMemo(() => FEATURES.filter((f) => !f.mouse || mouse), [mouse]);
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const hit = (text: string) => words.every((w) => text.toLowerCase().includes(w));
  const shown = words.length ? all.filter((f) => hit(`${f.name} ${f.what} ${f.where} ${f.group} ${(f.keys ?? []).join(' ')}`)) : all;
  const fresh = shown.filter((f) => f.since !== undefined && f.since > seenAt);
  const keyRows = (rows: Array<[string, string]>) => (words.length ? rows.filter(([k, d]) => hit(`${k} ${d} keys`)) : rows);
  const keys = { library: keyRows(LIBRARY_KEYS), book: keyRows(KEY_LIST), audiobook: keyRows(AUDIOBOOK_KEYS) };
  const anyKeys = keys.library.length + keys.book.length + keys.audiobook.length > 0;

  const row = (f: Feature, isNew: boolean) => {
    const run = f.go ? go(f.go) : undefined;
    return (
      <li key={f.id} className="gd-item">
        <div className="gd-text">
          <b className="gd-name">
            {f.name}
            {isNew && <span className="gd-new">New</span>}
          </b>
          <span className="gd-what">{f.what}</span>
          <span className="gd-where">
            {f.where}
            {f.keys && <span className="gd-keys">{f.keys.map((k) => <kbd key={k}>{k}</kbd>)}</span>}
          </span>
        </div>
        {run && (
          <button type="button" className="btn btn-quiet gd-go" onClick={() => { onClose(); run(); }}>
            Show me
          </button>
        )}
      </li>
    );
  };

  return (
    <Modal title="Guide" onClose={onClose} width={640} className="gd">
      <div className="gd-bar" ref={bar}>
        <label className="gd-find">
          <IconSearch />
          <input
            type="search"
            value={q}
            onChange={(e) => find(e.target.value)}
            placeholder="Find what Breader does"
            aria-label="Find in the guide"
            spellCheck={false}
            autoComplete="off"
          />
        </label>
      </div>

      {fresh.length > 0 && (
        <section className="gd-group is-new" aria-labelledby="gd-new">
          <h3 id="gd-new">New since you last looked</h3>
          <ul>{fresh.map((f) => row(f, true))}</ul>
        </section>
      )}

      {GROUPS.map((g) => {
        const list = shown.filter((f) => f.group === g && !fresh.includes(f));
        if (!list.length) return null;
        const id = `gd-${g.replace(/\W+/g, '-').toLowerCase()}`;
        return (
          <section key={g} className="gd-group" aria-labelledby={id}>
            <h3 id={id}>{g}</h3>
            <ul>{list.map((f) => row(f, false))}</ul>
          </section>
        );
      })}

      {anyKeys && (
        <section className="gd-group" aria-labelledby="gd-keys">
          <h3 id="gd-keys">Keys</h3>
          <KeyTable title="In the library" rows={keys.library} />
          <KeyTable title="In a book, while it’s read or lit" rows={keys.book} />
          <KeyTable title="While an audiobook plays" rows={keys.audiobook} />
        </section>
      )}

      {!shown.length && !anyKeys && <p className="gd-none">Nothing called that. Try another word.</p>}

      <div className="gd-tips">
        <span className="gd-tips-text">
          <b id="gd-tips">Tips</b>
          <span>A short tip now and then, each once, and a dot on settings when there’s something new.</span>
        </span>
        <button type="button" className="switch" role="switch" aria-checked={kept.tips} aria-labelledby="gd-tips" onClick={() => setTips(!kept.tips)} />
      </div>
      {kept.told.length > 0 && (
        <button type="button" className="login-link gd-again" onClick={forgetTold}>Show the tips again</button>
      )}
    </Modal>
  );
}

function KeyTable({ title, rows }: { title: string; rows: Array<[string, string]> }) {
  if (!rows.length) return null;
  return (
    <div className="gd-keyset">
      <span className="gd-keyset-h">{title}</span>
      <dl>
        {rows.map(([k, d]) => (
          <div key={k} className="gd-keyrow">
            <dt>{k.split('  ').map((x) => <kbd key={x}>{x}</kbd>)}</dt>
            <dd>{d}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
