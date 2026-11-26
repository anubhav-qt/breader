/*
 * Codex as NVIDIA's backup, for the harness (harness.ts) and the balancer (balancer.ts) alike.
 * NVIDIA's first model is tried and tried again, then its second; only when both are cooling
 * does a Codex model take a call. From then on Codex keeps the calls for BACKUP_MS. When that
 * time is up, NVIDIA's models are tried again afresh, their cooldowns forgotten, and Codex steps
 * back in only if they fail again. One window for the whole process: when NVIDIA is down, it is
 * down for every stage.
 */

/** How long Codex keeps the calls once it has taken over. */
export const BACKUP_MS = 10 * 60_000;

let until = 0;
const onEnd: Array<() => void> = [];

/** Whether Codex has the calls now. */
export function onBackup(now = Date.now()): boolean {
  return now < until;
}

/** Codex took a call because NVIDIA couldn't: it keeps them for the next BACKUP_MS. */
export function startBackup(now = Date.now()) {
  if (now < until) return;
  until = now + BACKUP_MS;
  console.log(`    NVIDIA can’t answer: Codex takes the calls until ${new Date(until).toISOString()}`);
}

/** Runs `fn` each time the window ends, to forget NVIDIA's cooldowns. */
export function whenBackupEnds(fn: () => void) {
  onEnd.push(fn);
}

/** Ends the window once its time is up, so NVIDIA is tried again. Called before each pick. */
export function checkBackup(now = Date.now()) {
  if (!until) return;
  if (now < until) return;
  until = 0;
  for (const fn of onEnd) fn();
}

/** For tests: no window open. */
export function resetBackup() {
  until = 0;
}
