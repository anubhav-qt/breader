import { useCallback, useEffect, useState } from 'react';
import type { FeedbackItem } from '@breader/shared/feedback';
import { ago } from './format';
import { Label, Seg } from './parts';
import type { Admin } from './types';

/** How often the list is asked for again while the page is open. */
const EVERY_MS = 60_000;

type Show = 'open' | 'all';

/**
 * What readers asked for or told us (the app's Request a feature / Feedback), the newest first.
 * Each can be marked done, and back; done ones hide unless All is picked.
 */
export function FeedbackCard({ admin }: { admin: Admin }) {
  const [items, setItems] = useState<FeedbackItem[] | null>(null);
  const [show, setShow] = useState<Show>('open');
  const [said, setSaid] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setItems(await admin.feedback());
      setSaid(null);
    } catch (e) {
      setSaid(e instanceof Error ? e.message : String(e));
    }
  }, [admin]);

  useEffect(() => {
    void load();
    const t = window.setInterval(() => void load(), EVERY_MS);
    return () => window.clearInterval(t);
  }, [load]);

  // One change at a time for each: a second click waits, so the server ends as the page shows.
  const [marking, setMarking] = useState<ReadonlySet<number>>(new Set());
  const setDone = (id: number, done: boolean) => {
    setItems((list) => list?.map((f) => (f.id === id ? { ...f, done } : f)) ?? null);
  };
  const mark = async (id: number, done: boolean) => {
    if (marking.has(id)) return;
    setMarking((m) => new Set(m).add(id));
    setDone(id, done);
    try {
      await admin.feedbackDone(id, done);
    } catch (e) {
      setDone(id, !done);
      setSaid(e instanceof Error ? e.message : String(e));
    } finally {
      setMarking((m) => {
        const next = new Set(m);
        next.delete(id);
        return next;
      });
    }
  };

  const open = items?.filter((f) => !f.done).length ?? 0;
  const shown = items?.filter((f) => show === 'all' || !f.done) ?? [];

  return (
    <section className="adm-card adm-fb" aria-labelledby="adm-fb-h" id="feedback">
      <Label side={<button type="button" className="btn btn-quiet adm-small" onClick={() => void load()}>Refresh</button>}>Feedback</Label>
      <div className="adm-card-h">
        <h2 id="adm-fb-h" className="adm-mid">{items ? `${open} open` : '…'}</h2>
        <Seg value={show} onChange={setShow} label="Show" options={[{ v: 'open', label: 'Open' }, { v: 'all', label: 'All' }]} />
      </div>
      {said && <p className="adm-bad" role="alert">{said}</p>}
      {items && !shown.length && <p className="adm-none">{show === 'open' ? 'Nothing open.' : 'Nothing yet.'}</p>}
      <ul className="adm-fb-list">
        {shown.map((f) => (
          <li key={f.id} className={f.done ? 'adm-fb-item is-done' : 'adm-fb-item'}>
            <div className="adm-fb-meta">
              <span className={`adm-fb-kind is-${f.kind}`}>{f.kind === 'feature' ? 'Feature' : 'Feedback'}</span>
              <span>{ago(new Date(f.at).toISOString())}</span>
              <span title={f.library ?? undefined}>{f.library ? `library ${f.library.slice(0, 8)}` : 'no library'}</span>
              {f.release && <span title={f.release}>build {f.release.slice(0, 7)}</span>}
            </div>
            <p className="adm-fb-body">{f.body}</p>
            <button type="button" className="btn btn-quiet adm-small" disabled={marking.has(f.id)} onClick={() => void mark(f.id, !f.done)}>
              {f.done ? 'Not done' : 'Done'}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
