import { useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { springs } from '../lib/springs';
import { ago, modelName, span, toneOf, until } from './format';
import { Dots, Label, Monogram, PartDots, Percent, Seg, Stepper, Switch } from './parts';
import { stepsFor, TASK_NAMES, type Admin, type Marker, type MarkerSettings, type Task, type Waiting, type Working } from './types';

/*
 * The AI marker: how far through the library it is, each book it's on, step by step, with what
 * each step does, who's doing it and what it just did; then the queue, to reorder, keep back or try
 * again. Its settings open at the top.
 */

const keyOf = (x: { id: string; task: Task }) => `${x.id}:${x.task}`;

/** How far a book is through its task, out of 100: its steps done, and the parts of the one it's on. */
function percentOf(w: Working) {
  const steps = stepsFor(w).filter((s) => !w.skipped.includes(s.key));
  const at = steps.findIndex((s) => s.key === w.step);
  let part = 0;
  if (w.parts.length) {
    const done = w.parts.filter((p) => p === 'done' || p === 'backup').length;
    part = done / w.parts.length;
  }
  return Math.floor((100 * (at + part)) / steps.length);
}

export function MarkerCard({ m, admin }: { m: Marker; admin: Admin }) {
  const [open, setOpen] = useState<string | null>(() => (m.working[0] ? keyOf(m.working[0]) : null));
  const [setting, setSetting] = useState(false);
  const [filter, setFilter] = useState<'all' | Task>('all');
  const paused = m.settings.paused;

  // One dot a book, while there's room for them; past that, a meter out of a hundred.
  let library = <Dots on={m.finished} of={m.books} label="Books done" />;
  if (m.books > 80) library = <Percent value={(100 * m.finished) / m.books} label="Books done" />;

  const counts: Record<'all' | Task, number> = { all: m.queue.length, marks: 0, music: 0, notes: 0 };
  for (const q of m.queue) counts[q.task]++;
  let shown = m.queue;
  if (filter !== 'all') shown = m.queue.filter((q) => q.task === filter);

  return (
    <section className="ad-card ad-marker" aria-labelledby="ad-marker-h">
      <div className="ad-card-h">
        <div className="ad-card-t">
          <Label>AI marker</Label>
          <h2 id="ad-marker-h" className="ad-big">{m.finished} of {m.books} books done</h2>
          <p className="ad-sub">{m.working.length} working · {m.queue.length} waiting</p>
        </div>
        <div className="ad-card-acts">
          <span className={`ad-run${paused ? ' is-paused' : ''}`}>
            <span>{paused ? 'Paused' : 'Running'}</span>
            <Switch on={!paused} label="The marker runs" onChange={(on) => admin.settings({ paused: !on })} />
          </span>
          <button type="button" className={`btn btn-quiet ad-small${setting ? ' is-on' : ''}`} aria-expanded={setting} onClick={() => setSetting(!setting)}>
            Settings
          </button>
        </div>
      </div>
      {library}

      <AnimatePresence initial={false}>
        {setting && (
          <motion.div key="settings" className="ad-fold" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={springs.snappy}>
            <Settings s={m.settings} onChange={admin.settings} />
          </motion.div>
        )}
      </AnimatePresence>

      <Label side={<span className="ad-count">{m.working.length}</span>}>Working on</Label>
      {!m.working.length && <p className="ad-none">Nothing.</p>}
      <div className="ad-books">
        {m.working.map((w) => (
          <WorkingBook
            key={keyOf(w)}
            w={w}
            paused={paused || !m.settings.tasks[w.task]}
            open={open === keyOf(w)}
            onOpen={() => setOpen(open === keyOf(w) ? null : keyOf(w))}
            admin={admin}
          />
        ))}
      </div>

      <Label side={<span className="ad-count">{m.queue.length}</span>}>Waiting</Label>
      {m.queue.length > 0 && (
        <Seg
          label="Show"
          value={filter}
          onChange={setFilter}
          options={[
            { v: 'all', label: `All ${counts.all}` },
            { v: 'marks', label: `Marks ${counts.marks}` },
            { v: 'music', label: `Music ${counts.music}` },
            { v: 'notes', label: `Notes ${counts.notes}` },
          ]}
        />
      )}
      {!shown.length && <p className="ad-none">Nothing.</p>}
      <ol className="ad-queue">
        {shown.map((q) => (
          <QueueRow key={keyOf(q)} q={q} first={m.queue.find((x) => x.task === q.task) === q} off={!m.settings.tasks[q.task]} admin={admin} />
        ))}
      </ol>
    </section>
  );
}

/** A book being worked on: one line, and opened, every step of its task. */
function WorkingBook({ w, paused, open, onOpen, admin }: { w: Working; paused: boolean; open: boolean; onOpen: () => void; admin: Admin }) {
  const all = stepsFor(w);
  const steps = all.filter((s) => !w.skipped.includes(s.key));
  const at = Math.max(0, steps.findIndex((s) => s.key === w.step));
  const step = steps[at];
  const tone = toneOf(w.title);
  const percent = percentOf(w);
  let where = step.name;
  if (w.parts.length) {
    const done = w.parts.filter((p) => p === 'done' || p === 'backup').length;
    where += ` · ${done}/${w.parts.length}`;
  }

  return (
    <article className={`ad-work${open ? ' is-open' : ''}${paused ? ' is-paused' : ''}`}>
      <button type="button" className="ad-work-h" aria-expanded={open} onClick={onOpen}>
        <Monogram title={w.title} />
        <span className="ad-work-t">
          <b>{w.title}</b>
          <span>{TASK_NAMES[w.task]} · {where}</span>
          <Percent value={percent} tone={tone} label={`${w.title}: ${percent}%`} />
        </span>
        <span className="ad-pct">{percent}%</span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div key="more" className="ad-fold" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={springs.snappy}>
            <div className="ad-work-b">
              <ol className="ad-steps">
                {all.map((s) => {
                  const skipped = w.skipped.includes(s.key);
                  const i = steps.findIndex((x) => x.key === s.key);
                  let state = 'next';
                  if (skipped) state = 'skip';
                  else if (i < at) state = 'done';
                  else if (i === at) state = 'now';
                  return (
                    <li key={s.key} className={`is-${state}`} title={s.about}>
                      <i aria-hidden="true" />
                      <div>
                        <b>{s.name}</b>
                        {state === 'skip' && <span className="ad-dim"> · skipped</span>}
                        {state === 'now' && (
                          <div className="ad-now">
                            <p className="ad-meta">
                              {paused ? 'Paused' : span((Date.now() - new Date(w.stepSince).getTime()) / 1000)}
                              {w.model && ` · ${modelName(w.model)}`}
                              {w.account && ` · ${w.account}`}
                              {w.calls > 0 && !paused && ` · ${w.calls} in flight`}
                            </p>
                            {w.parts.length > 0 && (
                              <>
                                <PartDots parts={w.parts} tone={tone} />
                                <p className="ad-key">
                                  <span><i className="is-done" />done</span>
                                  <span><i className="is-now" />now</span>
                                  {w.task === 'marks' && <span><i className="is-backup" />backup model</span>}
                                  <span><i className="is-wait" />to do</span>
                                </p>
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ol>
              <div className="ad-log">
                <Label side={<span className="ad-dim">{ago(w.since)}</span>}>Log</Label>
                <ol>
                  {w.log.slice(0, 8).map((l, i) => (
                    <li key={`${l.at}.${i}`} className={l.bad ? 'is-bad' : undefined}>
                      <time>{ago(l.at)}</time>
                      <span>{l.text}</span>
                    </li>
                  ))}
                </ol>
              </div>
              <div className="ad-acts">
                <button type="button" className="btn btn-quiet ad-small" onClick={() => admin.redoStep(w.id, w.task)}>Redo step</button>
                <button type="button" className="btn btn-ghost ad-small" onClick={() => admin.stop(w.id, w.task)}>Stop</button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </article>
  );
}

/** A waiting book, with why it's waiting and what can be done about it. */
function QueueRow({ q, first, off, admin }: { q: Waiting; first: boolean; off: boolean; admin: Admin }) {
  let why: string | null = null;
  if (q.held) why = 'Kept back';
  else if (off) why = 'Switched off';
  else if (q.waitsFor) why = `Waits for ${q.waitsFor}`;
  return (
    <li className={`ad-q${q.held ? ' is-held' : ''}`}>
      <Monogram title={q.title} size="s" />
      <div className="ad-q-t">
        <b>{q.title}</b>
        <span className="ad-chip">{TASK_NAMES[q.task]}</span>
        {why && <p className="ad-dim">{why}</p>}
        {q.failed && (
          <p className="ad-bad ad-one" title={q.failed.why}>
            Failed ×{q.failed.times} · again {until(q.failed.next)} · {q.failed.why}
          </p>
        )}
      </div>
      <div className="ad-q-acts">
        {q.failed && <button type="button" className="btn btn-primary ad-small" onClick={() => admin.retry(q.id, q.task)}>Try now</button>}
        {!first && !q.failed && <button type="button" className="btn btn-quiet ad-small" onClick={() => admin.next(q.id, q.task)}>Do next</button>}
        <button type="button" className="btn btn-ghost ad-small" onClick={() => admin.hold(q.id, q.task, !q.held)}>
          {q.held ? 'Let go' : 'Keep back'}
        </button>
      </div>
    </li>
  );
}

const RETRY_CAPS = [15, 60, 360];

/** How the marker works, to change from here. */
function Settings({ s, onChange }: { s: MarkerSettings; onChange: (patch: Partial<MarkerSettings>) => void }) {
  const tasks: Task[] = ['marks', 'music', 'notes'];
  return (
    <div className="ad-set">
      <div className="ad-set-row is-head">
        <span />
        <span className="ad-dim">On</span>
        <span className="ad-dim">At once</span>
      </div>
      {tasks.map((t) => (
        <div key={t} className="ad-set-row">
          <span>{TASK_NAMES[t]}</span>
          <Switch on={s.tasks[t]} label={`${TASK_NAMES[t]} on`} onChange={(on) => onChange({ tasks: { ...s.tasks, [t]: on } })} />
          <Stepper value={s.atOnce[t]} min={1} max={8} label={`${TASK_NAMES[t]}: books at once`} onChange={(n) => onChange({ atOnce: { ...s.atOnce, [t]: n } })} />
        </div>
      ))}
      <div className="ad-set-line">
        <b>First model</b>
        <Seg label="First model" value={s.first} onChange={(v) => onChange({ first: v })} options={[{ v: 'kimi-k3', label: 'Kimi K3' }, { v: 'nemotron', label: 'Nemotron' }]} />
      </div>
      <div className="ad-set-line">
        <b>Web research</b>
        <Switch on={s.research} label="Research on the web first" onChange={(on) => onChange({ research: on })} />
      </div>
      <div className="ad-set-line">
        <b>Longest retry wait</b>
        <Seg
          label="Longest wait"
          value={String(s.retryCapMinutes)}
          onChange={(v) => onChange({ retryCapMinutes: Number(v) })}
          options={RETRY_CAPS.map((n) => ({ v: String(n), label: span(n * 60) }))}
        />
      </div>
    </div>
  );
}
