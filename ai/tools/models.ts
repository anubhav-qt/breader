import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type pg from 'pg';
import { recordLive } from '../../server/src/jobs/runs.ts';
import { jitter } from './balancer.ts';
import { control } from './control.ts';
import { readJson, WORK, writeJson } from './lib.ts';
import { CallError, chat, NIM_BASE, nvidiaKey, type Failure } from './nim.ts';
import { geminiModels, proxy } from './proxy.ts';

/*
 * NVIDIA's models, for the admin page to pick the marker's first and second from, and a stage's
 * (shared/src/admin.ts). Once a day the marker lists every model NVIDIA serves and asks each a
 * small question, one at a time with a pause between, so the page can say which answer and how
 * fast: the wait for the first token (mostly NVIDIA's queue) and tokens a second after it. The
 * models the page uses go first. The page can also ask for a look now, at all of them or one.
 *
 * It lists the Gemini models Antigravity serves through CLIProxyAPI too, every GEMINI_MS, for the
 * page to pick a stage's from; those are the accounts' own limits, so they aren't asked anything.
 *
 * What it found is kept in the work folder (_models.json), the last CHECKS_KEPT checks of each,
 * and goes to job_runs as "nim-models" for the page.
 */

const FILE = join(WORK, '_models.json');
export const JOB = 'nim-models';
const DAY_MS = 24 * 3600_000;
/** How often it looks whether a check is due, or asked for. */
const LOOK_MS = 5_000;
/** After a look that failed (NVIDIA's list down), the wait before the next. */
const FAILED_WAIT_MS = 30 * 60_000;
const GEMINI_MS = 3600_000;
/** The pause between two models' checks. */
const GAP_S = 15;
const CHECKS_KEPT = 14;
/** A model NVIDIA stopped listing is kept this long, as gone, then dropped. */
const GONE_KEPT_MS = 14 * DAY_MS;

/** What each check asks: short, with enough tokens to time. */
const ASK = 'Count from 1 to 40, numbers only, separated by spaces.';

/** Models that don't chat: embeddings, rerankers, guards, parsers and the like. Never asked. */
export const NOT_CHAT = /embed|rerank|retriever|reward|nvclip|parse|detector|safety|guard|topic-control|deplot|calibration/i;

export interface Check {
  at: string;
  ok: boolean;
  /** Why it failed (nim.ts). */
  kind?: Failure;
  why?: string;
  /** Seconds to the first token. */
  firstS?: number;
  secs?: number;
  /** Tokens a second once it started. */
  tps?: number;
}

export interface ModelLine {
  id: string;
  /** When it was first listed here. */
  seenAt: string;
  /** When NVIDIA stopped listing it. */
  goneAt?: string;
  /** Doesn't chat, so it's never asked. */
  noChat?: boolean;
  /** Newest first. */
  checks: Check[];
}

export interface Models {
  /** When NVIDIA's list was first read: models seen after it are new. */
  firstListAt: string | null;
  listedAt: string | null;
  /** When every model was last checked, start to end. */
  sweptAt: string | null;
  /** The model being asked now. */
  checking: string | null;
  models: ModelLine[];
  /** Antigravity's Gemini models, newest first, and when they were listed. */
  gemini?: string[];
  geminiAt?: string;
}

let state: Models = existsSync(FILE) ? readJson<Models>(FILE) : { firstListAt: null, listedAt: null, sweptAt: null, checking: null, models: [] };
state.checking = null;
/** What the page asked for: everything now, or these models. */
let askedAll = false;
const askedOne = new Set<string>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const round = (n: number) => Math.round(n * 10) / 10;

/** A look at every model now, or at one (the admin page's "Check now"). */
export function askModels(id?: string) {
  if (id) askedOne.add(id);
  else askedAll = true;
}

