/*
 * The ways between the reader's own library and the shared ones (LibrarySwitch), to pick from. The
 * preview bar switches between them while one is picked.
 */

export type SwitchStyle = 'title' | 'pill' | 'bottom';

export const SWITCH_STYLES: Array<{ id: SwitchStyle; label: string }> = [
  { id: 'title', label: 'Title menu' },
  { id: 'pill', label: 'Header pill' },
  { id: 'bottom', label: 'Bottom switch' },
];
