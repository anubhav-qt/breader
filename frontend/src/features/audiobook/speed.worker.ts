/// <reference lib="webworker" />

/*
 * How fast this device's processor is, off the page's thread: multiply-adds a second, as a voice
 * engine does them. A few short rounds, the best one kept, so a busy moment doesn't count.
 */

const N = 96;
const a = new Float32Array(N * N).map((_, i) => ((i * 7) % 13) / 13);
const b = new Float32Array(N * N).map((_, i) => ((i * 5) % 11) / 11);
const c = new Float32Array(N * N);

function round(ms: number) {
  const until = performance.now() + ms;
  let n = 0;
  while (performance.now() < until) {
    for (let i = 0; i < N; i++) {
      for (let k = 0; k < N; k++) {
        const x = a[i * N + k];
        for (let j = 0; j < N; j++) c[i * N + j] += x * b[k * N + j];
      }
    }
    n++;
  }
  return (n * N * N * N) / (ms / 1000);
}

self.onmessage = () => {
  let best = 0;
  for (let r = 0; r < 4; r++) best = Math.max(best, round(50));
  (self as unknown as DedicatedWorkerGlobalScope).postMessage({ score: best / 1e9, sink: c[0] });
};
