import { spawn, type ChildProcess } from 'node:child_process';
import { createDecipheriv, hkdfSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { nimAlias } from '@breader/shared';
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
 *
 * It serves NVIDIA's models too, each as nimAlias(id), so the marker's harness can research with
 * one when the admin page picks it for a stage (shared/src/admin.ts). The list is NVIDIA's own,
 * public one, looked at again every NIM_LIST_MS; the proxy takes a changed config.yaml as it is.
 */

const AGAIN_MS = 60_000;
const BIN = '/usr/local/bin/cli-proxy-api';
const NIM_BASE = 'https://integrate.api.nvidia.com/v1';
const NIM_LIST_MS = 6 * 3600_000;

/**
 * The NVIDIA key: NVIDIA_NIM_API_KEY, or ai/nvidia-key.enc opened with the ADMIN_TOKEN, as the
 * marker opens it (ai/tools/seal.ts). Null when there's neither.
 */
export function nvidiaKey(adminToken: string, file = join(process.cwd(), 'ai/nvidia-key.enc')): string | null {
  if (process.env.NVIDIA_NIM_API_KEY) return process.env.NVIDIA_NIM_API_KEY;
  if (!existsSync(file)) return null;
  try {
    const raw = Buffer.from(readFileSync(file, 'utf8').trim(), 'base64');
    const key = Buffer.from(hkdfSync('sha256', adminToken, 'breader', 'nvidia key', 32));
    const d = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** Every model NVIDIA lists, or null when it doesn't answer. */
async function nimModels(): Promise<string[] | null> {
  try {
    const res = await fetch(`${NIM_BASE}/models`, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: Array<{ id?: string }> };
    return (body.data ?? []).map((m) => m.id ?? '').filter(Boolean).sort();
  } catch {
    return null;
  }
}

/** NVIDIA as one of the proxy's OpenAI-style providers, each model by its alias. */
export function nimSection(key: string, models: string[]): string {
  if (!models.length) return '';
  const lines = models.map((id) => `      - name: "${id}"\n        alias: "${nimAlias(id)}"`).join('\n');
  return `openai-compatibility:
  - name: "nvidia"
    base-url: "${NIM_BASE}"
    keys:
      - api-key: "${key}"
    models:
${lines}
`;
}

export interface CliproxyOptions {
  filesDir: string;
  adminToken?: string;
  signal: AbortSignal;
  bin?: string;
  againMs?: number;
}

function config(dir: string, apiKey: string, managementKey: string, nim = ''): string {
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
${nim}`;
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
  const nimKey = nvidiaKey(o.adminToken);
  let nim = '';
  const write = () => writeFileSync(file, config(dir, keys.apiKey, keys.managementKey, nim), { mode: 0o600 });
  // NVIDIA's list, now and every few hours: written in only when it changed.
  const listNim = async () => {
    if (!nimKey) return;
    const models = await nimModels();
    if (!models) return;
    const now = nimSection(nimKey, models);
    if (now === nim) return;
    nim = now;
    write();
  };
  if (nimKey) {
    void listNim();
    const every = setInterval(() => void listNim(), NIM_LIST_MS);
    o.signal.addEventListener('abort', () => clearInterval(every));
  }

  const run = () => {
    write();
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
