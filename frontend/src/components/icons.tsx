import type { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement>;
const base = { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const;

export const IconBack = (p: P) => (<svg {...base} {...p}><path d="M14.5 5.5 8 12l6.5 6.5" /></svg>);
export const IconList = (p: P) => (
  <svg {...base} {...p}><path d="M9 6.5h10.5M9 12h10.5M9 17.5h10.5" /><g fill="currentColor" stroke="none"><circle cx="4.8" cy="6.5" r="1.4" /><circle cx="4.8" cy="12" r="1.4" /><circle cx="4.8" cy="17.5" r="1.4" /></g></svg>
);
export const IconSidebar = (p: P) => (<svg {...base} strokeWidth={1.9} {...p}><rect x="3.5" y="5" width="17" height="14" rx="3" /><path d="M9.5 5v14" /></svg>);
export const IconUpload = (p: P) => (<svg {...base} strokeWidth={1.9} {...p}><path d="M12 15V4.5M7.5 9 12 4.5 16.5 9" /><path d="M4.5 14.5v3a2.5 2.5 0 0 0 2.5 2.5h10a2.5 2.5 0 0 0 2.5-2.5v-3" /></svg>);
export const IconPaste = (p: P) => (<svg {...base} strokeWidth={1.9} {...p}><rect x="5" y="5" width="14" height="16" rx="2.5" /><rect x="9" y="3" width="6" height="4" rx="1.2" /><path d="M8.5 12h7M8.5 16h4.5" /></svg>);
export const IconKey = (p: P) => (<svg {...base} strokeWidth={1.9} {...p}><circle cx="8" cy="14" r="4.5" /><path d="m11.3 10.8 8.2-8.2M16.5 5.5l2.5 2.5M14 8l2 2" /></svg>);
export const IconClose = (p: P) => (<svg {...base} {...p}><path d="M6 6l12 12M18 6 6 18" /></svg>);
export const IconCheck = (p: P) => (<svg {...base} strokeWidth={2.4} {...p}><path d="m5 12.5 4.5 4.5L19 7.5" /></svg>);
export const IconPlus = (p: P) => (<svg {...base} strokeWidth={2.3} {...p}><path d="M12 5v14M5 12h14" /></svg>);
export const IconLock = (p: P) => (<svg {...base} strokeWidth={1.9} {...p}><rect x="5" y="10.5" width="14" height="10" rx="2.5" /><path d="M8.2 10.5V8a3.8 3.8 0 0 1 7.6 0v2.5" /></svg>);
export const IconPeople = (p: P) => (<svg {...base} strokeWidth={1.9} {...p}><circle cx="9" cy="8.5" r="3.3" /><path d="M3.5 19.5c.6-3.3 2.8-5 5.5-5s4.9 1.7 5.5 5" /><circle cx="16.8" cy="9.3" r="2.6" /><path d="M16.5 14.4c2.2.1 3.7 1.6 4.1 4.3" /></svg>);
export const IconTrash = (p: P) => (
  <svg {...base} strokeWidth={1.9} {...p}><path d="M4.5 7h15M9.5 7V5.3c0-.7.6-1.3 1.3-1.3h2.4c.7 0 1.3.6 1.3 1.3V7" /><path d="m6.5 7 .8 11.2a2 2 0 0 0 2 1.8h5.4a2 2 0 0 0 2-1.8L17.5 7M10 11v5M14 11v5" /></svg>
);
export const IconChevron = (p: P) => (<svg {...base} {...p}><path d="m9.5 5.5 6.5 6.5-6.5 6.5" /></svg>);
export const IconPencil = (p: P) => (<svg {...base} strokeWidth={1.9} {...p}><path d="M14.5 5.5l4 4L9 19H5v-4z" /><path d="m12.5 7.5 4 4" /></svg>);
export const IconCaret = (p: P) => (<svg {...base} strokeWidth={2.2} {...p}><path d="m7 10 5 5 5-5" /></svg>);
/** A book with a plus: into the reader's own library. */
export const IconAddBook = (p: P) => (<svg {...base} strokeWidth={1.9} {...p}><path d="M5 18.5V6a2 2 0 0 1 2-2h10v11" /><path d="M5 18.5A1.5 1.5 0 0 0 6.5 20H12" /><path d="M5 18.5A1.5 1.5 0 0 1 6.5 17H12" /><path d="M18 15v6M15 18h6" /></svg>);
export const IconMore = (p: P) => (
  <svg {...base} {...p}><g fill="currentColor" stroke="none"><circle cx="6" cy="12" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="18" cy="12" r="1.7" /></g></svg>
);
export const IconStar = (p: P) => (
  <svg {...base} strokeWidth={1.8} {...p}><path d="m12 3.8 2.5 5.1 5.6.8-4 3.9.9 5.6-5-2.6-5 2.6.9-5.6-4-3.9 5.6-.8Z" /></svg>
);
export const IconSearch = (p: P) => (<svg {...base} strokeWidth={2.1} {...p}><circle cx="10.5" cy="10.5" r="6" /><path d="m15 15 5 5" /></svg>);
export const IconEye = (p: P) => (<svg {...base} strokeWidth={1.9} {...p}><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" /><circle cx="12" cy="12" r="3" /></svg>);
export const IconSettings = (p: P) => (<svg {...base} strokeWidth={1.8} {...p}><path d="M9.96 4.89L10.33 2.55A9.6 9.6 0 0 1 13.67 2.55L14.04 4.89A7.4 7.4 0 0 1 15.59 5.53L17.51 4.14A9.6 9.6 0 0 1 19.86 6.49L18.47 8.41A7.4 7.4 0 0 1 19.11 9.96L21.45 10.33A9.6 9.6 0 0 1 21.45 13.67L19.11 14.04A7.4 7.4 0 0 1 18.47 15.59L19.86 17.51A9.6 9.6 0 0 1 17.51 19.86L15.59 18.47A7.4 7.4 0 0 1 14.04 19.11L13.67 21.45A9.6 9.6 0 0 1 10.33 21.45L9.96 19.11A7.4 7.4 0 0 1 8.41 18.47L6.49 19.86A9.6 9.6 0 0 1 4.14 17.51L5.53 15.59A7.4 7.4 0 0 1 4.89 14.04L2.55 13.67A9.6 9.6 0 0 1 2.55 10.33L4.89 9.96A7.4 7.4 0 0 1 5.53 8.41L4.14 6.49A9.6 9.6 0 0 1 6.49 4.14L8.41 5.53A7.4 7.4 0 0 1 9.96 4.89Z" /><circle cx="12" cy="12" r="3" /></svg>);
export const IconOut = (p: P) => (<svg {...base} strokeWidth={2} {...p}><path d="M9 6H6.5A2.5 2.5 0 0 0 4 8.5v9A2.5 2.5 0 0 0 6.5 20h9a2.5 2.5 0 0 0 2.5-2.5V15" /><path d="M13 4h7v7M20 4l-9 9" /></svg>);
