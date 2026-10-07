import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Modal } from '../../components/Modal';
import { opds, readCatalog, writeCatalog } from '../../lib/opds';
import { checkAddress, readServer, suwayomi, writeServer } from '../../lib/suwayomi';

/*
 * Connecting the reader's own servers: a Suwayomi server, whose sources are Mihon's extensions, and
 * an OPDS catalog (Komga, Kavita, Calibre's content server). Each is an address, and a login if it
 * asks for a basic one, tried before it's kept. Kept in this browser only: each device connects its
 * own, and Breader's own computer never sees them.
 */

export type ServerKind = 'suwayomi' | 'opds';

interface Props {
  /** A server connected (with its address), or let go of (null). */
  onDone: (kind: ServerKind, url: string | null) => void;
  onClose: () => void;
}

type State = { kind: 'idle' } | { kind: 'checking' } | { kind: 'error'; message: string };

const INTRO: Record<ServerKind, string> = {
  suwayomi: 'A Suwayomi server of yours, with the sources installed there (Mihon’s extensions): their series read here a few chapters at a time.',
  opds: 'An OPDS catalog of yours, such as Komga, Kavita or Calibre’s: its books and comics, added to your library as files. It has to let Breader ask it (CORS): Komga does once its komga.cors.allowed-origins setting names Breader.',
};
const PLACEHOLDER: Record<ServerKind, string> = { suwayomi: 'https://manga.example.com', opds: 'https://books.example.com/opds/v1.2/catalog' };

export function ConnectServer({ onDone, onClose }: Props) {
  const [kind, setKind] = useState<ServerKind>(() => (readServer() || !readCatalog() ? 'suwayomi' : 'opds'));
  const had = kind === 'suwayomi' ? readServer() : readCatalog();
  const [fields, setFields] = useState(() => ({
    suwayomi: { url: readServer()?.url ?? '', user: readServer()?.user ?? '', pass: readServer()?.pass ?? '' },
    opds: { url: readCatalog()?.url ?? '', user: readCatalog()?.user ?? '', pass: readCatalog()?.pass ?? '' },
  }));
  const [state, setState] = useState<State>({ kind: 'idle' });
  const f = fields[kind];
  const edit = (patch: Partial<typeof f>) => setFields((all) => ({ ...all, [kind]: { ...all[kind], ...patch } }));

  const connect = async () => {
    const address = f.url.trim().replace(/\/+$/, '');
    const bad = checkAddress(address);
    if (bad) { setState({ kind: 'error', message: bad }); return; }
    const login = { url: address, ...(f.user.trim() ? { user: f.user.trim(), pass: f.pass } : {}) };
    setState({ kind: 'checking' });
    try {
      if (kind === 'suwayomi') {
        await suwayomi.check(login);
        writeServer(login);
      } else {
        await opds.check(login);
        writeCatalog(login);
      }
      onDone(kind, address);
    } catch (e) {
      setState({ kind: 'error', message: e instanceof Error ? e.message : 'That didn’t work.' });
    }
  };

  const forget = () => {
    if (kind === 'suwayomi') writeServer(null);
    else writeCatalog(null);
    onDone(kind, null);
  };

  return createPortal(
    <Modal title="Your own servers" onClose={onClose} width={480} className="srv">
      <form className="srv-form" onSubmit={(e) => { e.preventDefault(); void connect(); }}>
        <div className="mdx-sorts srv-kind" role="radiogroup" aria-label="Kind of server">
          {(['suwayomi', 'opds'] as const).map((k) => (
            <button key={k} type="button" role="radio" aria-checked={kind === k} className="mdx-sort" onClick={() => { setKind(k); setState({ kind: 'idle' }); }}>
              {k === 'suwayomi' ? 'Suwayomi' : 'OPDS catalog'}
            </button>
          ))}
        </div>
        <p className="srv-intro">{INTRO[kind]} This browser asks it directly: its address and login stay here.</p>
        <label className="add-label" htmlFor="srv-url">Address</label>
        <input id="srv-url" className="add-input" value={f.url} placeholder={PLACEHOLDER[kind]} inputMode="url" autoComplete="url" spellCheck={false} onChange={(e) => edit({ url: e.target.value })} />
        <p className="srv-note">On https, unless it’s on this computer (http://localhost).</p>
        <div className="srv-login">
          <div>
            <label className="add-label" htmlFor="srv-user">Name</label>
            <input id="srv-user" className="add-input" value={f.user} autoComplete="username" spellCheck={false} onChange={(e) => edit({ user: e.target.value })} />
          </div>
          <div>
            <label className="add-label" htmlFor="srv-pass">Password</label>
            <input id="srv-pass" className="add-input" type="password" value={f.pass} autoComplete="current-password" onChange={(e) => edit({ pass: e.target.value })} />
          </div>
        </div>
        <p className="srv-note">Only if it asks for a basic login.</p>
        {state.kind === 'error' && <p className="srv-error" role="alert">{state.message}</p>}
        <div className="add-actions">
          {had && <button type="button" className="btn btn-ghost" onClick={forget}>Disconnect</button>}
          <button type="submit" className="btn btn-primary" disabled={!f.url.trim() || state.kind === 'checking'}>
            {state.kind === 'checking' ? 'Connecting…' : had ? 'Save' : 'Connect'}
          </button>
        </div>
      </form>
    </Modal>,
    document.body,
  );
}
