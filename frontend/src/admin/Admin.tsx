import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Logo } from '../components/Logo';
import { springs } from '../lib/springs';
import { demoAdmin, type Scene } from './demo';
import { liveAdmin, savedToken, saveToken } from './live';
import { MarkerCard } from './Marker';
import { ago, mb, span, until, useClock } from './format';
import { Label, Percent } from './parts';
import { Accounts, Music, Workers } from './Side';
import { TASK_NAMES, type Admin, type Link, type Snapshot } from './types';
import '../components/header.css';
import '../components/preview-bar.css';
import './admin.css';

/*
 * The admin page, in Breader's own look: what needs doing first, each with the button that does
 * it; the numbers at a glance, their details a tap away; then the AI marker, the accounts, the
 * workers and the music upload. Everything arrives as it happens, pushed by the server (live.ts),
 * behind the admin token.
 *
 * With ?demo it runs on demoAdmin (demo.ts) instead, with a preview bar to switch scenes and themes.
 */

type Theme = 'auto' | 'light' | 'dark';
const SCENES: Array<{ v: Scene; label: string }> = [
  { v: 'well', label: 'All well' },
  { v: 'trouble', label: 'Trouble' },
  { v: 'quiet', label: 'Nothing to do' },
];

function readParam<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const v = new URLSearchParams(location.search).get(name);
  const found = allowed.find((a) => a === v);
  if (found) return found;
  return fallback;
}

function writeParam(name: string, value: string, fallback: string) {
  const url = new URL(location.href);
  if (value === fallback) url.searchParams.delete(name);
  else url.searchParams.set(name, value);
  history.replaceState(null, '', url);
}

const DEMO = new URLSearchParams(location.search).has('demo');

export function AdminPage() {
  if (DEMO) return <DemoPage />;
  return <LivePage />;
}

/** The real thing: the admin token, then the board on the server's stream. */
function LivePage() {
  const [token, setToken] = useState<string | null>(savedToken);
  const [said, setSaid] = useState<string | null>(null);
  const admin = useMemo(() => {
    if (!token) return null;
    return liveAdmin(token);
  }, [token]);
  if (!admin) {
    const open = (t: string) => {
      saveToken(t);
      setSaid(null);
      setToken(t);
    };
    return <Gate said={said} onToken={open} />;
  }
  const denied = () => {
    saveToken(null);
    setToken(null);
    setSaid('That isn’t the admin token.');
  };
  return <Board admin={admin} onDenied={denied} />;
}

function Gate({ said, onToken }: { said: string | null; onToken: (token: string) => void }) {
  const [value, setValue] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (value.trim()) onToken(value.trim());
  };
  return (
    <div className="adm">
      <Header link={null} />
      <main className="adm-main">
        <form className="adm-gate" onSubmit={submit}>
          <div className="adm-paste">
            <input type="password" autoComplete="current-password" placeholder="Admin token" aria-label="Admin token" value={value} onChange={(e) => setValue(e.target.value)} autoFocus />
            <button type="submit" className="btn btn-primary adm-small" disabled={!value.trim()}>Open</button>
          </div>
          {said && <p className="adm-bad">{said}</p>}
        </form>
      </main>
    </div>
  );
}

function Header({ link }: { link: Link | null }) {
  return (
    <header className="hdr adm-hdr">
      <div className="hdr-start">
        <Logo />
        <span className="adm-title">Admin</span>
      </div>
      {link && (
        <div className="hdr-actions">
          <span className={`adm-live${link === 'live' ? ' is-on' : ''}`} title="Changes arrive as they happen">
            <i aria-hidden="true" />
            {link === 'live' ? 'Live' : 'Connecting'}
          </span>
        </div>
      )}
    </header>
  );
}

