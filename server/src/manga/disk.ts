import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, statfs, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { report } from '../lib/report.ts';
import { log } from '../log.ts';

/*
 * Pages and covers kept on the laptop's disk, up to a size, so a page read twice (or by two
 * readers) is asked of MangaDex or a Suwayomi source once. On the ThinkPad the budget is big enough
 * (100 GB) that a page fetched once stays; only when it's full do the pages used longest ago go,
 * and it says so (and as it nears full) so room can be made first. A file's time is when a reader
 * last used it, so that survives a restart; the keeper's checks (quiet) don't count. However big
 * the budget, it never fills the disk: it stops growing while the disk has less than FREE left,
 * whatever else is using it.
 *
 * TODO.md › Manga on an HDD: pages no one has read for 30 days move to a hard disk, whole series
 * at a time, and come back to the SSD when they're read again.
 */

/** Room always left on the disk for everything else. */
const FREE = 5 * 1024 ** 3;
/** How often the disk is asked how much room it has. */
const LOOK = 60_000;
/** Past this much of the budget, it says it's nearly full. */
const NEARLY = 0.9;
/** It says so at most this often. */
const SAY_EVERY = 24 * 3_600_000;

export interface Picture {
  data: Uint8Array;
  type: string;
}

/** What kind of picture these bytes are, from how they start; null when they aren't one. */
export function pictureType(b: Uint8Array): string | null {
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  return null;
}

const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;

export class Disk {
  private index = new Map<string, { size: number; used: number }>();
  private total = 0;
  private fetching = new Map<string, Promise<Picture>>();
  private readonly ready: Promise<void>;
  private readonly dir: string;
  private readonly budget: number;
  private readonly typeOf: (b: Uint8Array) => string | null;
  /** The disk's room, as last asked, and when. */
  private room = { free: Infinity, at: 0 };
  /** When it last said it was nearly full, and that it let pages go. */
  private said = { nearly: 0, trimmed: 0 };

  /** typeOf: what the kept bytes are, or null when they've gone bad. Pictures by default; the server voice keeps its sound here too. */
  constructor(dir: string, budget: number, typeOf: (b: Uint8Array) => string | null = pictureType) {
    this.dir = dir;
    this.budget = budget;
    this.typeOf = typeOf;
    this.ready = this.scan().catch((err) => log.warn({ err, dir }, 'manga cache unreadable; pages won’t be kept'));
  }

  private nameOf(key: string) {
    return createHash('sha256').update(key).digest('hex').slice(0, 40);
  }

  private async scan() {
    await mkdir(this.dir, { recursive: true });
    for (const name of await readdir(this.dir)) {
      const path = join(this.dir, name);
      // Half-written when the laptop stopped.
      if (name.endsWith('.part')) { await rm(path, { force: true }); continue; }
      const st = await stat(path).catch(() => null);
      if (!st?.isFile()) continue;
      this.index.set(name, { size: st.size, used: st.mtimeMs });
      this.total += st.size;
    }
    await this.trim();
  }

  /** Whether it's kept, without reading it or counting it as used. */
  async has(key: string): Promise<boolean> {
    await this.ready;
    return this.index.has(this.nameOf(key));
  }

  /** quiet: not counted as used, for checks that aren't a reader's (keeper.ts). */
  async get(key: string, quiet = false): Promise<Picture | null> {
    await this.ready;
    const name = this.nameOf(key);
    const e = this.index.get(name);
    if (!e) return null;
    try {
      const data = await readFile(join(this.dir, name));
      const type = this.typeOf(data);
      if (!type) throw new Error('Not what was kept');
      if (!quiet) {
        e.used = Date.now();
        const t = new Date(e.used);
        void utimes(join(this.dir, name), t, t).catch(() => {});
      }
      return { data, type };
    } catch {
      this.index.delete(name);
      this.total -= e.size;
      await rm(join(this.dir, name), { force: true }).catch(() => {});
      return null;
    }
  }

  async put(key: string, data: Uint8Array): Promise<void> {
    await this.ready;
    // Nothing near the whole budget is worth keeping.
    if (data.byteLength > this.budget / 4) return;
    const name = this.nameOf(key);
    const path = join(this.dir, name);
    const part = `${path}.${randomBytes(4).toString('hex')}.part`;
    try {
      await mkdir(this.dir, { recursive: true });
      await writeFile(part, data);
      await rename(part, path);
    } catch (err) {
      await rm(part, { force: true }).catch(() => {});
      log.warn({ err }, 'couldn’t keep a manga page');
      return;
    }
    const had = this.index.get(name);
    if (had) this.total -= had.size;
    this.index.set(name, { size: data.byteLength, used: Date.now() });
    this.total += data.byteLength;
    this.room.free -= data.byteLength - (had?.size ?? 0);
    await this.trim();
  }

  /** Kept, or else make()'s picture, fetched once however many ask for it at the same time, then kept. quiet: as get(). */
  async keep(key: string, make: () => Promise<Picture>, quiet = false): Promise<Picture> {
    const hit = await this.get(key, quiet);
    if (hit) return hit;
    let going = this.fetching.get(key);
    if (!going) {
      going = make()
        .then(async (pic) => {
          await this.put(key, pic.data);
          return pic;
        })
        .finally(() => this.fetching.delete(key));
      this.fetching.set(key, going);
    }
    return going;
  }

  /** Free room on the disk, asked at most once a minute. */
  private async free(): Promise<number> {
    if (Date.now() - this.room.at > LOOK) {
      this.room.at = Date.now();
      try {
        const fs = await statfs(this.dir);
        this.room.free = fs.bavail * fs.bsize;
      } catch {
        this.room.free = Infinity;
      }
    }
    return this.room.free;
  }

  /** The budget, or less while the disk is short of room: what's kept now and what's free past FREE. */
  private async allowed(): Promise<number> {
    const free = await this.free();
    return Math.min(this.budget, this.total + free - FREE);
  }

  /** Over budget: down to nine tenths of it, so it isn't trimmed again with every page. */
  private async trim() {
    const budget = await this.allowed();
    if (this.total > budget * NEARLY) this.say('nearly', `${this.dir} is nearly full: ${gb(this.total)} of ${gb(budget)}. Make room (a bigger budget, or the HDD in TODO.md) before pages start going.`);
    if (this.total <= budget) return;
    const before = this.total;
    const oldest = [...this.index].sort((a, b) => a[1].used - b[1].used);
    for (const [name, e] of oldest) {
      if (this.total <= budget * 0.9) break;
      this.index.delete(name);
      this.total -= e.size;
      this.room.free += e.size;
      await rm(join(this.dir, name), { force: true }).catch(() => {});
    }
    this.say('trimmed', `${this.dir} was full, so ${gb(before - this.total)} of what was read longest ago went.`);
  }

  /** Once a day at most, to the logs and Sentry. */
  private say(what: keyof Disk['said'], message: string) {
    if (Date.now() - this.said[what] < SAY_EVERY) return;
    this.said[what] = Date.now();
    log.warn({ dir: this.dir, bytes: this.total, budget: this.budget }, message);
    report(new Error(message), { dir: this.dir });
  }

  /** What's kept. */
  get size() {
    return { files: this.index.size, bytes: this.total };
  }
}
