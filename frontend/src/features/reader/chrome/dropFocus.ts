import { useEffect, useRef, type RefObject } from 'react';

/*
 * The reader's drops (Contents, Aa, Search, the voices...) sit at the end of the page, after every
 * control, so Tab from the button that opened one never reached it. A drop takes the focus as it
 * opens, unless something in it already took it (Search's field), and the focus goes back to the
 * button that opened it when it closes.
 */

const IN_DROP = '[data-panel]';

/** A drop takes the focus as it opens, so Tab goes through it next. */
export function useTakeFocus(drop: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = drop.current;
    if (!el) return;
    if (el.contains(document.activeElement)) return;
    el.focus({ preventScroll: true });
  }, [drop]);
}

/** Once every drop is closed, the focus goes back to the control that opened the last one. */
export function useGiveFocusBack(open: boolean) {
  // The last control used outside the drops: the one that opened the drop, as a rule.
  const opener = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const keep = (target: EventTarget | null) => {
      if (!(target instanceof HTMLElement)) return;
      if (target.closest(IN_DROP)) return;
      opener.current = target;
    };
    // A click on a button doesn't focus it in Safari, so a press counts too.
    const onDown = (e: PointerEvent) => {
      const target = e.target instanceof Element ? e.target.closest('button') : null;
      keep(target);
    };
    const onFocus = (e: FocusEvent) => keep(e.target);
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('focusin', onFocus);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('focusin', onFocus);
    };
  }, []);

  useEffect(() => {
    if (open) return;
    const back = opener.current;
    if (!back || !back.isConnected) return;
    const holder = document.activeElement;
    const lost = !holder || holder === document.body || holder.closest(IN_DROP) !== null;
    if (lost) back.focus({ preventScroll: true });
  }, [open]);
}
