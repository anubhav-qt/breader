import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { log } from '../log.ts';

/*
 * The AI marker (ai/tools/marker.ts): voice marks, then Revisit notes, for every book whose AI
 * switch is on, for good. The worker runs it as a process of its own, so neither takes the other
 * down, and starts it again a minute after it crashes. Only the server's image has it
 * (ai/dist/marker.js). It ends by itself when it has no NVIDIA key, as in a stack for
 * development, and then stays off until the worker starts again. Its work goes in the files
 * directory, which outlives the container.
 */

const AGAIN_MS = 60_000;

export interface MarkerOptions {
  filesDir: string;
  signal: AbortSignal;
  script?: string;
  againMs?: number;
}

export function startMarker(o: MarkerOptions) {
  const script = o.script ?? join(process.cwd(), 'ai/dist/marker.js');
  const againMs = o.againMs ?? AGAIN_MS;
  if (!existsSync(script)) {
    log.info('no AI marker in this build');
    return;
  }
  let child: ChildProcess | null = null;
  let timer: NodeJS.Timeout | undefined;

  const run = () => {
    child = spawn(process.execPath, ['--enable-source-maps', script], {
      env: { ...process.env, AI_WORK: join(o.filesDir, 'ai/work'), AI_OUT: join(o.filesDir, 'ai/out') },
      stdio: 'inherit',
    });
    child.on('error', (err) => log.warn({ err }, 'the AI marker could not start'));
    child.on('exit', (code, signal) => {
      child = null;
      if (o.signal.aborted) return;
      if (code === 0) {
        log.info('the AI marker is off');
        return;
      }
      log.warn({ code, signal }, 'the AI marker stopped, starting it again in a minute');
      timer = setTimeout(run, againMs);
    });
  };

  o.signal.addEventListener('abort', () => {
    clearTimeout(timer);
    child?.kill('SIGTERM');
  });
  run();
}
