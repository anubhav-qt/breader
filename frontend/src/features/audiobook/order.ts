/**
 * Parts finish in any order; `onRun` hears only when the unbroken run from `from` grows: how far
 * it reaches now, and the bytes of the parts it took in.
 */
export function inOrder(from: number, onRun: (done: number, bytes: number) => void) {
  const waiting = new Map<number, number>();
  let done = from;
  return (n: number, bytes: number) => {
    waiting.set(n, bytes);
    const before = done;
    let added = 0;
    while (waiting.has(done)) {
      added += waiting.get(done)!;
      waiting.delete(done);
      done++;
    }
    if (done > before) onRun(done, added);
  };
}
