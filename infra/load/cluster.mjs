// Load test only: runs COPIES copies of the API on one port, the way Node's cluster shares a port.
// Not safe for production yet: each copy keeps its own pacing, rate limits, disk budget and jobs
// (docs/load-tests.md).
import cluster from 'node:cluster';

const copies = Number(process.env.COPIES || 1);

if (cluster.isPrimary) {
  for (let i = 0; i < copies; i++) cluster.fork({ COPY: String(i) });
  process.on('SIGTERM', () => {
    for (const worker of Object.values(cluster.workers)) worker.kill('SIGTERM');
  });
} else {
  await import('/app/dist/api.js');
}
