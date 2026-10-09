import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { IconEye, IconKey, IconPencil, IconSettings } from '../../components/icons';
import { DEFAULT_LABELS, LABEL_CHARS, readLabels, renameLabel, type LibraryLabels } from '../../data/labels';
import { useSyncStatus } from '../../data/sync';
import { loginError, sendVerification, type AccountState } from '../../lib/account';
import { springs } from '../../lib/springs';
import './account.css';

interface Props {
  account: AccountState;
  onLogin: () => void;
  /** Ends the login and clears this browser's library. */
  onLogOut: () => Promise<void>;
  /** The reader's library key, which shares their books. */
  onKey: () => void;
  /** Manga's covers without their titles, or with them; absent where there are no covers to show. */
  coversOnly?: boolean;
  onCoversOnly: () => void;
}

/**
 * The header's settings: manga's covers on their own, the names of the switch between libraries,
 * the library key, and logging in, or who's logged in and logging out.
 */
export function SettingsMenu({ account, onLogin, onLogOut, onKey, coversOnly, onCoversOnly }: Props) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [naming, setNaming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const sync = useSyncStatus();

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('pointerdown', away);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('pointerdown', away);
      window.removeEventListener('keydown', esc);
    };
  }, [open]);

  useEffect(() => {
    if (open) return;
    setConfirming(false);
    setNaming(false);
    setMessage(null);
  }, [open]);

  const user = account.status === 'in' ? account.user : null;

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
    } catch (e) {
      setMessage(loginError(e));
    } finally {
      setBusy(false);
    }
  };

  // Out of the menu, into a dialog of its own.
  const leaveFor = (go: () => void) => {
    setOpen(false);
    go();
  };

  let ending = (
    <button type="button" role="menuitem" className="acct-item" onClick={() => leaveFor(onLogin)}>Log in</button>
  );
  if (user && confirming) {
    ending = (
      <div className="acct-confirm">
        <p>
          {sync.pending
            ? `${sync.pending === 1 ? '1 change hasn’t' : `${sync.pending} changes haven’t`} reached your account yet, and would be lost. Log out anyway?`
            : 'Your books stay in your account. Logging out removes them from this browser.'}
        </p>
        <div className="add-actions">
          <button type="button" className="btn btn-ghost" onClick={() => setConfirming(false)} disabled={busy}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void run(onLogOut)}>
            {busy ? 'Logging out…' : 'Log out'}
          </button>
        </div>
      </div>
    );
  } else if (user) {
    ending = <button type="button" role="menuitem" className="acct-item" onClick={() => setConfirming(true)}>Log out</button>;
  }

  return (
    <div className="acct" ref={root}>
      <button
        type="button"
        className="btn btn-ghost hdr-icon"
        aria-haspopup="true"
        aria-expanded={open}
        aria-label="Settings"
        title="Settings"
        onClick={() => setOpen((o) => !o)}
      >
        <IconSettings />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            className="acct-menu"
            role="menu"
            initial={{ opacity: 0, y: -4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, transition: { duration: 0.12 } }}
            transition={springs.snappy}
          >
            {user && (
              <div className="acct-who">
                <span>Logged in as</span>
                <b>{user.email}</b>
              </div>
            )}
            {user && !user.emailVerified && (
              <div className="acct-verify">
                <span>Confirm your email with the link we sent you.</span>
                <button type="button" className="login-link" disabled={busy} onClick={() => void run(async () => { await sendVerification(); setMessage('Sent. Check your inbox.'); })}>
                  Send it again
                </button>
              </div>
            )}
            {message && <p className="acct-message" role="status">{message}</p>}
            {user && <div className="acct-sep" />}
            {/* Stays open, so the covers can be seen changing behind it. */}
            {coversOnly !== undefined && (
              <button type="button" role="menuitemcheckbox" aria-checked={coversOnly} className="acct-item acct-toggle" onClick={onCoversOnly}>
                <IconEye /> Only covers
                <span className="switch" aria-hidden="true" />
              </button>
            )}
            {naming ? (
              <LibraryNames />
            ) : (
              <button type="button" role="menuitem" className="acct-item" onClick={() => setNaming(true)}>
                <IconPencil /> Rename libraries
              </button>
            )}
            <button type="button" role="menuitem" className="acct-item" onClick={() => leaveFor(onKey)}>
              <IconKey /> Library key
            </button>
            {ending}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/**
 * The two names of the switch between libraries, side by side as the switch has them.
 * Each is saved as it's left, on Enter, and as the menu closes; a blank one goes back to its default.
 */
function LibraryNames() {
  const [drafts, setDrafts] = useState<LibraryLabels>(readLabels);
  const latest = useRef(drafts);
  latest.current = drafts;

  // Closing the menu takes this away before its fields are left.
  useEffect(() => {
    const last = latest;
    return () => {
      saveName('mine', last.current.mine);
      saveName('shelf', last.current.shelf);
    };
  }, []);

  const field = (which: keyof LibraryLabels, label: string, first: boolean) => (
    <input
      className="acct-name"
      autoFocus={first}
      value={drafts[which]}
      maxLength={LABEL_CHARS}
      placeholder={DEFAULT_LABELS[which]}
      aria-label={label}
      onChange={(e) => setDrafts({ ...drafts, [which]: e.target.value })}
      onBlur={() => saveName(which, drafts[which])}
      onKeyDown={(e) => { if (e.key === 'Enter') saveName(which, drafts[which]); }}
    />
  );

  return (
    <div className="acct-names">
      <span>Library names</span>
      <div className="acct-names-row">
        {field('mine', 'Name for your own library', true)}
        {field('shelf', 'Name for the shared libraries', false)}
      </div>
    </div>
  );
}

/** Saves one of the names, where it changed. */
function saveName(which: keyof LibraryLabels, name: string) {
  if (name.trim() === readLabels()[which]) return;
  renameLabel(which, name);
}
