import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { springs } from '../lib/springs';

export interface ToastMessage {
  id: number;
  text: string;
  action?: { label: string; run: () => void };
  /** Move focus to the action, when the change was made from the keyboard. */
  focus?: boolean;
}

const SHOW_MS = 2600;
const ACTION_MS = 6000;
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

export function Toast({ toast, onDone }: { toast: ToastMessage | null; onDone: (id: number) => void }) {
  return (
    <div className="toast-host" aria-live="polite">
      <AnimatePresence>
        {toast && <ToastItem key={toast.id} toast={toast} onDone={onDone} />}
      </AnimatePresence>
    </div>
  );
}

/**
 * A message with an action stays longer, and doesn't go while the pointer or focus is on it.
 * Its action also runs on ⌘Z (Ctrl+Z), unless a text field is being edited.
 */
function ToastItem({ toast, onDone }: { toast: ToastMessage; onDone: (id: number) => void }) {
  const [held, setHeld] = useState(false);
  const { id, action } = toast;

  useEffect(() => {
    if (held) return;
    const t = window.setTimeout(() => onDone(id), action ? ACTION_MS : SHOW_MS);
    return () => window.clearTimeout(t);
  }, [held, id, action, onDone]);

  useEffect(() => {
    if (!action) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'z' || e.shiftKey || !(isMac ? e.metaKey : e.ctrlKey)) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest('input, textarea, [contenteditable="true"]')) return;
      e.preventDefault();
      action.run();
      onDone(id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [action, id, onDone]);

  return (
    <motion.div
      className={`toast${action ? ' has-action' : ''}`}
      initial={{ opacity: 0, y: 12, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 6, transition: { duration: 0.15 } }}
      transition={springs.snappy}
      onPointerEnter={() => setHeld(true)}
      onPointerLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={() => setHeld(false)}
    >
      <span className="toast-text">{toast.text}</span>
      {action && (
        <button
          type="button"
          className="toast-action"
          autoFocus={toast.focus}
          title={isMac ? '⌘Z' : 'Ctrl+Z'}
          onClick={() => { action.run(); onDone(id); }}
        >
          {action.label}
        </button>
      )}
    </motion.div>
  );
}
