import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { TRACK_ID, trackKey } from '../../shared/src/music.ts';
import { fileStore } from './fetch.ts';
import { readJson, WORK, writeJson } from './lib.ts';

/*
 * YouTube, through yt-dlp: searching it, a video's details, and a track downloaded once and kept
 * in the file store, where the app plays it from (music/<id>.m4a). The soundtrack's director
 * (music.ts) uses all three. A track's audio is kept here too while the director is choosing,
 * for listening to (sound.ts), and goes once it's stored.
 */

export const MUSIC = join(WORK, 'music');
const DETAILS = join(MUSIC, 'details');
export const AUDIO = join(MUSIC, 'audio');
/** What a scene can use: not a jingle, and not an hour-long compilation. */
export const SHORTEST_S = 30;
export const LONGEST_S = 15 * 60;

export interface Found {
  id: string;
  title: string;
  channel: string;
  seconds: number;
  views: number | null;
}

export interface Video extends Found {
  description: string;
  tags: string[];
  chapters: Array<{ title: string; at: number }>;
}

interface Entry {
  id?: string;
  title?: string;
  channel?: string;
  uploader?: string;
  duration?: number;
  view_count?: number;
  description?: string;
  tags?: string[];
  chapters?: Array<{ title?: string; start_time?: number }>;
}

/** Runs yt-dlp with these arguments and hands back what it printed. Tests put in their own. */
export type Runner = (args: string[]) => Promise<string>;

function ytDlp(args: string[]): Promise<string> {
  const bin = process.env.YT_DLP || 'yt-dlp';
  // YouTube's player puzzles need a JavaScript runtime: Node, which the server's image has.
  const all = ['--js-runtimes', 'node', '--no-warnings', ...args];
  return new Promise((resolve, reject) => {
    execFile(bin, all, { maxBuffer: 256 * 1024 * 1024, timeout: 10 * 60_000 }, (err, stdout, stderr) => {
      if (!err) {
        resolve(stdout);
        return;
      }
      const last = String(stderr || err.message).trim().split('\n').pop() ?? '';
      reject(new Error(`yt-dlp failed: ${last.slice(0, 200)}`));
    });
  });
}

let runner: Runner = ytDlp;
export const useRunner = (r: Runner) => {
  runner = r;
};

export const watchUrl = (id: string) => `https://www.youtube.com/watch?v=${id}`;

function foundOf(e: Entry): Found | null {
  if (!e.id || !TRACK_ID.test(e.id)) return null;
  let views: number | null = null;
  if (typeof e.view_count === 'number') views = e.view_count;
  return {
    id: e.id,
    title: e.title ?? '',
    channel: e.channel ?? e.uploader ?? '',
    seconds: Math.round(e.duration ?? 0),
    views,
  };
}

/** YouTube's videos for a search, best match first. */
export async function search(query: string, limit: number): Promise<Found[]> {
  const out = JSON.parse(await runner(['--flat-playlist', '-J', `ytsearch${limit}:${query}`])) as { entries?: Entry[] };
  const found: Found[] = [];
  for (const e of out.entries ?? []) {
    const f = foundOf(e);
    if (f) found.push(f);
  }
  return found;
}

/** A video's details, read once. */
export async function video(id: string): Promise<Video> {
  if (!TRACK_ID.test(id)) throw new Error(`${id} isn’t a YouTube video id (11 letters, digits, - or _).`);
  const file = join(DETAILS, `${id}.json`);
  if (existsSync(file)) return readJson<Video>(file);
  const e = JSON.parse(await runner(['-J', '--skip-download', '--no-playlist', watchUrl(id)])) as Entry;
  const f = foundOf({ ...e, id });
  if (!f) throw new Error(`YouTube had nothing for ${id}.`);
  const chapters: Video['chapters'] = [];
  for (const c of e.chapters ?? []) {
    chapters.push({ title: c.title ?? '', at: Math.round(c.start_time ?? 0) });
  }
  const v: Video = {
    ...f,
    description: (e.description ?? '').slice(0, 1500),
    tags: (e.tags ?? []).slice(0, 30),
    chapters: chapters.slice(0, 60),
  };
  writeJson(file, v);
  return v;
}

/** The track's audio here, downloading it first unless it's here already. */
export async function audioFile(id: string): Promise<string> {
  if (!TRACK_ID.test(id)) throw new Error(`${id} isn’t a YouTube video id.`);
  const file = join(AUDIO, `${id}.m4a`);
  if (existsSync(file)) return file;
  mkdirSync(AUDIO, { recursive: true });
  await runner(['-f', 'bestaudio[ext=m4a]/bestaudio', '-x', '--audio-format', 'm4a', '--no-playlist', '-o', join(AUDIO, '%(id)s.%(ext)s'), watchUrl(id)]);
  if (!existsSync(file)) throw new Error(`yt-dlp downloaded ${id} but left no audio.`);
  return file;
}

async function stored(key: string): Promise<boolean> {
  const { s3, bucket } = fileStore();
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (e) {
    const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (status === 404) return false;
    throw e;
  }
}

/** Keeps a track in the file store as music/<id>.m4a, unless it's there already. */
export async function store(id: string) {
  const key = trackKey(id);
  if (await stored(key)) return;
  const file = await audioFile(id);
  const body = readFileSync(file);
  const { s3, bucket } = fileStore();
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentLength: body.length, ContentType: 'audio/mp4' }));
  rmSync(file, { force: true });
}
