import { useEffect } from 'react';

/*
 * The browser tab's name: the book or series open, then Breader. Screen readers say it, and it
 * tells tabs apart. Back to the name before when it closes (a series page under a reader).
 */

const HOME = 'Breader';

export function pageTitle(name: string | null | undefined): string {
  const trimmed = name?.trim();
  if (!trimmed) return HOME;
  return `${trimmed} · ${HOME}`;
}

export function usePageTitle(name: string | null | undefined) {
  useEffect(() => {
    const before = document.title;
    document.title = pageTitle(name);
    return () => {
      document.title = before;
    };
  }, [name]);
}