/** Everything the server pushes, kept current for as long as the page is open. */
function Board({ admin, onDenied, children }: { admin: Admin; onDenied?: () => void; children?: ReactNode }) {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [link, setLink] = useState<Link>('connecting');
  const [error, setError] = useState<{ text: string } | null>(null);
  useEffect(() => admin.watch(setSnap, setLink, (text) => setError({ text })), [admin]);
  useEffect(() => {
    if (link === 'denied') onDenied?.();
  }, [link, onDenied]);
  useEffect(() => {
    if (!error) return;
    const t = window.setTimeout(() => setError(null), 6000);
    return () => window.clearTimeout(t);
  }, [error]);
  useClock();

  return (
    <div className="adm">
      <Header link={link} />
      {error && <p className="adm-bad adm-err" role="alert">{error.text}</p>}
      {snap && (
        <main className="adm-main">
          {/* Each at its own width: what needs you and the marker wide, the rest narrow, side by side where they fit. */}
          <div className="adm-board">
            <div className="adm-col is-wide">
              <Needs snap={snap} admin={admin} />
              {snap.marker && <MarkerCard m={snap.marker} admin={admin} />}
            </div>
            <div className="adm-side">
              <div className="adm-col">
                <Glance snap={snap} />
                {snap.accounts && <Accounts list={snap.accounts} admin={admin} />}
              </div>
              <div className="adm-col">
                <Workers jobs={snap.status.jobs} admin={admin} />
                <Music admin={admin} />
              </div>
            </div>
          </div>
        </main>
      )}
      {children}
    </div>
  );
}

/** The design's demo, on a pretend server. */
function DemoPage() {
  const [scene, setScene] = useState<Scene>(() => readParam('scene', ['well', 'trouble', 'quiet'] as const, 'well'));
  const [theme, setTheme] = useState<Theme>(() => readParam('theme', ['auto', 'light', 'dark'] as const, 'auto'));
  const [round, setRound] = useState(0);
  // A new demo for each scene, and for each reset.
  const admin = useMemo(() => demoAdmin(scene), [scene, round]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => writeParam('scene', scene, 'well'), [scene]);
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'auto') delete root.dataset.theme;
    else root.dataset.theme = theme;
    writeParam('theme', theme, 'auto');
  }, [theme]);

  return (
    <Board admin={admin}>
      <div className="pv" role="group" aria-label="Preview controls">
        <span className="pv-tag">preview</span>
        {SCENES.map((s) => (
          <button key={s.v} type="button" aria-pressed={scene === s.v} onClick={() => setScene(s.v)}>{s.label}</button>
        ))}
        <span className="pv-sep" />
        {(['auto', 'light', 'dark'] as const).map((t) => (
          <button key={t} type="button" aria-pressed={theme === t} onClick={() => setTheme(t)}>{t}</button>
        ))}
        <span className="pv-sep" />
        <button type="button" onClick={() => setRound(round + 1)}>reset</button>
      </div>
    </Board>
  );
}

interface Need {
  key: string;
  text: string;
  act?: { label: string; run: () => void };
}

const jumpTo = (id: string) => () => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

