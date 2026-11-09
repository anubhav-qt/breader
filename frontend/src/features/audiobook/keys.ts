import { useEffect } from 'react';
import { playerKey } from '../reader/keymap';
import * as player from './player';

/*
 * Live reading's keys, for an audiobook: Space and K play and pause, the arrows go back or on
 * five seconds, J and L ten, and comma and full stop a paragraph. On while its dialog is open, or
 * while it plays with the dialog closed (the button in the top bar), and never where it's typed in
 * or in another dialog.
 */

let users = 0;

function onKey(e: KeyboardEvent) {
  if (e.defaultPrevented) return;
  const t = e.target as HTMLElement | null;
  if (t?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
  const dialog = t?.closest?.('[role="dialog"]');
  if (dialog && !dialog.classList.contains('ab')) return;
  if (!player.usable()) return;
  const k = playerKey(e);
  if (!k) return;
  if (k.do === 'toggle') {
    e.preventDefault();
    if (!e.repeat) void player.toggle();
  } else if (k.do === 'seek') {
    e.preventDefault();
    void player.nudge(k.seconds);
  } else if (k.do === 'step') {
    e.preventDefault();
    void player.step(k.dir);
  }
}

/** Listens for the keys while `on`; any number of places can ask, the keys work once. */
export function useAudiobookKeys(on: boolean) {
  useEffect(() => {
    if (!on) return;
    if (users++ === 0) window.addEventListener('keydown', onKey);
    return () => {
      if (--users === 0) window.removeEventListener('keydown', onKey);
    };
  }, [on]);
}
