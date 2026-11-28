import { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { springs } from '../lib/springs';
import { IconClose } from './icons';
import { wrapTab } from './tabWrap';
import './modal.css';
import type { Elements } from '../lib/elements';

interface Props {
  title: string;
  onClose: () => void;
  children: Elements;
  width?: number;
  className?: string;
}

/** True when no other dialog or popover is open over this one. */
function isTopDialog(dialog: HTMLElement): boolean {
  const dialogs = document.querySelectorAll('[role="dialog"]');
  return dialogs[dialogs.length - 1] === dialog;
}

const TABBABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Tab and Shift+Tab go round the dialog's own buttons and fields, never out to the page behind. */
function keepTabInside(dialog: HTMLElement, e: KeyboardEvent) {
  const stops = [...dialog.querySelectorAll<HTMLElement>(TABBABLE)].filter((el) => el.getClientRects().length > 0);
  if (stops.length === 0) {
    e.preventDefault();
    dialog.focus();
    return;
  }
  const at = stops.indexOf(document.activeElement as HTMLElement);
  const next = wrapTab(stops.length, at, e.shiftKey);
  if (next === null) return;
  e.preventDefault();
  stops[next].focus();
}

/**
 * Hands focus back as a dialog closes: to what had it before, or, when that is gone (the button
 * the dialog replaced, an item of a closed menu), to the page's main part. Never away from another
 * dialog that has opened meanwhile.
 */
function giveBack(prev: HTMLElement | null) {
  const holder = document.activeElement;
  if (holder instanceof HTMLElement && holder.closest('[role="dialog"]')) return;
  if (prev?.isConnected) {
    prev.focus({ preventScroll: true });
    return;
  }
  document.querySelector<HTMLElement>('main[tabindex="-1"]')?.focus({ preventScroll: true });
}

/** Centred dialog. Render it inside <AnimatePresence> so it can animate out. */
export function Modal({ title, onClose, children, width = 460, className = '' }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  // What had focus before the dialog: read while drawing, before a field inside takes focus.
  const [prev] = useState(() => document.activeElement as HTMLElement | null);
  // A field or button inside that asked for focus (autoFocus) keeps it; otherwise the dialog takes it.
  const asked = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const dialog = ref.current;
    const active = document.activeElement;
    if (dialog && active instanceof HTMLElement && active !== dialog && dialog.contains(active)) {
      asked.current = active;
    }
    if (asked.current?.isConnected) {
      asked.current.focus();
    } else {
      dialog?.focus();
    }
    const onKey = (e: KeyboardEvent) => {
      // A popover or dialog opened over this one handles its keys first, on its own.
      if (!dialog || !isTopDialog(dialog)) return;
      if (e.key === 'Escape') {
        closeRef.current();
        return;
      }
      if (e.key === 'Tab') keepTabInside(dialog, e);
    };
    // A step that swaps what the dialog shows can take away the focused button, and focus falls to
    // the page behind. The dialog takes it back, so a keyboard or screen reader stays inside.
    let lost = 0;
    const onFocusOut = (e: FocusEvent) => {
      if (e.relatedTarget) return;
      window.clearTimeout(lost);
      lost = window.setTimeout(() => {
        if (!dialog?.isConnected) return;
        if (document.activeElement !== document.body) return;
        if (!isTopDialog(dialog)) return;
        dialog.focus({ preventScroll: true });
      });
    };
    window.addEventListener('keydown', onKey);
    dialog?.addEventListener('focusout', onFocusOut);
    return () => {
      window.removeEventListener('keydown', onKey);
      dialog?.removeEventListener('focusout', onFocusOut);
      window.clearTimeout(lost);
      giveBack(prev);
    };
  }, [prev]);

  return (
    <div className="modal-root">
      <motion.div className="modal-scrim" onClick={onClose} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }} />
      <motion.div
        ref={ref}
        className={`modal ${className}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        style={{ width }}
        initial={{ opacity: 0, scale: 0.96, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.97, y: 4, transition: { duration: 0.15 } }}
        transition={springs.snappy}
      >
        <div className="modal-head">
          <h2 className="modal-title">{title}</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
            <IconClose />
          </button>
        </div>
        {children}
      </motion.div>
    </div>
  );
}