/** What needs looking at, worst first, each with what can be done about it from here. */
function needsOf(s: Snapshot, admin: Admin): Need[] {
  const out: Need[] = [];
  const st = s.status;
  if (!st.supabase) out.push({ key: 'db', text: 'Database down' });
  if (st.copy?.down) out.push({ key: 'copy', text: 'ThinkPad copy down' });
  for (const j of st.jobs) {
    const failing = !!j.last_error_at && (!j.last_ok_at || new Date(j.last_error_at) > new Date(j.last_ok_at));
    if (!failing || j.off || j.name === 'ai-marker') continue;
    out.push({ key: `job-${j.name}`, text: `${JOB_NAMES[j.name] ?? j.name} failed ${ago(j.last_error_at)}: ${j.last_error}`, act: { label: 'Run now', run: () => admin.runJob(j.name) } });
  }
  const m = s.marker;
  if (m) {
    const quiet = (Date.now() - new Date(m.at).getTime()) / 1000;
    if (quiet > 180) out.push({ key: 'quiet', text: `AI marker silent for ${span(quiet)}` });
    if (m.limitedUntil) out.push({ key: 'gemini', text: `Gemini is out on every Antigravity account, back ${until(m.limitedUntil)}`, act: { label: 'Connect another', run: jumpTo('adm-acc-h') } });
    if (m.musicWaitsForAccount) out.push({ key: 'music', text: 'Music needs an Antigravity account', act: { label: 'Connect', run: jumpTo('adm-acc-h') } });
    for (const q of m.queue) {
      if (!q.failed) continue;
      out.push({ key: `q-${q.id}-${q.task}`, text: `${q.title}: ${TASK_NAMES[q.task].toLowerCase()} failed ×${q.failed.times}`, act: { label: 'Try now', run: () => admin.retry(q.id, q.task) } });
    }
  }
  for (const a of s.accounts ?? []) {
    if (a.problem) out.push({ key: `acc-${a.id}`, text: `${a.name}: ${a.problem}`, act: { label: 'Go to it', run: jumpTo('adm-acc-h') } });
  }
  if (st.supabase && st.supabase.bytes > 0.8 * st.supabase.freeBytes) out.push({ key: 'db-full', text: `Database ${Math.round((100 * st.supabase.bytes) / st.supabase.freeBytes)}% full` });
  if (st.feed && (st.feed.ack === null || st.feed.ack > 600)) out.push({ key: 'feed', text: `ThinkPad stopped reading changes ${st.feed.ack === null ? 'ever ago' : `${span(st.feed.ack)} ago`} · ${st.feed.unread} waiting` });
  if (st.copy && !st.copy.down && st.copy.lag !== null && st.copy.lag > 60) out.push({ key: 'lag', text: `ThinkPad copy ${span(st.copy.lag)} behind` });
  if (!st.server.sentry) out.push({ key: 'sentry', text: 'Sentry off: SENTRY_DSN not set' });
  return out;
}

const JOB_NAMES: Record<string, string> = {
  'backup': 'Nightly backup', 'restore-drill': 'Restore test', 'clean-up': 'Clean-up', 'storage-check': 'R2 check',
  'extensions': 'Manga extensions', 'manga-prefetch': 'Manga prefetch', 'keep-library': 'Library keeper', 'yt-dlp': 'yt-dlp update',
};

