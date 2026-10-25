import type { AiAccount } from '@breader/shared/accounts';
import { modelName } from './format';
import { STEPS, type Admin, type Job, type Marker, type MarkerSettings, type ModelLine, type Models, type PartState, type ReaderLine, type Snapshot, type Stage, type StagePick, type Status, type Task, type Waiting, type Working } from './types';

/*
 * A pretend server, in the page (admin/?demo): the marker working through its books, step by step and
 * part by part, pushed to the page as it goes, the way the real one will push it (a stream from
 * the server, not a look every few seconds). Every button does what it says, here.
 *
 * Scenes: all well, trouble (a failing backup, a book that keeps failing, Gemini out, an account
 * signed out), and quiet (nothing left to do).
 */

export type Scene = 'well' | 'trouble' | 'quiet';

/** How often the pretend marker moves on. */
const TICK_MS = 900;

const at = (secondsFromNow: number) => new Date(Date.now() + secondsFromNow * 1000).toISOString();

interface Book {
  id: string;
  title: string;
  parts: number;
}

const BOOKS: Book[] = [
  { id: 'b01', title: 'Mushoku Tensei: Jobless Reincarnation Vol. 9', parts: 31 },
  { id: 'b02', title: 'Mushoku Tensei: Jobless Reincarnation Vol. 10', parts: 28 },
  { id: 'b03', title: 'Mushoku Tensei: Jobless Reincarnation Vol. 11', parts: 33 },
  { id: 'b04', title: 'The Irregular at Magic High School Vol. 4', parts: 26 },
  { id: 'b05', title: 'The Irregular at Magic High School Vol. 5', parts: 24 },
  { id: 'b06', title: 'The Empty Box and Zeroth Maria Vol. 7', parts: 18 },
  { id: 'b07', title: 'The Apothecary Diaries Vol. 3', parts: 22 },
  { id: 'b08', title: 'Pride and Prejudice', parts: 61 },
  { id: 'b09', title: 'Alice’s Adventures in Wonderland', parts: 12 },
  { id: 'b10', title: 'The Time Machine', parts: 16 },
  { id: 'b11', title: 'Spice and Wolf Vol. 2', parts: 20 },
];
const book = (id: string) => BOOKS.find((b) => b.id === id)!;
/** A volume waiting for the one before it in its series, by id. */
const AFTER: Record<string, string> = { b03: 'b02' };

/** NVIDIA's models as a day of checks might find them: answered of 7, seconds to start, tokens a second. */
const NIM: Array<[string, number, number, number]> = [
  ['moonshotai/kimi-k2.6', 7, 4.1, 62],
  ['nvidia/nemotron-3-ultra-550b-a55b', 7, 2.3, 48],
  ['z-ai/glm-5.3', 6, 1.8, 91],
  ['z-ai/glm-5.3-flash', 7, 0.6, 184],
  ['deepseek-ai/deepseek-v4.1-flash', 5, 9.4, 70],
  ['minimaxai/minimax-m3.1-flash', 7, 1.1, 132],
  ['stepfun-ai/step-5-preview', 3, 22, 40],
  ['nvidia/nemotron-3-super-120b-a12b', 7, 0.9, 150],
  ['openai/gpt-oss-20b', 7, 0.4, 260],
  ['moonshotai/kimi-k3', 0, 0, 0],
  ['nvidia/nv-embedqa-mistral-7b-v2', 0, 0, 0],
];

function modelsFor(): Models {
  const day = 86_400;
  const models: ModelLine[] = NIM.map(([id, ok, firstS, tps], i) => {
    const line: ModelLine = { id, seenAt: at(-30 * day), checks: [] };
    if (id.includes('embed')) return { ...line, noChat: true };
    if (id === 'moonshotai/kimi-k3') {
      line.checks = [{ at: at(-3 * 3600), ok: false, kind: 'gone', why: 'HTTP 410 The model has reached its end of life' }];
      return line;
    }
    if (id === 'stepfun-ai/step-5-preview') line.seenAt = at(-2 * day);
    for (let d = 0; d < 7; d++) {
      const up = d >= 7 - ok;
      const wobble = 1 + ((i + d) % 3) * 0.12;
      line.checks.push(up ? { at: at(-d * day - 3600 - i * 20), ok: true, firstS: Math.round(firstS * wobble * 10) / 10, tps: Math.round(tps / wobble) } : { at: at(-d * day - 3600), ok: false, kind: 'busy', why: 'HTTP 503 overloaded' });
    }
    return line;
  });
  return { firstListAt: at(-40 * day), listedAt: at(-3600), sweptAt: at(-3000), checking: null, models, gemini: ['gemini-4-argon', 'gemini-3.8-pro-high', 'gemini-3.8-flash-high', 'gemini-3.8-flash-low', 'gemini-3.1-pro-high'] };
}

