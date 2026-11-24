import type { CopySeen, Infra, Reach, ServerSeen } from '@breader/shared/infra';
import type { Status } from './types';
import { ago, mb, span } from './format';

/*
 * The infra map (Infra.tsx): every server, copy and store Breader runs on, as ADR 0004 draws it
 * (docs/system-design.png), with how each is doing. `Infra` is what the server tells the page
 * (server src/lib/infra.ts); `infraView` turns it into what each box and line shows.
 */

export type { Infra };

export type NodeKey = 'app' | 'cdn' | 'r2' | 'home' | 'gcp' | 'azure' | 'modal' | 'homeDb' | 'gcpDb' | 'manga' | 'supabase' | 'watcher';

/** How a box is doing; `quiet` is something nothing here watches, so it shows no state and no line. */
export type NodeState = Reach | 'quiet';

export interface NodeView {
  state: NodeState;
  /** One short line under its name: how it is right now; empty for what isn't watched. */
  now: string;
  /** Wrong in a way that needs you: drawn in red. */
  bad: boolean;
  /** Filled share of a limit, 0 to 100, when it has one. */
  meter?: { value: number; label: string };
  /** The rest, for its card. */
  facts: Array<[string, string]>;
}

/** Where each box sits on the map: its column (1 to 4) and row (1 to 4). */
export interface Place {
  key: NodeKey;
  col: number;
  row: number;
  name: string;
  /** What it is, in a few words. */
  what: string;
}

export const COLUMNS = ['Readers', 'Servers', 'Read copies', 'Data'];

export const PLACES: Place[] = [
  { key: 'cdn', col: 1, row: 1, name: 'Cloudflare edge', what: 'Caches pages and covers' },
  { key: 'app', col: 1, row: 2, name: 'breader.site', what: 'The app, on Cloudflare Pages' },
  { key: 'r2', col: 1, row: 3, name: 'Cloudflare R2', what: 'Pages the ThinkPad keeps' },
  { key: 'home', col: 2, row: 1, name: 'ThinkPad', what: 'Home, India: API, worker, voices' },
  { key: 'gcp', col: 2, row: 2, name: 'GCP', what: 'Oregon: API calls only' },
  { key: 'azure', col: 2, row: 3, name: 'Azure', what: 'Singapore: standby while home is away' },
  { key: 'modal', col: 2, row: 4, name: 'Modal', what: 'Engine on call for Azure' },
  { key: 'homeDb', col: 3, row: 1, name: 'ThinkPad copy', what: 'Postgres read copy' },
  { key: 'gcpDb', col: 3, row: 2, name: 'GCP copy', what: 'Postgres read copy' },
  { key: 'manga', col: 4, row: 1, name: 'Manga sites', what: 'MangaDex, MangaFire, AniList' },
  { key: 'supabase', col: 4, row: 2, name: 'Supabase', what: 'Mumbai: the only writer' },
  { key: 'watcher', col: 4, row: 3, name: 'AWS watcher', what: 'Asks home each minute' },
];

export type FlowKey =
  | 'app-cdn' | 'app-r2' | 'cdn-home' | 'app-home' | 'app-gcp' | 'app-azure'
  | 'home-homeDb' | 'gcp-gcpDb' | 'feed-homeDb' | 'feed-gcpDb'
  | 'home-writes' | 'gcp-writes' | 'azure-writes' | 'home-manga' | 'azure-manga'
  | 'watcher-azure' | 'azure-modal';

/** A line between two boxes, in the way things go. */
export interface Flow {
  key: FlowKey;
  from: NodeKey;
  to: NodeKey;
  label?: string;
  /** Lines that skip a column go along this row (a half is the gap under a row), clear of the boxes. */
  lane?: number;
  /** Where on each box's side it leaves and lands, 0 the top and 1 the bottom; the middle when left out. */
  fromAt?: number;
  toAt?: number;
  /** Moves its turns this far across the gap between columns, so lines side by side don't overlap. */
  track?: number;
}

