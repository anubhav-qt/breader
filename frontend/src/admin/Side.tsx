import { useRef, useState, type DragEvent } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { KIND_NAMES, type AccountKind, type AiAccount } from '@breader/shared/accounts';
import { springs } from '../lib/springs';
import { ago, until } from './format';
import { Label, Percent, Seg, Switch } from './parts';
import type { Admin, Job } from './types';

/* The admin page's side: the AI accounts, the worker's jobs, and music scored somewhere else. */

const kindName = (kind: string) => KIND_NAMES[kind as AccountKind] ?? kind;

export function Accounts({ list, admin }: { list: AiAccount[]; admin: Admin }) {
  const [removing, setRemoving] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  return (
    <section className="adm-card adm-accounts" aria-labelledby="adm-acc-h">
      <Label>AI accounts</Label>
      <h2 id="adm-acc-h" className="adm-mid">{list.length} connected</h2>
      <div className="adm-accs">
        {list.map((a, i) => {
          const firstOfKind = list.findIndex((x) => x.kind === a.kind) === i;
          return (
            <div key={a.id} className={`adm-acc${a.problem ? ' is-bad' : ''}`}>
              <div className="adm-acc-h">
                <span className="adm-chip">{kindName(a.kind)}</span>
                <b>{a.name}</b>
              </div>
              {a.problem && <p className="adm-bad">{a.problem}</p>}
              {a.usage && a.usage.map((u) => {
                const full = u.usedPercent >= 100;
                let left = `${Math.round(u.usedPercent)}% used`;
                if (u.resetsAt && u.usedPercent > 0) left += `, full again ${until(u.resetsAt)}`;
                return (
                  <div key={u.label} className="adm-limit">
                    <span className="adm-limit-l">{u.label}</span>
                    <Percent value={u.usedPercent} bad={full} label={`${a.name}, ${u.label}`} />
                    <span className={full ? 'adm-bad' : 'adm-dim'}>{left}</span>
                  </div>
                );
              })}
              {!a.usage && !a.problem && <p className="adm-dim">Its limits couldn’t be read.</p>}
              {removing === a.id ? (
                <div className="adm-acts is-ask">
                  <span>Remove?</span>
                  <button type="button" className="btn btn-danger adm-small" onClick={() => { setRemoving(null); void admin.removeAccount(a.id); }}>Remove</button>
                  <button type="button" className="btn btn-ghost adm-small" onClick={() => setRemoving(null)}>Keep</button>
                </div>
              ) : (
                <div className="adm-acts">
                  {!firstOfKind && <button type="button" className="btn btn-quiet adm-small" onClick={() => admin.useFirst(a.id)}>Use first</button>}
                  <button type="button" className="btn btn-ghost adm-small" onClick={() => setRemoving(a.id)}>Remove</button>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <AnimatePresence initial={false} mode="wait">
        {connecting ? (
          <motion.div key="connect" className="adm-fold" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={springs.snappy}>
            <Connect admin={admin} onDone={() => setConnecting(false)} />
          </motion.div>
        ) : (
          <motion.div key="button" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <button type="button" className="btn btn-primary adm-wide" onClick={() => setConnecting(true)}>+ Connect</button>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}

/** Signing in an account: its kind, its sign-in page, and the address that page ends on. */
function Connect({ admin, onDone }: { admin: Admin; onDone: () => void }) {
  const [kind, setKind] = useState<AccountKind>('antigravity');
  const [signIn, setSignIn] = useState<{ url: string; state: string } | null>(null);
  const [address, setAddress] = useState('');
  const [said, setSaid] = useState<{ text: string; bad: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  const open = async () => {
    const s = await admin.startSignIn(kind);
    setSignIn(s);
    window.open(s.url, '_blank', 'noopener,noreferrer');
  };
  const finish = async () => {
    if (!signIn || !address.trim()) return;
    setBusy(true);
    setSaid({ text: 'Finishing the sign-in…', bad: false });
    try {
      await admin.finishSignIn(signIn.state, address.trim());
      onDone();
    } catch (e) {
      setSaid({ text: e instanceof Error ? e.message : String(e), bad: true });
    }
    setBusy(false);
  };

  return (
    <div className="adm-connect">
      <Seg label="Which account" value={kind} onChange={(k) => { setKind(k); setSignIn(null); setSaid(null); }} options={(Object.keys(KIND_NAMES) as AccountKind[]).map((k) => ({ v: k, label: KIND_NAMES[k] }))} />
      <ol className="adm-howto">
        <li className={signIn ? 'is-done' : undefined}>
          <button type="button" className="btn btn-quiet adm-small" onClick={() => void open()}>Sign in</button>
        </li>
        <li>
          <span>Paste the localhost address it ends on</span>
          <div className="adm-paste">
            <input type="url" placeholder="http://localhost:…" value={address} disabled={!signIn || busy} onChange={(e) => setAddress(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void finish(); }} aria-label="The address the sign-in ended on" />
            <button type="button" className="btn btn-primary adm-small" disabled={!signIn || !address.trim() || busy} onClick={() => void finish()}>Connect</button>
          </div>
        </li>
      </ol>
      {said && <p className={said.bad ? 'adm-bad' : 'adm-dim'}>{said.text}</p>}
      <button type="button" className="btn btn-ghost adm-small" onClick={onDone}>Cancel</button>
    </div>
  );
}

/** The worker's jobs, by what they're called and what they do. */
const JOBS: Record<string, { name: string; about: string }> = {
  'backup': { name: 'Nightly backup', about: 'After 3 am, an encrypted copy of the database: 14 days on the ThinkPad, and in R2.' },
  'restore-drill': { name: 'Restore test', about: 'Once a month, after a backup, restores it to prove it works.' },
  'clean-up': { name: 'Clean-up', about: 'Every hour: removed books after 30 days, files nothing needs, key libraries unused for a year.' },
  'storage-check': { name: 'R2 check', about: 'Once a day, puts back any file missing from R2, from the ThinkPad’s copy.' },
  'extensions': { name: 'Manga extensions', about: 'Once a day, updates the manga sites’ extensions to their newest versions.' },
  'novel-plugins': { name: 'Novel plugins', about: 'Once a day, updates the novel sites’ plugins to their newest versions.' },
  'manga-prefetch': { name: 'Manga prefetch', about: 'At 4 am, fetches Browse’s lists ahead, so they open at once.' },
  'keep-library': { name: 'Library keeper', about: 'Every hour, downloads every chapter of the manga and every volume of the books in any library, and keeps them for good.' },
  'yt-dlp': { name: 'yt-dlp update', about: 'Keeps the downloader the music finds its tracks with up to date.' },
};

export function Workers({ jobs, admin }: { jobs: Job[]; admin: Admin }) {
  // The marker has its own card.
  const shown = jobs.filter((j) => j.name !== 'ai-marker');
  const failing = (j: Job) => !!j.last_error_at && (!j.last_ok_at || new Date(j.last_error_at) > new Date(j.last_ok_at));
  const bad = shown.filter(failing).length;
  let title = 'All working';
  if (bad === 1) title = '1 failing';
  if (bad > 1) title = `${bad} failing`;
  return (
    <section className="adm-card adm-workers" aria-labelledby="adm-jobs-h">
      <Label>Workers</Label>
      <h2 id="adm-jobs-h" className={`adm-mid${bad ? ' adm-bad' : ''}`}>{title}</h2>
      <ul className="adm-jobs">
        {shown.map((j) => {
          const about = JOBS[j.name] ?? { name: j.name, about: '' };
          let state = 'ok';
          if (j.off) state = 'off';
          else if (j.running) state = 'running';
          else if (failing(j)) state = 'bad';
          let when = ago(j.last_ok_at);
          if (j.running) when = 'Running…';
          if (j.off) when = 'Off';
          return (
            <li key={j.name} className={`adm-job is-${state}`}>
              <i aria-hidden="true" />
              <div className="adm-job-t" title={about.about}>
                <b>{about.name}</b>
                <p className={state === 'bad' ? 'adm-bad' : 'adm-dim'}>
                  {state === 'bad' ? `Failed ${ago(j.last_error_at)}: ${j.last_error}` : when}
                </p>
              </div>
              <div className="adm-job-acts">
                <button type="button" className="btn btn-quiet adm-small" disabled={j.running || j.off} onClick={() => admin.runJob(j.name)}>
                  {j.running ? 'Running' : 'Run now'}
                </button>
                <Switch on={!j.off} label={`${about.name} on`} onChange={(on) => admin.jobOn(j.name, on)} />
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** A book's music scored somewhere else, dropped or picked as its .json file. */
export function Music({ admin }: { admin: Admin }) {
  const [over, setOver] = useState(false);
  const [said, setSaid] = useState<{ text: string; bad: boolean } | null>(null);
  const pick = useRef<HTMLInputElement>(null);

  const send = async (file: File | undefined) => {
    if (!file) return;
    setSaid({ text: `Uploading ${file.name}…`, bad: false });
    try {
      const done = await admin.uploadMusic(await file.text());
      setSaid({ text: `Uploaded: ${done}`, bad: false });
    } catch (e) {
      setSaid({ text: e instanceof Error ? e.message : String(e), bad: true });
    }
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    void send(e.dataTransfer.files[0]);
  };

  return (
    <section className="adm-card adm-music" aria-labelledby="adm-music-h">
      <Label>Upload music</Label>
      <div
        className={`adm-drop${over ? ' is-over' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
      >
        <h2 id="adm-music-h" className="adm-mid">Drop its .json here</h2>
        <button type="button" className="btn btn-quiet adm-small" onClick={() => pick.current?.click()}>Pick file</button>
        <input ref={pick} type="file" accept=".json,application/json" hidden onChange={(e) => { void send(e.target.files?.[0]); e.target.value = ''; }} />
      </div>
      {said && <p className={said.bad ? 'adm-bad' : 'adm-dim'}>{said.text}</p>}
    </section>
  );
}
