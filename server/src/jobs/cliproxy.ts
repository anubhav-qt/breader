import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLIPROXY_PORT, cliproxyKeys } from '../lib/cliproxy.ts';
import { log } from '../log.ts';

/*
 * CLIProxyAPI (lib/cliproxy.ts), run by the worker as a process of its own, the way the AI marker
 * is, and started again a minute after it stops. Only the server's image has it. Its settings are
 * written fresh at each start into files/ai/cliproxy, beside the accounts' sign-ins, which outlive
 * the container. It listens on the compose network, which nothing outside this machine reaches:
 * the API asks it about the accounts for the admin page, and the marker uses its models.
 *
 * With several Antigravity accounts it uses one until that one reaches a limit, then the next
 * (fill-first), so the ones after it keep theirs for later.
 */

const AGAIN_MS = 60_000;
const BIN = '/usr/local/bin/cli-proxy-api';

export interface CliproxyOptions {
  filesDir: string;
  adminToken?: string;
  signal: AbortSignal;
  bin?: string;
  againMs?: number;
}

function config(dir: string, apiKey: string, managementKey: string): string {
  return `config-version: 8
server:
  host: ""
  port: ${CLIPROXY_PORT}
management:
  # The API asks from its own container.
  allow-remote: true
  secret-key: "${managementKey}"
  disable-control-panel: true
access:
  api-keys:
    - "${apiKey}"
oauth:
  auth-dir: "${join(dir, 'auths')}"
  providers:
    antigravity:
      # Only the subscription's own limits: never Google's paid credits.
      antigravity-credits: false
routing:
  strategy: "fill-first"
observability:
  logs:
    logging-to-file: false
    request-log: false
`;
}

/**
 * Starts the proxy, and says how the marker reaches it: the settings for its environment. Null
 * when this build has no proxy or there's no ADMIN_TOKEN to make its keys from.
 */
export function startCliproxy(o: CliproxyOptions): Record<string, string> | null {
  const bin = o.bin ?? BIN;
  const againMs = o.againMs ?? AGAIN_MS;
  if (!existsSync(bin)) {
    log.info('no CLIProxyAPI in this build');
    return null;
  }
  if (!o.adminToken) {
    log.warn('ADMIN_TOKEN is not set, so the AI accounts’ proxy is off');
    return null;
  }
  const keys = cliproxyKeys(o.adminToken);
  const dir = join(o.filesDir, 'ai/cliproxy');
  mkdirSync(join(dir, 'auths'), { recursive: true });
  const file = join(dir, 'config.yaml');

  let child: ChildProcess | null = null;
  let timer: NodeJS.Timeout | undefined;

  const run = () => {
    writeFileSync(file, config(dir, keys.apiKey, keys.managementKey), { mode: 0o600 });
    child = spawn(bin, ['-config', file], { cwd: dir, stdio: 'inherit' });
    child.on('error', (err) => log.warn({ err }, 'the AI accounts’ proxy could not start'));
    child.on('exit', (code, signal) => {
      child = null;
      if (o.signal.aborted) return;
      log.warn({ code, signal }, 'the AI accounts’ proxy stopped, starting it again in a minute');
      timer = setTimeout(run, againMs);
    });
  };

  o.signal.addEventListener('abort', () => {
    clearTimeout(timer);
    child?.kill('SIGTERM');
  });
  run();
  return {
    CLIPROXY_URL: `http://127.0.0.1:${CLIPROXY_PORT}`,
    CLIPROXY_API_KEY: keys.apiKey,
    CLIPROXY_MANAGEMENT_KEY: keys.managementKey,
  };
}
