import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { log } from '../log.ts';

/*
 * Pages and covers kept on the laptop's disk, up to a size, so a page read twice (or by two
 * readers) is asked of MangaDex or a Suwayomi source once. When it's full, the pages used longest ago go. A file's time
 * is when it was last used, so that survives a restart.
 */

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

export class Disk {
  private index = new Map<string, { size: number; used: number }>();
  private total = 0;
  private fetching = new Map<string, Promise<Picture>>();
  private readonly ready: Promise<void>;
  private readonly dir: string;
  private readonly budget: number;

  constructor(dir: string, budget: number) {
    this.dir = dir;
    this.budget = budget;
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

  async get(key: string): Promise<Picture | null> {
    await this.ready;
    const name = this.nameOf(key);
    const e = this.index.get(name);
    if (!e) return null;
    try {
      const data = await readFile(join(this.dir, name));
      const type = pictureType(data);
      if (!type) throw new Error('Not a picture');
      e.used = Date.now();
      const t = new Date(e.used);
      void utimes(join(this.dir, name), t, t).catch(() => {});
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
    await this.trim();
  }

  /** Kept, or else make()'s picture, fetched once however many ask for it at the same time, then kept. */
  async keep(key: string, make: () => Promise<Picture>): Promise<Picture> {
    const hit = await this.get(key);
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

  /** Over budget: down to nine tenths of it, so it isn't trimmed again with every page. */
  private async trim() {
    if (this.total <= this.budget) return;
    const oldest = [...this.index].sort((a, b) => a[1].used - b[1].used);
    for (const [name, e] of oldest) {
      if (this.total <= this.budget * 0.9) break;
      this.index.delete(name);
      this.total -= e.size;
      await rm(join(this.dir, name), { force: true }).catch(() => {});
    }
  }

  /** What's kept. */
  get size() {
    return { files: this.index.size, bytes: this.total };
  }
}
