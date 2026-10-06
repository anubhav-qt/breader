import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Modal } from '../../components/Modal';
import { checkAddress, readServer, suwayomi, writeServer, type ServerLogin } from '../../lib/suwayomi';

/*
 * Connecting the reader's own Suwayomi server: its address, and a login if it asks for a basic one.
 * It's tried before it's kept. Kept in this browser only: each device connects its own.
 */

interface Props {
  onDone: (login: ServerLogin | null) => void;
  onClose: () => void;
}

type State = { kind: 'idle' } | { kind: 'checking' } | { kind: 'error'; message: string };

export function ConnectServer({ onDone, onClose }: Props) {
  const had = readServer();
  const [url, setUrl] = useState(had?.url ?? '');
  const [user, setUser] = useState(had?.user ?? '');
  const [pass, setPass] = useState(had?.pass ?? '');
  const [state, setState] = useState<State>({ kind: 'idle' });

  const connect = async () => {
    const address = url.trim().replace(/\/+$/, '');
    const bad = checkAddress(address);
    if (bad) { setState({ kind: 'error', message: bad }); return; }
    const login: ServerLogin = { url: address, ...(user.trim() ? { user: user.trim(), pass } : {}) };
    setState({ kind: 'checking' });
    try {
      await suwayomi.check(login);
      writeServer(login);
      onDone(login);
    } catch (e) {
      setState({ kind: 'error', message: e instanceof Error ? e.message : 'That didn’t work.' });
    }
  };

  const forget = () => {
    writeServer(null);
    onDone(null);
  };

  return createPortal(
    <Modal title="Your own server" onClose={onClose} width={480} className="srv">
      <form className="srv-form" onSubmit={(e) => { e.preventDefault(); void connect(); }}>
        <p className="srv-intro">
          Breader can read from a <a href="https://github.com/Suwayomi/Suwayomi-Server" target="_blank" rel="noopener noreferrer">Suwayomi</a> server of yours, with the sources installed there (Mihon’s extensions). This browser asks it directly: its address and login stay here, and never reach Breader’s own computer.
        </p>
        <label className="add-label" htmlFor="srv-url">Address</label>
        <input id="srv-url" className="add-input" value={url} placeholder="https://manga.example.com" inputMode="url" autoComplete="url" spellCheck={false} onChange={(e) => setUrl(e.target.value)} />
        <p className="srv-note">On https, unless it’s on this computer (http://localhost:4567).</p>
        <div className="srv-login">
          <div>
            <label className="add-label" htmlFor="srv-user">Name</label>
            <input id="srv-user" className="add-input" value={user} autoComplete="username" spellCheck={false} onChange={(e) => setUser(e.target.value)} />
          </div>
          <div>
            <label className="add-label" htmlFor="srv-pass">Password</label>
            <input id="srv-pass" className="add-input" type="password" value={pass} autoComplete="current-password" onChange={(e) => setPass(e.target.value)} />
          </div>
        </div>
        <p className="srv-note">Only if it asks for a basic login.</p>
        {state.kind === 'error' && <p className="srv-error" role="alert">{state.message}</p>}
        <div className="add-actions">
          {had && <button type="button" className="btn btn-ghost" onClick={forget}>Disconnect</button>}
          <button type="submit" className="btn btn-primary" disabled={!url.trim() || state.kind === 'checking'}>
            {state.kind === 'checking' ? 'Connecting…' : had ? 'Save' : 'Connect'}
          </button>
        </div>
      </form>
    </Modal>,
    document.body,
  );
}