export const FLOWS: Flow[] = [
  { key: 'app-cdn', from: 'app', to: 'cdn', label: 'pages, covers' },
  { key: 'app-r2', from: 'app', to: 'r2', label: 'recent pages' },
  { key: 'cdn-home', from: 'cdn', to: 'home', label: 'cache miss', track: -18 },
  { key: 'app-home', from: 'app', to: 'home', label: 'picks fastest', fromAt: 0.35, toAt: 0.65, track: -6 },
  { key: 'app-gcp', from: 'app', to: 'gcp', fromAt: 0.5, track: 6 },
  { key: 'app-azure', from: 'app', to: 'azure', label: 'home away', fromAt: 0.65, track: 18 },
  { key: 'home-homeDb', from: 'home', to: 'homeDb', label: 'reads', fromAt: 0.35, toAt: 0.35 },
  { key: 'gcp-gcpDb', from: 'gcp', to: 'gcpDb', label: 'reads', fromAt: 0.35, toAt: 0.35 },
  { key: 'feed-homeDb', from: 'supabase', to: 'homeDb', label: 'change_log', fromAt: 0.3, toAt: 0.65 },
  { key: 'feed-gcpDb', from: 'supabase', to: 'gcpDb', fromAt: 0.3, toAt: 0.65 },
  { key: 'home-writes', from: 'home', to: 'supabase', label: 'writes', lane: 3.5, fromAt: 0.8, toAt: 0.75, track: 14 },
  { key: 'gcp-writes', from: 'gcp', to: 'supabase', lane: 3.5, fromAt: 0.8, toAt: 0.75, track: 14 },
  { key: 'azure-writes', from: 'azure', to: 'supabase', lane: 3.5, fromAt: 0.8, toAt: 0.75, track: 14 },
  { key: 'home-manga', from: 'home', to: 'manga', label: 'manga', lane: 1.5, fromAt: 0.6, track: -14 },
  { key: 'azure-manga', from: 'azure', to: 'manga', lane: 1.5, fromAt: 0.3, track: -14 },
  { key: 'watcher-azure', from: 'watcher', to: 'azure', label: 'wakes', lane: 3, toAt: 0.5 },
  { key: 'azure-modal', from: 'azure', to: 'modal', label: 'voices' },
];

export interface InfraView {
  nodes: Record<NodeKey, NodeView>;
  /** Lines in use now: drawn moving. The rest are drawn faint. */
  live: Set<FlowKey>;
}

/** A copy is behind when the oldest change it hasn't read is this old. */
const BEHIND_S = 60;
/** The watcher asks each minute: past this, it has stopped, if home could have heard it. */
const WATCHER_QUIET_S = 180;
/** A share of a free limit that needs you. */
const FULL = 90;

const secondsSince = (iso: string) => (Date.now() - new Date(iso).getTime()) / 1000;
function short(release: string | null) {
  if (!release) return 'unknown';
  return release.slice(0, 7);
}
const share = (used: number, limit: number) => (limit > 0 ? (100 * used) / limit : 0);
const answers = (s: ServerSeen | null) => !!s && (s.state === 'up' || s.state === 'busy');

const REACH_WORDS: Record<Reach, string> = { up: 'Up', busy: 'Busy', asleep: 'Asleep', down: 'Not answering' };

/** What each box and line shows, from what the server says and the page's own status. */
export function infraView(infra: Infra, status: Status): InfraView {
  const { home, gcp, azure } = infra.servers;
  const homeCopy = infra.copies.find((c) => c.where === 'home') ?? null;
  const gcpCopy = infra.copies.find((c) => c.where === 'gcp') ?? null;
  const awake = answers(azure);

  const nodes: Record<NodeKey, NodeView> = {
    app: { state: 'up', now: 'Serving this page', bad: false, facts: [['Hosted on', 'Cloudflare Pages'], ['Picks', 'the fastest server that answers']] },
    cdn: { state: 'quiet', now: '', bad: false, facts: [['Watched', 'not from here']] },
    r2: r2View(infra.r2),
    home: homeView(home, status),
    gcp: gcpView(gcp),
    azure: azureView(azure),
    modal: modalView(infra.modal, awake),
    homeDb: copyView(homeCopy),
    gcpDb: copyView(gcpCopy),
    manga: { state: 'quiet', now: '', bad: false, facts: [['Asked by', 'the ThinkPad, or Azure while home is away'], ['Watched', 'not from here']] },
    supabase: supabaseView(status),
    watcher: watcherView(infra.watcher, answers(home)),
  };

  const live = new Set<FlowKey>(['app-cdn', 'app-r2']);
  if (answers(home)) {
    live.add('cdn-home');
    live.add('app-home');
    live.add('home-writes');
    live.add('home-manga');
  }
  if (answers(gcp)) {
    live.add('app-gcp');
    live.add('gcp-writes');
  }
  if (awake) {
    live.add('app-azure');
    live.add('azure-writes');
    live.add('azure-manga');
    live.add('watcher-azure');
    live.add('azure-modal');
  }
  if (answers(home) && homeCopy) live.add('home-homeDb');
  if (answers(gcp) && gcpCopy) live.add('gcp-gcpDb');
  if (homeCopy && homeCopy.behind !== null) live.add('feed-homeDb');
  if (gcpCopy && gcpCopy.behind !== null) live.add('feed-gcpDb');
  return { nodes, live };
}

