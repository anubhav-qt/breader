import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { IconClose } from '../../components/icons';
import { springs } from '../../lib/springs';
import { markTold, useGuideKept } from './seen';
import './guide.css';

/*
 * A tip, at the moment it's of use: one at a time, each once on this device, and only one a visit
 * in each place (the library, a book), so a tip never follows a tip. It waits a moment before it
 * shows, keeps out of the way of dialogs (`quiet`), and goes with its ×, its button or, for a
 * passing one, by itself. Tips can be turned off in the guide.
 */

export interface HintSpec {
  id: string;
  text: string;
  action?: { label: string; run: () => void };
  /** Goes by itself after this long; otherwise it stays until it's closed. */
  ms?: number;
}

/** Places a tip has been shown in this visit. */
const shownIn = new Set<string>();
const WAIT_MS = 1400;

interface Props {
  /** The tips that could be shown here, the first not yet shown going first. */
  hints: HintSpec[];
  /** Where it is, for one a visit: the library or a book. */
  place: 'library' | 'reader';
  /** Something else is up (a dialog, a book opening): no tip now, and one showing goes. */
  quiet: boolean;
}

export function Hint({ hints, place, quiet }: Props) {
  const kept = useGuideKept();
  const [on, setOn] = useState<HintSpec | null>(null);
  const next = !quiet && kept.tips && !shownIn.has(place) ? hints.find((h) => !kept.told.includes(h.id)) : undefined;
  const nextRef = useRef(next);
  nextRef.current = next;

  useEffect(() => {
    if (on || !next) return;
    const t = window.setTimeout(() => {
      const h = nextRef.current;
      if (!h || shownIn.has(place)) return;
      shownIn.add(place);
      markTold(h.id);
      setOn(h);
    }, WAIT_MS);
    return () => window.clearTimeout(t);
  }, [on, next?.id, place]); // eslint-disable-line react-hooks/exhaustive-deps

  // A dialog opening, or tips turned off, puts it away.
  useEffect(() => { if (quiet || !kept.tips) setOn(null); }, [quiet, kept.tips]);

  useEffect(() => {
    if (!on?.ms) return;
    const t = window.setTimeout(() => setOn(null), on.ms);
    return () => window.clearTimeout(t);
  }, [on]);

  return (
    <AnimatePresence>
      {on && (
        <motion.div
          key={on.id}
          className={`hint is-${place}`}
          role="status"
          initial={{ opacity: 0, y: place === 'reader' ? -6 : 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: place === 'reader' ? -4 : 4, transition: { duration: 0.14 } }}
          transition={springs.snappy}
        >
          <span className="hint-text">{on.text}</span>
          {on.action && (
            <button type="button" className="btn btn-primary hint-go" onClick={() => { setOn(null); on.action!.run(); }}>
              {on.action.label}
            </button>
          )}
          <button type="button" className="hint-x" onClick={() => setOn(null)} aria-label="Close tip">
            <IconClose />
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