/** NVIDIA's list, into `state`. */
async function list(): Promise<void> {
  const res = await fetch(`${NIM_BASE}/models`, { headers: { Authorization: `Bearer ${nvidiaKey().key}` }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`NVIDIA's list: HTTP ${res.status}`);
  const body = (await res.json()) as { data?: Array<{ id?: string }> };
  const ids = new Set((body.data ?? []).map((m) => m.id ?? '').filter(Boolean));
  const now = new Date().toISOString();
  state.firstListAt ??= now;
  const byId = new Map(state.models.map((m) => [m.id, m]));
  for (const id of ids) {
    const m = byId.get(id);
    if (m) delete m.goneAt;
    else state.models.push({ id, seenAt: now, checks: [], ...(NOT_CHAT.test(id) ? { noChat: true } : {}) });
  }
  for (const m of state.models) if (!ids.has(m.id)) m.goneAt ??= now;
  state.models = state.models.filter((m) => !m.goneAt || Date.now() - Date.parse(m.goneAt) < GONE_KEPT_MS).sort((a, b) => a.id.localeCompare(b.id));
  state.listedAt = now;
}

/** Antigravity's Gemini models, into `state`, when CLIProxyAPI answers. */
async function listGemini() {
  const p = proxy();
  state.geminiAt = new Date().toISOString();
  if (!p) return;
  try {
    state.gemini = (await geminiModels(p)).map((m) => m.id);
  } catch {
    /* the last list stands */
  }
}

/** One small question to one model. */
export async function check(id: string): Promise<Check> {
  const at = new Date().toISOString();
  try {
    const r = await chat(id, [{ role: 'user', content: ASK }], { maxTokens: 2048, firstS: 120, idleS: 60, probe: true });
    const c: Check = { at, ok: true, firstS: round(r.firstS), secs: round(r.secs) };
    const after = r.secs - r.firstS;
    if (r.outTokens > 0 && after > 0.2) c.tps = round(r.outTokens / after);
    return c;
  } catch (e) {
    if (!(e instanceof CallError)) return { at, ok: false, kind: 'slow', why: e instanceof Error ? e.message.slice(0, 160) : String(e) };
    return { at, ok: false, kind: e.kind, why: e.message.slice(0, 160), secs: round((Date.now() - Date.parse(at)) / 1000) };
  }
}

/** The models the marker uses now: its first and second, and any a stage was picked for. */
function inUse(): Set<string> {
  const used = new Set([control.marker.first, control.marker.second]);
  const picks = [...Object.values(control.stages), ...Object.values(control.stagesFor).flatMap((p) => Object.values(p))];
  for (const p of picks) if (p?.provider === 'nim' && p.model) used.add(p.model);
  return used;
}

async function push(pool: pg.Pool) {
  writeJson(FILE, state);
  await recordLive(pool, JOB, state).catch(() => {});
}

async function checkOne(pool: pg.Pool, m: ModelLine) {
  state.checking = m.id;
  await push(pool);
  const c = await check(m.id);
  m.checks = [c, ...m.checks].slice(0, CHECKS_KEPT);
  state.checking = null;
  await push(pool);
}

/** Every model that chats, the ones in use first. */
async function sweep(pool: pg.Pool) {
  await list();
  await push(pool);
  const used = inUse();
  const todo = state.models.filter((m) => !m.goneAt && !m.noChat).sort((a, b) => Number(used.has(b.id)) - Number(used.has(a.id)));
  for (const m of todo) {
    // Asked for one meanwhile: it goes now.
    for (const id of [...askedOne]) {
      askedOne.delete(id);
      const one = state.models.find((x) => x.id === id);
      if (one) await checkOne(pool, one);
    }
    await checkOne(pool, m);
    await sleep(jitter(GAP_S) * 1000);
  }
  state.sweptAt = new Date().toISOString();
  await push(pool);
}

/** Checks NVIDIA's models once a day, and when the admin page asks, for good. */
export async function modelsLoop(pool: pg.Pool) {
  try {
    nvidiaKey();
  } catch {
    return;
  }
  await push(pool);
  let failedAt = 0;
  for (;;) {
    try {
      if (askedOne.size) {
        if (!state.listedAt) await list();
        for (const id of [...askedOne]) {
          askedOne.delete(id);
          const m = state.models.find((x) => x.id === id);
          if (m) await checkOne(pool, m);
        }
      }
      if (!state.geminiAt || Date.now() - Date.parse(state.geminiAt) > GEMINI_MS) {
        await listGemini();
        await push(pool);
      }
      const due = (!state.sweptAt || Date.now() - Date.parse(state.sweptAt) > DAY_MS) && Date.now() - failedAt > FAILED_WAIT_MS;
      if (askedAll || due) {
        askedAll = false;
        await sweep(pool);
      }
    } catch (e) {
      failedAt = Date.now();
      state.checking = null;
      console.log(`NVIDIA's models: ${e instanceof Error ? e.message : String(e)}`);
    }
    await sleep(LOOK_MS);
  }
}