/** What needs doing, at the top of the page; nothing at all when nothing does. */
function Needs({ snap, admin }: { snap: Snapshot; admin: Admin }) {
  const needs = needsOf(snap, admin);
  if (!needs.length) return null;
  return (
    <section className="adm-needs" aria-label="Needs you">
      <ul className="adm-need-list">
        <AnimatePresence initial={false}>
          {needs.map((n) => (
            <motion.li key={n.key} layout initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, height: 0 }} transition={springs.snappy}>
              <i aria-hidden="true" />
              <span>{n.text}</span>
              {n.act && <button type="button" className="btn btn-quiet adm-small" onClick={n.act.run}>{n.act.label}</button>}
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
    </section>
  );
}

type Area = 'server' | 'database' | 'files' | 'sync' | 'libraries' | 'books';

/** The numbers, one tile each; a tap shows the rest of what's known about it. */
function Glance({ snap }: { snap: Snapshot }) {
  const [open, setOpen] = useState<Area | null>(null);
  const st = snap.status;
  const ready = st.files.byStatus.find((f) => f.status === 'ready');
  const dbShare = st.supabase ? (100 * st.supabase.bytes) / st.supabase.freeBytes : 0;
  const fileShare = ready ? (100 * ready.bytes) / st.files.freeBytes : 0;

  const tiles: Array<{ area: Area; label: string; big: string; sub: ReactNode; bad?: boolean }> = [
    { area: 'server', label: 'Server', big: st.server.role === 'laptop' ? 'ThinkPad' : 'Fallback', sub: `up ${span(st.server.uptimeSeconds)}` },
    {
      area: 'database',
      label: 'Database',
      big: st.supabase ? mb(st.supabase.bytes) : 'Down',
      sub: st.supabase ? <Percent value={dbShare} bad={dbShare > 80} label="Database, of the free plan" /> : 'not answering',
      bad: !st.supabase || dbShare > 80,
    },
    {
      area: 'files',
      label: 'Files',
      big: ready ? mb(ready.bytes) : 'None',
      sub: <Percent value={fileShare} bad={fileShare > 80} label="Files, of R2’s free 10 GB" />,
      bad: fileShare > 80,
    },
    {
      area: 'sync',
      label: 'ThinkPad copy',
      big: st.copy?.down ? 'Down' : `${span(st.copy?.lag ?? 0)}`,
      sub: 'behind the database',
      bad: !!st.copy?.down || (st.copy?.lag ?? 0) > 60,
    },
    { area: 'libraries', label: 'Libraries', big: String(st.libraries?.total ?? '—'), sub: `${st.libraries?.active_week ?? 0} used this week` },
    { area: 'books', label: 'Books', big: String(st.books?.books ?? '—'), sub: `${st.books?.removed ?? 0} removed, kept for Undo` },
  ];

  return (
    <section className="adm-glance-w" aria-label="At a glance">
      <div className="adm-glance">
        {tiles.map((t) => (
          <button key={t.area} type="button" className={`adm-tile${open === t.area ? ' is-open' : ''}${t.bad ? ' is-bad' : ''}`} aria-expanded={open === t.area} onClick={() => setOpen(open === t.area ? null : t.area)}>
            <Label>{t.label}</Label>
            <b>{t.big}</b>
            <span className="adm-tile-s">{t.sub}</span>
          </button>
        ))}
      </div>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div key={open} className="adm-fold" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={springs.snappy}>
            <dl className="adm-details">
              {detailsOf(open, snap).map(([k, v]) => (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}

/** The plumbing behind a tile, for when it's wanted. */
function detailsOf(area: Area, snap: Snapshot): Array<[string, string]> {
  const st = snap.status;
  if (area === 'server') {
    const headers = Object.entries(st.request.headers).map(([k, v]) => `${k}: ${v}`).join(', ');
    return [
      ['Answering', st.server.role === 'laptop' ? 'the ThinkPad' : 'the fallback (Render)'],
      ['Release', st.server.release],
      ['Up for', span(st.server.uptimeSeconds)],
      ['Errors to Sentry', st.server.sentry ? 'on' : 'off: SENTRY_DSN isn’t set'],
      ['Your address, as seen', `${st.request.ip}, from ${st.request.from}`],
      ['Forwarding headers', headers || 'none'],
    ];
  }
  if (area === 'database') {
    if (!st.supabase) return [['Database', 'not answering']];
    return [
      ['Size', `${mb(st.supabase.bytes)} of the free ${mb(st.supabase.freeBytes)}`],
      ['Sync timeline', st.supabase.timeline ?? '—'],
      ['Change records kept', String(st.feed?.rows ?? '—')],
    ];
  }
  if (area === 'files') {
    return st.files.byStatus.map((f) => {
      let v = `${f.files} files, ${mb(f.bytes)}`;
      if (f.unused) v += `, ${f.unused} waiting for clean-up`;
      return [f.status === 'ready' ? 'Stored' : f.status, v];
    });
  }
  if (area === 'sync') {
    const rows: Array<[string, string]> = [];
    if (st.copy && !st.copy.down) {
      rows.push(['Behind the database by', span(st.copy.lag ?? 0)]);
      rows.push(['Last full reload', ago(st.copy.loaded_at)]);
    }
    if (st.feed) {
      rows.push(['ThinkPad last read the changes', st.feed.ack === null ? 'never' : `${span(st.feed.ack)} ago`]);
      rows.push(['Changes waiting for it', String(st.feed.unread)]);
    }
    return rows;
  }
  if (area === 'libraries') {
    const l = st.libraries;
    if (!l) return [];
    return [
      ['Libraries', `${l.total}, ${l.key_only} with a key only`],
      ['Used this week', String(l.active_week)],
      ['Expire within 30 days', String(l.expiring)],
      ['Retired', String(l.retired)],
    ];
  }
  const b = st.books;
  if (!b) return [];
  return [
    ['Books', String(b.books)],
    ['Removed, kept for Undo', String(b.removed)],
  ];
}