/** The steps a book goes through this time, without the ones it skips. */
const stepsOf = (w: Working) => STEPS[w.task].filter((s) => !w.skipped.includes(s.key));

function startWorking(id: string, task: Task, settings: MarkerSettings): Working {
  const skipped: string[] = [];
  if (!settings.research) skipped.push('research');
  const first = STEPS[task][0];
  return {
    id,
    title: book(id).title,
    task,
    step: first.key,
    skipped,
    since: at(0),
    stepSince: at(0),
    parts: [],
    model: null,
    account: null,
    calls: 0,
    log: [{ at: at(0), text: `Started: ${first.name.toLowerCase()}` }],
  };
}

/** A book partway through, for a scene to start with. */
function partway(id: string, task: Task, step: string, done: number, settings: MarkerSettings, minutes: number): Working {
  const w = startWorking(id, task, settings);
  w.since = at(-minutes * 60);
  w.stepSince = at(-minutes * 20);
  w.step = step;
  const s = STEPS[task].find((x) => x.key === step)!;
  if (s.parts) {
    const parts: PartState[] = [];
    for (let i = 0; i < book(id).parts; i++) {
      if (i < done) {
        if (i % 7 === 3 && task === 'marks') parts.push('backup');
        else parts.push('done');
      } else if (i === done) parts.push('now');
      else parts.push('wait');
    }
    w.parts = parts;
  }
  w.log = [
    { at: at(-30), text: `Part ${done} done by Kimi K2.6` },
    { at: at(-75), text: `Part ${done - 1} done by Kimi K2.6` },
    { at: at(-minutes * 20), text: `Started: ${s.name.toLowerCase()}` },
    { at: at(-minutes * 60), text: 'Started: fetching the book' },
  ];
  return w;
}

const SETTINGS: MarkerSettings = {
  paused: false,
  tasks: { marks: true, music: true, notes: true },
  atOnce: { marks: 4, music: 2, notes: 2 },
  first: 'moonshotai/kimi-k2.6',
  second: 'nvidia/nemotron-3-ultra-550b-a55b',
  research: true,
  retryCapMinutes: 60,
};

function job(name: string, okAgo: number | null, error?: { why: string; ago: number }): Job {
  return {
    name,
    last_ok_at: okAgo === null ? null : at(-okAgo),
    last_error: error ? error.why : null,
    last_error_at: error ? at(-error.ago) : null,
    running: false,
    off: false,
  };
}

function statusFor(scene: Scene): Status {
  const backup = scene === 'trouble'
    ? job('backup', 26 * 3600, { why: 'R2 refused the upload: 403 Forbidden (the backups token may have expired)', ago: 2 * 3600 })
    : job('backup', 2 * 3600);
  return {
    server: { role: 'laptop', release: '8a6465d', uptimeSeconds: 3 * 86400 + 4 * 3600, sentry: true },
    request: { ip: '49.36.112.18', from: 'cf-connecting-ip', headers: { 'cf-connecting-ip': '49.36.112.18', 'x-forwarded-for': '49.36.112.18' } },
    supabase: { bytes: 61 * 1024 ** 2, freeBytes: 500 * 1024 ** 2, timeline: '2026-09-27T01:08:00Z' },
    feed: { rows: 1840, unread: scene === 'trouble' ? 37 : 0, oldest_unread: scene === 'trouble' ? 840 : null, ack: scene === 'trouble' ? 900 : 12 },
    copy: { lag: scene === 'trouble' ? 214 : 6, loaded_at: at(-5 * 86400) },
    libraries: { total: 14, key_only: 9, active_week: 5, expiring: 1, retired: 2 },
    books: { books: 342, removed: 6 },
    files: {
      byStatus: [
        { status: 'ready', files: 1203, bytes: 2.4 * 1024 ** 3, unused: 3 },
        { status: 'pending', files: 2, bytes: 18 * 1024 ** 2, unused: 0 },
      ],
      freeBytes: 10 * 1024 ** 3,
    },
    jobs: [
      backup,
      job('restore-drill', 5 * 86400),
      job('clean-up', 7 * 3600),
      job('storage-check', 40 * 60),
      job('extensions', 9 * 3600),
      job('manga-prefetch', 20 * 60),
      job('manga-keep', 10 * 60),
      job('ai-fill', 30 * 60),
      job('ai-marker', 10),
      job('yt-dlp', 30 * 3600),
    ],
  };
}

