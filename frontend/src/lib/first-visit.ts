/*
 * Whether this device had Breader on it before this visit: anything of Breader's kept already. Read
 * once, as the app loads and before anything of its own is kept, so the guide (features/guide/seen.ts)
 * and what's new (features/news/seen.ts) tell someone new apart the same way, whichever of them
 * keeps its own note first.
 */
function scan(): boolean {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      if (localStorage.key(i)?.startsWith('breader.')) return true;
    }
  } catch { /* storage blocked: as someone new */ }
  return false;
}

export const usedBefore = scan();
