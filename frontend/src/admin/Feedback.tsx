import { useCallback, useEffect, useState } from 'react';
import { FEEDBACK_REPLY_CHARS, type FeedbackItem } from '@breader/shared/feedback';
import { ago } from './format';
import { Label, Seg } from './parts';
import type { Admin } from './types';

/** How often the list is asked for again while the page is open. */
const EVERY_MS = 60_000;

type Show = 'open' | 'all';
type Change = Partial<Pick<FeedbackItem, 'working' | 'done' | 'reply'>>;

/**
 * What readers asked for or told us (the app's Request a feature / Feedback), the newest first.
 * Each can be marked Working, and Done with a line on what it became: the library that sent it
 * is told each once (server routes/feedback.ts). Done ones hide unless All is picked.
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
  const [busy, setBusy] = useState<ReadonlySet<number>>(new Set());
  const patch = (id: number, change: Change) => {
    setItems((list) => list?.map((f) => (f.id === id ? { ...f, ...change } : f)) ?? null);
  };
  const change = async (f: FeedbackItem, next: Change, send: () => Promise<void>) => {
    if (busy.has(f.id)) return false;
    setBusy((m) => new Set(m).add(f.id));
    const before: Change = { working: f.working, done: f.done, reply: f.reply };
    patch(f.id, next);
    let ok = true;
    try {
      await send();
    } catch (e) {
      ok = false;
      patch(f.id, before);
      setSaid(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy((m) => {
        const left = new Set(m);
        left.delete(f.id);
        return left;
      });
    }
    return ok;
  };

  const working = (f: FeedbackItem) => change(f, { working: !f.working }, () => admin.feedbackWorking(f.id, !f.working));
  const done = (f: FeedbackItem, reply?: string) => {
    const next: Change = { done: !f.done };
    if (reply) next.reply = reply;
    return change(f, next, () => admin.feedbackDone(f.id, !f.done, reply));
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
          <Row key={f.id} f={f} busy={busy.has(f.id)} onWorking={() => void working(f)} onDone={(reply) => done(f, reply)} />
        ))}
      </ul>
    </section>
  );
}

/**
 * One reader's feedback. Done asks first for the line they're told, when there's a library to
 * tell; without one it's done at once. Not done puts it back.
 */
function Row({ f, busy, onWorking, onDone }: { f: FeedbackItem; busy: boolean; onWorking: () => void; onDone: (reply?: string) => Promise<boolean> }) {
  const [asking, setAsking] = useState(false);
  const [line, setLine] = useState(f.reply ?? '');
  const ready = line.trim().length > 0 && line.trim().length <= FEEDBACK_REPLY_CHARS;

  const pressDone = () => {
    if (f.done || !f.library) {
      void onDone();
      return;
    }
    setLine(f.reply ?? '');
    setAsking(true);
  };
  const send = async () => {
    if (!ready || busy) return;
    const ok = await onDone(line.trim());
    if (ok) setAsking(false);
  };

  let className = 'adm-fb-item';
  if (f.done) className += ' is-done';

  return (
    <li className={className}>
      <div className="adm-fb-meta">
        <span className={`adm-fb-kind is-${f.kind}`}>{f.kind === 'feature' ? 'Feature' : 'Feedback'}</span>
        <span>{ago(new Date(f.at).toISOString())}</span>
        <span title={f.library ?? undefined}>{f.library ? `library ${f.library.slice(0, 8)}` : 'no library'}</span>
        {f.release && <span title={f.release}>build {f.release.slice(0, 7)}</span>}
        {f.toldWorking && <span>told working</span>}
        {f.toldDone && <span>told done</span>}
      </div>
      <p className="adm-fb-body">{f.body}</p>
      <div className="adm-fb-acts">
        {!f.done && (
          <button type="button" className={f.working ? 'btn btn-quiet adm-small is-on' : 'btn btn-quiet adm-small'} aria-pressed={f.working} disabled={busy} onClick={onWorking}>
            Working
          </button>
        )}
        {!asking && (
          <button type="button" className="btn btn-quiet adm-small" disabled={busy} onClick={pressDone}>
            {f.done ? 'Not done' : 'Done'}
          </button>
        )}
      </div>
      {f.done && f.reply && <p className="adm-fb-reply">{f.reply}</p>}
      {asking && (
        <div className="adm-paste adm-fb-ask">
          <input
            type="text"
            placeholder="What to tell them"
            aria-label="What to tell them it became"
            value={line}
            maxLength={FEEDBACK_REPLY_CHARS}
            disabled={busy}
            autoFocus
            onChange={(e) => setLine(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void send();
              }
              if (e.key === 'Escape') setAsking(false);
            }}
          />
          <button type="button" className="btn btn-primary adm-small" disabled={!ready || busy} onClick={() => void send()}>Send</button>
          <button type="button" className="btn btn-ghost adm-small" disabled={busy} onClick={() => setAsking(false)}>Cancel</button>
        </div>
      )}
    </li>
  );
}