function markerFor(scene: Scene): Marker | null {
  const settings = structuredClone(SETTINGS);
  if (scene === 'quiet') {
    return { at: at(0), books: 41, finished: 41, working: [], queue: [], settings };
  }
  const working = [
    partway('b01', 'marks', 'mark', 14, settings, 22),
    partway('b04', 'marks', 'mark', 5, settings, 9),
    partway('b06', 'notes', 'write', 11, settings, 31),
  ];
  const queue: Waiting[] = [
    { id: 'b02', title: book('b02').title, task: 'marks' },
    { id: 'b03', title: book('b03').title, task: 'marks', waitsFor: 'Vol. 10 first: the series goes in order' },
    { id: 'b08', title: book('b08').title, task: 'music' },
    { id: 'b09', title: book('b09').title, task: 'music' },
    { id: 'b10', title: book('b10').title, task: 'notes', first: ['ana@example.com'] },
    { id: 'b07', title: book('b07').title, task: 'notes' },
    { id: 'b11', title: book('b11').title, task: 'notes' },
  ];
  const line = (id: string) => ({ id, title: book(id).title });
  const readers: ReaderLine[] = [
    { id: 'lib-ana', name: 'ana@example.com', books: [line('b10'), line('b02'), line('b03')], first: 'b10', by: 'reader', page: null, picked: 'b10' },
    { id: 'lib-kai', name: 'kai@example.com', books: [line('b07'), line('b11')], first: null, by: null, page: null, picked: null },
  ];
  const marker: Marker = { at: at(0), books: 41, finished: 33, working, queue, readers, settings, stages: {}, stagesFor: {}, models: modelsFor() };
  if (scene === 'trouble') {
    queue[4].failed = { times: 3, next: at(95), why: 'Kimi K2.6’s answer for part 9 didn’t parse: it stopped halfway through a line.' };
    marker.limitedUntil = at(2 * 3600 + 14 * 60);
    queue[2].waitsFor = 'Gemini, which every Antigravity account is out of for now';
    queue[3].waitsFor = 'Gemini, which every Antigravity account is out of for now';
  }
  return marker;
}

function accountsFor(scene: Scene): AiAccount[] {
  const first: AiAccount = {
    id: 'antigravity-first.json',
    kind: 'antigravity',
    name: 'first.reader@gmail.com',
    problem: null,
    priority: 0,
    usage: [
      { label: '5 hours', usedPercent: 38, resetsAt: at(2 * 3600 + 40 * 60) },
      { label: 'Week', usedPercent: 61, resetsAt: at(3 * 86400) },
    ],
  };
  const second: AiAccount = {
    id: 'antigravity-second.json',
    kind: 'antigravity',
    name: 'second.reader@gmail.com',
    problem: null,
    priority: 0,
    usage: [
      { label: '5 hours', usedPercent: 4, resetsAt: at(4 * 3600) },
      { label: 'Week', usedPercent: 22, resetsAt: at(5 * 86400) },
    ],
  };
  const claude: AiAccount = {
    id: 'claude-team.json',
    kind: 'claude',
    name: 'studio@anchor.example',
    problem: null,
    priority: 0,
    usage: [
      { label: '5 hours', usedPercent: 12, resetsAt: at(3 * 3600) },
      { label: 'Week', usedPercent: 47, resetsAt: at(2 * 86400) },
    ],
  };
  if (scene === 'trouble') {
    first.usage = [
      { label: '5 hours', usedPercent: 100, resetsAt: at(2 * 3600 + 14 * 60) },
      { label: 'Week', usedPercent: 88, resetsAt: at(3 * 86400) },
    ];
    second.problem = 'Signed out: Google asked it to sign in again. Remove it and connect it again.';
    second.usage = null;
  }
  return [first, second, claude];
}

