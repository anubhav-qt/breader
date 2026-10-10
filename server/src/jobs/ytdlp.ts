import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/*
 * Keeps yt-dlp current, which the AI marker finds and downloads its soundtracks with
 * (ai/tools/youtube.ts). YouTube changes its pages often and an old yt-dlp stops working, so once
 * a day the worker has pip fetch the newest. Only the server's image has it (server/Dockerfile).
 */

const YT_DLP = '/opt/yt-dlp/bin/yt-dlp';

function run(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: 10 * 60_000 }, (err, stdout, stderr) => {
      if (!err) {
        resolve(stdout.trim());
        return;
      }
      const last = String(stderr || err.message).trim().split('\n').pop() ?? '';
      reject(new Error(last.slice(0, 300)));
    });
  });
}

/** Updates yt-dlp. Says from which version to which when it changed, and null otherwise. */
export async function updateYtDlp(ytDlp = process.env.YT_DLP || YT_DLP): Promise<object | null> {
  const pip = join(dirname(ytDlp), 'pip');
  if (!existsSync(pip)) return null;
  const before = await run(ytDlp, ['--version']);
  await run(pip, ['install', '--no-cache-dir', '--quiet', '--upgrade', 'yt-dlp[default]']);
  const after = await run(ytDlp, ['--version']);
  if (after === before) return null;
  return { from: before, to: after };
}