/** What on the map needs you, worst first, for the top of the page. */
export function infraNeeds(infra: Infra): Array<{ key: string; text: string }> {
  const out: Array<{ key: string; text: string }> = [];
  const { home, gcp, azure } = infra.servers;
  if (home?.state === 'down') out.push({ key: 'infra-home', text: `ThinkPad away for ${span(secondsSince(home.heardAt))}` });
  if (azure?.state === 'down') out.push({ key: 'infra-azure', text: 'Azure woken but not answering' });
  if (gcp?.state === 'down') out.push({ key: 'infra-gcp', text: 'GCP not answering' });
  if (gcp?.egress && share(gcp.egress.usedMb, gcp.egress.limitMb) >= FULL) {
    out.push({ key: 'infra-egress', text: `GCP sent ${Math.round(gcp.egress.usedMb)} of ${gcp.egress.limitMb} MB this month` });
  }
  const watcher = watcherView(infra.watcher, answers(home));
  if (watcher.state === 'down') out.push({ key: 'infra-watcher', text: 'AWS watcher stopped asking home' });
  const r2 = r2View(infra.r2);
  if (r2.bad) out.push({ key: 'infra-r2', text: 'R2 near its free limit' });
  for (const c of infra.copies) {
    // The ThinkPad's own copy is in the status already (Admin.tsx, needsOf).
    if (c.where === 'home') continue;
    const v = copyView(c);
    if (v.bad) out.push({ key: `infra-copy-${c.name}`, text: `${copyOwner(c)} ${v.now.toLowerCase()}` });
  }
  return out;
}

const COPY_OWNERS: Record<CopySeen['where'], string> = { home: 'ThinkPad copy', gcp: 'GCP copy', azure: 'Azure copy', other: 'Read copy' };

function copyOwner(c: CopySeen) {
  if (c.where === 'other') return `Read copy ${c.name}`;
  return COPY_OWNERS[c.where];
}

function homeView(s: ServerSeen | null, status: Status): NodeView {
  if (!s) return { state: 'quiet', now: 'Not heard from', bad: false, facts: [] };
  const facts: Array<[string, string]> = [['Release', short(s.release)], ['Heard', ago(s.heardAt)]];
  // Only the ThinkPad itself knows how long it has been up.
  if (status.server.role === 'laptop' && s.state !== 'down') facts.push(['Up for', span(status.server.uptimeSeconds)]);
  if (s.engine) {
    facts.push(['Engines', `${s.engine.up} up, ${s.engine.workers} workers`]);
    facts.push(['Voices and panels', `${s.engine.busy} working, ${s.engine.waiting} waiting`]);
  }
  if (s.state === 'down') return { state: 'down', now: `Away for ${span(secondsSince(s.heardAt))}`, bad: true, facts };
  let now = REACH_WORDS[s.state];
  if (s.engine) now += ` · ${s.engine.busy} of ${s.engine.workers} busy`;
  return { state: s.state, now, bad: false, facts };
}

function gcpView(s: ServerSeen | null): NodeView {
  if (!s) return { state: 'quiet', now: 'Not set up here', bad: false, facts: [] };
  const facts: Array<[string, string]> = [['Release', short(s.release)], ['Heard', ago(s.heardAt)], ['Answers', 'API calls only, no manga or voices']];
  if (!s.egress) return { state: s.state, now: REACH_WORDS[s.state], bad: s.state === 'down', facts };
  const used = share(s.egress.usedMb, s.egress.limitMb);
  facts.push(['Sent this month', `${s.egress.usedMb.toFixed(1)} MB of ${s.egress.limitMb} MB`]);
  const full = used >= FULL;
  return {
    state: s.state,
    now: full ? 'Near its egress limit' : REACH_WORDS[s.state],
    bad: s.state === 'down' || full,
    meter: { value: used, label: 'Egress this month, of its limit' },
    facts,
  };
}

