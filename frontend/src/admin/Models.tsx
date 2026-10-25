import { useMemo, useState } from 'react';
import { Modal } from '../components/Modal';
import { ago, modelName } from './format';
import { Dots, Seg } from './parts';
import { pickable, statsLine, statsOf } from './stats';
import { STAGES, stageStep, TASK_NAMES, TOOL_STAGES, type Admin, type Marker, type ModelLine, type Stage, type StagePick, type Task } from './types';

/*
 * Which models the marker asks: NVIDIA's, as it checks them once a day (ai/tools/models.ts), to
 * pick its first and second from; and who does each stage of the pipeline, NVIDIA or Gemini, for
 * one book, the books waiting now, or the books to come.
 */

/** Days a model counts as new after it first shows up in NVIDIA's list. */
const NEW_DAYS = 7;

const isNew = (m: ModelLine, firstListAt: string | null) =>
  !!firstListAt && Date.parse(m.seenAt) > Date.parse(firstListAt) + 60_000 && Date.now() - Date.parse(m.seenAt) < NEW_DAYS * 86_400_000;

type Sort = 'fast' | 'start' | 'name' | 'new';
type Show = 'up' | 'all';

/** Every NVIDIA model, how each did in its checks, and the marker's first and second picked here. */
export function ModelsDialog({ m, admin, onClose }: { m: Marker; admin: Admin; onClose: () => void }) {
  const [sort, setSort] = useState<Sort>('fast');
  const [show, setShow] = useState<Show>('up');
  const ms = m.models;
  const first = m.settings.first;
  const second = m.settings.second;

  const lines = useMemo(() => {
    const all = (ms?.models ?? []).filter((x) => show === 'all' || (pickable(x) && (!x.checks.length || x.checks.some((c) => c.ok))));
    const st = new Map(all.map((x) => [x.id, statsOf(x)]));
    const by: Record<Sort, (a: ModelLine, b: ModelLine) => number> = {
      fast: (a, b) => (st.get(b.id)!.tps ?? -1) - (st.get(a.id)!.tps ?? -1),
      start: (a, b) => (st.get(a.id)!.firstS ?? Infinity) - (st.get(b.id)!.firstS ?? Infinity),
      name: (a, b) => a.id.localeCompare(b.id),
      new: (a, b) => b.seenAt.localeCompare(a.seenAt) || a.id.localeCompare(b.id),
    };
    // The two in use stay on top, whatever the order.
    const rank = (x: ModelLine) => (x.id === first ? 0 : x.id === second ? 1 : 2);
    return all.sort((a, b) => rank(a) - rank(b) || by[sort](a, b)).map((x) => ({ x, s: st.get(x.id)! }));
  }, [ms, show, sort, first, second]);

  let when = 'Not checked yet: the marker checks them once it starts.';
  if (ms?.sweptAt) when = `All checked ${ago(ms.sweptAt)}; again once a day.`;
  else if (ms?.listedAt) when = 'The first check is going now.';

  return (
    <Modal title="NVIDIA models" onClose={onClose} width={760} className="adm-modal">
      <div className="adm-mods">
        <div className="adm-mods-h">
          <p className="adm-dim">
            {ms ? `${ms.models.filter(pickable).length} that chat, of ${ms.models.length} NVIDIA lists. ` : 'The marker hasn’t said yet. '}
            {when}
            {ms?.checking && <><br />Asking {modelName(ms.checking)} now…</>}
          </p>
          <button type="button" className="btn btn-quiet adm-small" disabled={!ms || !!ms.checking} onClick={() => admin.checkModels()}>
            Check all now
          </button>
        </div>
        <div className="adm-mods-f">
          <Seg label="Show" value={show} onChange={setShow} options={[{ v: 'up', label: 'Answering' }, { v: 'all', label: 'All' }]} />
          <Seg label="Order" value={sort} onChange={setSort} options={[{ v: 'fast', label: 'Fastest' }, { v: 'start', label: 'Quickest start' }, { v: 'new', label: 'Newest' }, { v: 'name', label: 'Name' }]} />
        </div>
        {!lines.length && <p className="adm-none">Nothing to show yet.</p>}
        <ul className="adm-mods-l">
          {lines.map(({ x, s }) => {
            const bad = s.last && !s.last.ok;
            return (
              <li key={x.id} className={`adm-mod${x.id === first || x.id === second ? ' is-used' : ''}`}>
                <div className="adm-mod-t">
                  <b title={x.id}>{modelName(x.id)}</b>
                  <span className="adm-chips">
                    {x.id === first && <span className="adm-chip is-first">First</span>}
                    {x.id === second && <span className="adm-chip is-first">Second</span>}
                    {isNew(x, ms?.firstListAt ?? null) && <span className="adm-chip">New</span>}
                    {x.goneAt && <span className="adm-chip">Gone</span>}
                    {x.noChat && <span className="adm-chip">Doesn’t chat</span>}
                  </span>
                  <span className="adm-dim adm-one">{x.id}</span>
                  {!x.noChat && (
                    <p className={bad ? 'adm-bad adm-one' : 'adm-dim'} title={bad ? s.last?.why : undefined}>
                      {statsLine(s)}
                      {s.last && ` · last ${ago(s.last.at)}`}
                      {bad && `: ${s.last?.why}`}
                    </p>
                  )}
                  {s.of > 0 && <Dots on={s.ok} of={s.of} bad={s.ok < s.of} label={`${modelName(x.id)}: answered ${s.ok} of ${s.of}`} />}
                </div>
                {pickable(x) && (
                  <div className="adm-mod-acts">
                    <button type="button" className="btn btn-quiet adm-small" disabled={x.id === first} onClick={() => admin.settings(x.id === second ? { first: x.id, second: first } : { first: x.id })}>First</button>
                    <button type="button" className="btn btn-quiet adm-small" disabled={x.id === second} onClick={() => admin.settings(x.id === first ? { first: second, second: x.id } : { second: x.id })}>Second</button>
                    <button type="button" className="btn btn-ghost adm-small" disabled={ms?.checking === x.id} onClick={() => admin.checkModels(x.id)}>
                      {ms?.checking === x.id ? 'Asking' : 'Check'}
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </Modal>
  );
}

/** A pick as the select holds it: "" for the usual, "nim:" or "gemini:" for the provider's usual, else "nim:<id>". */
const valueOf = (p: StagePick | null | undefined) => (p ? `${p.provider}:${p.model ?? ''}` : '');
function pickOf(v: string): StagePick | null {
  if (!v) return null;
  const [provider, ...rest] = v.split(':');
  const model = rest.join(':');
  return { provider: provider as StagePick['provider'], ...(model ? { model } : {}) };
}

/** Who does a stage when nothing is picked. */
function usual(stage: Stage, m: Marker): string {
  if (TOOL_STAGES.includes(stage)) return 'Gemini 3.8 Flash, then the newest';
  if (stage === 'marks.redo' || stage === 'notes.review') return modelName(m.settings.first);
  return `${modelName(m.settings.first)}, then ${modelName(m.settings.second)}`;
}

function pickName(p: StagePick | null | undefined, stage: Stage, m: Marker): string {
  if (!p) return usual(stage, m);
  if (p.model) return modelName(p.model);
  if (p.provider === 'gemini') return 'Gemini, usual order';
  return `NVIDIA: ${modelName(m.settings.first)}`;
}

type Scope = 'future' | 'queue';

/**
 * Every stage that asks a model, and who does it: for one book (`book`), or from the general
 * button, for the books to come or every book waiting or being worked on now.
 */
export function StagesDialog({ m, admin, book, onClose }: { m: Marker; admin: Admin; book?: { id: string; title: string }; onClose: () => void }) {
  const [scope, setScope] = useState<Scope>('future');
  const queueIds = useMemo(() => [...new Set([...m.working.map((w) => w.id), ...m.queue.map((q) => q.id)])], [m.working, m.queue]);
  // What was picked here for the books waiting now, since they may each have their own.
  const [forQueue, setForQueue] = useState<Partial<Record<Stage, string>>>({});

  const nim = (m.models?.models ?? []).filter(pickable).filter((x) => !x.checks.length || x.checks.some((c) => c.ok));
  const gemini = m.models?.gemini ?? [];
  const order: Array<{ task: Task | null; stages: Stage[] }> = [
    { task: null, stages: ['research'] },
    ...(['marks', 'music', 'notes'] as Task[]).map((t) => ({ task: t, stages: STAGES[t].filter((s) => s !== 'research') })),
  ];

  const valueFor = (stage: Stage) => {
    if (book) return valueOf(m.stagesFor?.[book.id]?.[stage]);
    if (scope === 'queue') return forQueue[stage] ?? '';
    return valueOf(m.stages?.[stage]);
  };
  const change = (stage: Stage, v: string) => {
    const picks = { [stage]: pickOf(v) };
    if (book) admin.stages(picks, [book.id]);
    else if (scope === 'queue') {
      setForQueue({ ...forQueue, [stage]: v });
      if (queueIds.length) admin.stages(picks, queueIds);
    } else admin.stages(picks);
  };
  /** What a stage falls back to, here: books to come's pick for a book, the usual for books to come. */
  const fallback = (stage: Stage) => {
    if (book || scope === 'queue') return `As books to come: ${pickName(m.stages?.[stage], stage, m)}`;
    return `Usual: ${usual(stage, m)}`;
  };

  let title = 'Who does each stage';
  if (book) title = `Stages · ${book.title}`;

  return (
    <Modal title={title} onClose={onClose} width={720} className="adm-modal">
      <div className="adm-stg">
        {!book && (
          <div className="adm-stg-h">
            <Seg
              label="For"
              value={scope}
              onChange={setScope}
              options={[
                { v: 'future', label: 'Books to come' },
                { v: 'queue', label: `In the queue now ${queueIds.length}` },
              ]}
            />
            <p className="adm-dim">
              {scope === 'future'
                ? 'Every book from its next stage on, unless it has a pick of its own.'
                : 'Each book waiting or being worked on now gets this pick as its own, over books to come. A stage already done isn’t done again.'}
            </p>
          </div>
        )}
        {book && <p className="adm-dim">This book only, over the picks for books to come. A stage already done isn’t done again.</p>}
        {order.map(({ task, stages }) => (
          <section key={task ?? 'all'} className="adm-stg-g">
            <h3 className="adm-stg-t">{task ? TASK_NAMES[task] : 'Every task'}</h3>
            {stages.map((stage) => {
              const step = stageStep(stage);
              const v = valueFor(stage);
              return (
                <div key={stage} className="adm-stg-r">
                  <div>
                    <b>{step.name}</b>
                    <span className="adm-dim">{TOOL_STAGES.includes(stage) ? `${step.about} Works with tools.` : step.about}</span>
                  </div>
                  <select className="adm-pick" aria-label={`${step.name}: model`} value={v} onChange={(e) => change(stage, e.target.value)}>
                    <option value="">{fallback(stage)}</option>
                    <optgroup label="NVIDIA">
                      <option value="nim:">First and second models</option>
                      {nim.map((x) => (
                        <option key={x.id} value={`nim:${x.id}`}>{modelName(x.id)} · {statsLine(statsOf(x))}</option>
                      ))}
                      {v.startsWith('nim:') && v !== 'nim:' && !nim.some((x) => `nim:${x.id}` === v) && <option value={v}>{modelName(v.slice(4))}</option>}
                    </optgroup>
                    <optgroup label="Gemini (Antigravity)">
                      <option value="gemini:">Gemini 3.8 Flash, then the newest</option>
                      {gemini.map((id) => (
                        <option key={id} value={`gemini:${id}`}>{modelName(id)}</option>
                      ))}
                      {v.startsWith('gemini:') && v !== 'gemini:' && !gemini.includes(v.slice(7)) && <option value={v}>{modelName(v.slice(7))}</option>}
                    </optgroup>
                  </select>
                </div>
              );
            })}
          </section>
        ))}
      </div>
    </Modal>
  );
}