export function demoAdmin(scene: Scene): Admin {
  const status = statusFor(scene);
  const marker = markerFor(scene);
  let accounts = accountsFor(scene);
  /** Ticks left in each working book's step that doesn't go part by part, by book and task. */
  const left = new Map<string, number>();
  /** Ticks left on each job run by hand. */
  const runs = new Map<string, number>();
  const watchers = new Set<(s: Snapshot) => void>();
  let timer = 0;

  const snapshot = (): Snapshot => structuredClone({ status, marker, accounts });
  const push = () => {
    const s = snapshot();
    watchers.forEach((on) => on(s));
  };
  const keyOf = (id: string, task: Task) => `${id}:${task}`;

  const say = (w: Working, text: string, bad = false) => {
    w.log = [{ at: at(0), text, bad }, ...w.log].slice(0, 40);
  };

  /** Who does a step: Gemini on an Antigravity account for the web, else the first model on NVIDIA. */
  const crewFor = (w: Working) => {
    const m = marker!;
    if (w.step === 'research' || w.step === 'gather') {
      const free = accounts.find((a) => a.kind === 'antigravity' && !a.problem && (a.usage?.[0]?.usedPercent ?? 0) < 100);
      w.model = 'Gemini 3 Pro';
      w.account = free ? free.name : null;
      return;
    }
    const thinking = ['cast', 'mark', 'check', 'redo', 'settle', 'plan', 'score', 'roster', 'write', 'review'];
    if (thinking.includes(w.step)) {
      w.model = modelName(m.settings.first);
      w.account = 'NVIDIA';
      return;
    }
    w.model = null;
    w.account = null;
  };

  /** Into a step: its parts laid out, or a few ticks to take. */
  const enter = (w: Working, key: string) => {
    w.step = key;
    w.stepSince = at(0);
    const s = STEPS[w.task].find((x) => x.key === key)!;
    if (key === 'redo') {
      const again = w.parts.filter((p) => p === 'backup').length;
      if (!again) {
        next(w);
        return;
      }
      w.parts = w.parts.map((p) => (p === 'backup' ? 'wait' : 'done'));
      say(w, `Started: marking again the ${again} parts Nemotron did`);
    } else if (s.parts) {
      w.parts = Array.from({ length: book(w.id).parts }, () => 'wait' as PartState);
      say(w, `Started: ${s.name.toLowerCase()}`);
    } else {
      w.parts = [];
      left.set(keyOf(w.id, w.task), 3 + Math.floor(Math.random() * 4));
      say(w, `Started: ${s.name.toLowerCase()}`);
    }
    crewFor(w);
  };

  /** On to the next step, or done with the book. */
  const next = (w: Working) => {
    const steps = stepsOf(w);
    const i = steps.findIndex((s) => s.key === w.step);
    const after = steps[i + 1];
    if (after) {
      enter(w, after.key);
      return;
    }
    const m = marker!;
    m.working = m.working.filter((x) => x !== w);
    if (w.task === 'notes' && m.finished < m.books) m.finished++;
    for (const q of m.queue) {
      if (AFTER[q.id] === w.id && q.task === w.task) delete q.waitsFor;
    }
  };

  /** A step done part by part: the part being done finishes, and the next one starts. */
  const onPart = (w: Working) => {
    const now = w.parts.indexOf('now');
    if (now >= 0) {
      let done: PartState = 'done';
      let by = w.model ?? 'the model';
      // While Kimi is busy, Nemotron takes the odd part, to be marked again later.
      if (w.step === 'mark' && Math.random() < 0.12) {
        done = 'backup';
        by = 'Nemotron 3 Ultra, as Kimi K2.6 was busy';
      }
      w.parts[now] = done;
      say(w, `Part ${now + 1} done by ${by}`);
    }
    const waiting = w.parts.indexOf('wait');
    if (waiting < 0) {
      next(w);
      return;
    }
    w.parts[waiting] = 'now';
    w.calls = 1 + Math.floor(Math.random() * 6);
  };

  /** Starts books from the queue while each task has room, as the settings allow. */
  const fill = () => {
    const m = marker!;
    for (const task of ['marks', 'music', 'notes'] as Task[]) {
      if (!m.settings.tasks[task]) continue;
      let busy = m.working.filter((w) => w.task === task).length;
      for (const q of [...m.queue]) {
        if (busy >= m.settings.atOnce[task]) break;
        if (q.task !== task || q.held || q.waitsFor) continue;
        if (q.failed && new Date(q.failed.next).getTime() > Date.now()) continue;
        m.queue = m.queue.filter((x) => x !== q);
        const w = startWorking(q.id, q.task, m.settings);
        m.working.push(w);
        enter(w, w.step);
        busy++;
      }
    }
  };

  const tick = () => {
    status.server.uptimeSeconds += TICK_MS / 1000;
    for (const [name, n] of runs) {
      const j = status.jobs.find((x) => x.name === name)!;
      if (n > 1) {
        runs.set(name, n - 1);
        continue;
      }
      runs.delete(name);
      j.running = false;
      j.last_ok_at = at(0);
    }
    const m = marker;
    if (m) {
      m.at = at(0);
      status.jobs.find((j) => j.name === 'ai-marker')!.last_ok_at = at(0);
      if (!m.settings.paused) {
        for (const w of [...m.working]) {
          if (!m.settings.tasks[w.task]) continue;
          const s = STEPS[w.task].find((x) => x.key === w.step)!;
          if (s.parts || w.step === 'redo') {
            // About one part every other tick, so a book takes a minute or two to watch.
            if (Math.random() < 0.55) onPart(w);
            continue;
          }
          const k = keyOf(w.id, w.task);
          const n = (left.get(k) ?? 1) - 1;
          left.set(k, n);
          if (n <= 0) next(w);
        }
        fill();
      }
    }
    // The first Antigravity account fills a little as it's used.
    const first = accounts.find((a) => a.kind === 'antigravity');
    const used = first?.usage?.[0];
    if (used && used.usedPercent < 100) used.usedPercent = Math.min(100, used.usedPercent + 0.15);
    push();
  };

  /** A working book or a waiting one, by book and task. */
  const working = (id: string, task: Task) => marker?.working.find((w) => w.id === id && w.task === task);
  const waiting = (id: string, task: Task) => marker?.queue.find((q) => q.id === id && q.task === task);
  const toFront = (q: Waiting) => {
    const m = marker!;
    m.queue = [q, ...m.queue.filter((x) => x !== q)];
  };

  return {
    watch(on, link) {
      watchers.add(on);
      on(snapshot());
      link?.('live');
      if (!timer) timer = window.setInterval(tick, TICK_MS);
      return () => {
        watchers.delete(on);
        if (!watchers.size) {
          window.clearInterval(timer);
          timer = 0;
        }
      };
    },
    settings(patch) {
      if (!marker) return;
      marker.settings = { ...marker.settings, ...patch };
      push();
    },
    stages(picks, ids) {
      if (!marker) return;
      const put = (into: Partial<Record<Stage, StagePick>>) => {
        const out = { ...into };
        for (const [k, v] of Object.entries(picks) as Array<[Stage, StagePick | null]>) {
          if (v) out[k] = v;
          else delete out[k];
        }
        return out;
      };
      if (!ids) marker.stages = put(marker.stages ?? {});
      else {
        const all = { ...marker.stagesFor };
        for (const id of ids) {
          const mine = put(all[id] ?? {});
          if (Object.keys(mine).length) all[id] = mine;
          else delete all[id];
        }
        marker.stagesFor = all;
      }
      push();
    },
    checkModels(id) {
      const ms = marker?.models;
      if (!ms) return;
      const line = ms.models.find((x) => x.id === (id ?? 'moonshotai/kimi-k2.6'));
      if (!line) return;
      ms.checking = line.id;
      push();
      window.setTimeout(() => {
        ms.checking = null;
        if (!line.goneAt) line.checks = [{ at: at(0), ok: true, firstS: 1.2, tps: 120 }, ...line.checks].slice(0, 7);
        if (!id) ms.sweptAt = at(0);
        push();
      }, 1500);
    },
    next(id, task) {
      const q = waiting(id, task);
      if (!q) return;
      toFront(q);
      push();
    },
    hold(id, task, held) {
      const q = waiting(id, task);
      if (!q) return;
      q.held = held;
      push();
    },
    retry(id, task) {
      const q = waiting(id, task);
      if (!q) return;
      delete q.failed;
      toFront(q);
      push();
    },
    stop(id, task) {
      const w = working(id, task);
      if (!w || !marker) return;
      marker.working = marker.working.filter((x) => x !== w);
      marker.queue = [{ id: w.id, title: w.title, task: w.task, held: true }, ...marker.queue];
      push();
    },
    first(library, id) {
      const r = marker?.readers?.find((x) => x.id === library);
      if (!r || !marker) return;
      const was = r.first;
      r.page = id;
      r.first = id ?? r.picked;
      r.by = id ? 'page' : r.picked ? 'reader' : null;
      for (const q of marker.queue) {
        const others = (q.first ?? []).filter((n) => n !== r.name);
        if (q.id === r.first) others.push(r.name);
        if (others.length) q.first = others;
        else delete q.first;
      }
      if (r.first && r.first !== was) {
        for (const q of marker.queue.filter((x) => x.id === r.first)) toFront(q);
      }
      push();
    },
    redoStep(id, task) {
      const w = working(id, task);
      if (!w) return;
      const s = STEPS[task].find((x) => x.key === w.step)!;
      say(w, `${s.name}: started again, from here`);
      enter(w, w.step);
      push();
    },
    runJob(name) {
      const j = status.jobs.find((x) => x.name === name);
      if (!j || j.running) return;
      j.running = true;
      runs.set(name, 4);
      push();
    },
    jobOn(name, on) {
      const j = status.jobs.find((x) => x.name === name);
      if (!j) return;
      j.off = !on;
      push();
    },
    useFirst(id) {
      const a = accounts.find((x) => x.id === id);
      if (!a) return;
      accounts = [a, ...accounts.filter((x) => x !== a)];
      push();
    },
    async removeAccount(id) {
      accounts = accounts.filter((a) => a.id !== id);
      push();
    },
    async startSignIn(kind) {
      return { url: `https://example.com/sign-in/${kind}`, state: `demo-${kind}-${Date.now()}` };
    },
    async finishSignIn(state, address) {
      if (!address.startsWith('http://localhost')) {
        throw new Error('That isn’t the address the sign-in ended on. It starts with http://localhost.');
      }
      await new Promise((r) => window.setTimeout(r, 1200));
      const kind = state.split('-')[1];
      accounts = [...accounts, {
        id: `${kind}-new-${Date.now()}.json`,
        kind,
        name: 'new.reader@gmail.com',
        problem: null,
        priority: 0,
        usage: [
          { label: '5 hours', usedPercent: 0, resetsAt: null },
          { label: 'Week', usedPercent: 0, resetsAt: null },
        ],
      }];
      if (marker && kind === 'antigravity') {
        delete marker.limitedUntil;
        for (const q of marker.queue) {
          if (q.waitsFor?.startsWith('Gemini')) delete q.waitsFor;
        }
      }
      push();
    },
    async uploadMusic(text) {
      let music: { sha256?: string; score?: { cues?: unknown[]; tracks?: unknown[] }; soundtrack?: { tracks?: unknown[] } };
      try {
        music = JSON.parse(text);
      } catch {
        throw new Error('That file isn’t JSON.');
      }
      if (!music.sha256 || !music.score) throw new Error('That isn’t a book’s music: it has no sha256 or no score.');
      const cues = music.score.cues?.length ?? 0;
      const tracks = music.score.tracks?.length ?? 0;
      const soundtrack = music.soundtrack?.tracks?.length ?? 0;
      return `${cues} cues playing ${tracks} tracks, from a soundtrack of ${soundtrack}. The marker takes it within a minute or two.`;
    },
  };
}