function azureView(s: ServerSeen | null): NodeView {
  if (!s) return { state: 'quiet', now: 'Not set up here', bad: false, facts: [] };
  const facts: Array<[string, string]> = [['Wakes', 'when home misses 10 minutes in a row']];
  if (s.state === 'asleep') return { state: 'asleep', now: 'Asleep', bad: false, facts };
  facts.unshift(['Release', short(s.release)], ['Heard', ago(s.heardAt)]);
  if (s.state === 'down') return { state: 'down', now: 'Woken, not answering', bad: true, facts };
  let now = 'Awake';
  if (s.startedAt) {
    facts.push(['Awake since', ago(s.startedAt)]);
    now = `Awake for ${span(secondsSince(s.startedAt))}`;
  }
  return { state: s.state, now, bad: false, facts };
}

function modalView(m: Infra['modal'], azureAwake: boolean): NodeView {
  if (!m) return { state: 'quiet', now: 'Not set up here', bad: false, facts: [] };
  if (!azureAwake || !m.up) return { state: 'asleep', now: 'On call', bad: false, facts: [['Called by', 'Azure, while it is awake']] };
  const facts: Array<[string, string]> = [['Jobs done since Azure woke', String(m.done)]];
  return { state: 'up', now: 'Reading aloud for Azure', bad: false, facts };
}

function copyView(c: CopySeen | null): NodeView {
  if (!c) return { state: 'quiet', now: 'No copy', bad: false, facts: [] };
  const facts: Array<[string, string]> = [['Name', c.name]];
  if (c.behind === null) return { state: 'down', now: 'Never caught up', bad: true, facts };
  if (c.behind === 0) return { state: 'up', now: 'Caught up', bad: false, facts };
  facts.push(['Oldest change not read', `${span(c.behind)} ago`]);
  if (c.behind > BEHIND_S) return { state: 'busy', now: `${span(c.behind)} behind`, bad: true, facts };
  return { state: 'up', now: `${span(c.behind)} behind`, bad: false, facts };
}

function supabaseView(status: Status): NodeView {
  const db = status.supabase;
  if (!db) return { state: 'down', now: 'Not answering', bad: true, facts: [] };
  const used = share(db.bytes, db.freeBytes);
  const facts: Array<[string, string]> = [['Size', `${mb(db.bytes)} of the free ${mb(db.freeBytes)}`]];
  if (status.feed) facts.push(['Changes kept', String(status.feed.rows)]);
  return { state: 'up', now: `${mb(db.bytes)} of ${mb(db.freeBytes)}`, bad: used >= FULL, meter: { value: used, label: 'Database, of the free plan' }, facts };
}

function r2View(r: Infra['r2']): NodeView {
  if (!r) return { state: 'quiet', now: 'Off', bad: false, facts: [] };
  const used = share(r.bytes, r.limitBytes);
  let writes = 0;
  let writeWords = r.writes.toLocaleString('en');
  if (r.writeLimit !== null) {
    writes = share(r.writes, r.writeLimit);
    writeWords += ` of ${r.writeLimit.toLocaleString('en')}`;
  }
  const facts: Array<[string, string]> = [
    ['Kept', `${mb(r.bytes)} of ${mb(r.limitBytes)}`],
    ['Writes this month', writeWords],
  ];
  const bad = used >= FULL || writes >= FULL;
  return { state: 'up', now: `${mb(r.bytes)} of ${mb(r.limitBytes)}`, bad, meter: { value: Math.max(used, writes), label: 'R2, of its free limit' }, facts };
}

/**
 * Only a server that answers hears the watcher: while home is away and Azure still asleep, its asks
 * reach no one, so a quiet watcher then says nothing about it.
 */
function watcherView(w: Infra['watcher'], homeAnswers: boolean): NodeView {
  if (!w) return { state: 'quiet', now: 'Not heard from', bad: false, facts: [] };
  const facts: Array<[string, string]> = [['Last heard', ago(w.lastAsked)], ['Home missed in a row', `${w.missed} min`]];
  if (secondsSince(w.lastAsked) > WATCHER_QUIET_S) {
    if (homeAnswers) return { state: 'down', now: 'Stopped asking', bad: true, facts };
    return { state: 'quiet', now: `Last heard ${ago(w.lastAsked)}`, bad: false, facts };
  }
  if (w.missed > 0) return { state: 'busy', now: `Home missed ${w.missed} min`, bad: false, facts };
  return { state: 'up', now: `Asked ${ago(w.lastAsked)}`, bad: false, facts };
}
