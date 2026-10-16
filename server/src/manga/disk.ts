import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, rmdir, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { log } from '../log.ts';

/*
 * Pages and covers kept on the laptop's disk, up to a size, so a page read twice (or by two
 * readers) is asked of MangaDex or a Suwayomi source once. When it's full, the pages used longest ago go. A file's time
 * is when it was last used, so that survives a restart.
 *
 * What a series in any library has is kept for good (manga/keeper.ts): out of the size and out of
 * reach of the trim, in a folder of its series' own under kept/. When the series leaves every
 * library, its files go back to the rest, to go in turn.
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

/** The folder under kept/ that what a series has is kept in for good. */
const KEPT = 'kept';

interface Entry {
  size: number;
  used: number;
  /** Its series' folder under kept/, when it's kept for good; null when it may be trimmed. */
  group: string | null;
}

export class Disk {
  private index = new Map<string, Entry>();
  /** What may be trimmed: everything not kept for good. */
  private total = 0;
  /** What's kept for good. */
  private keptTotal = 0;
  private fetching = new Map<string, Promise<Picture>>();
  private readonly ready: Promise<void>;
  private readonly dir: string;
  private readonly budget: number;
  private readonly typeOf: (b: Uint8Array) => string | null;

  /** typeOf: what kind of file it keeps these bytes are, null when they aren't one (a picture, unless it keeps others too). */
  constructor(dir: string, budget: number, typeOf: (b: Uint8Array) => string | null = pictureType) {
    this.dir = dir;
    this.budget = budget;
    this.typeOf = typeOf;
    this.ready = this.scan().catch((err) => log.warn({ err, dir }, 'manga cache unreadable; pages won’t be kept'));
  }

  private nameOf(key: string) {
    return createHash('sha256').update(key).digest('hex').slice(0, 40);
  }

  /** A series' folder under kept/, by the key it's kept under (a MangaDex id, sw:12, a book's id). */
  private groupOf(series: string) {
    return createHash('sha256').update(series).digest('hex').slice(0, 24);
  }

  private folderOf(group: string | null) {
    if (group === null) return this.dir;
    return join(this.dir, KEPT, group);
  }

  private pathOf(name: string, group: string | null) {
    return join(this.folderOf(group), name);
  }

  private add(name: string, e: Entry) {
    this.index.set(name, e);
    if (e.group === null) this.total += e.size;
    else this.keptTotal += e.size;
  }

  private drop(name: string, e: Entry) {
    this.index.delete(name);
    if (e.group === null) this.total -= e.size;
    else this.keptTotal -= e.size;
  }

  /** The files in a folder, those half-written when the laptop stopped thrown away. */
  private async scanFolder(group: string | null) {
    const folder = this.folderOf(group);
    for (const name of await readdir(folder)) {
      const path = join(folder, name);
      if (name.endsWith('.part')) {
        await rm(path, { force: true });
        continue;
      }
      const st = await stat(path).catch(() => null);
      if (!st?.isFile()) continue;
      // In both places (stopped while being kept for good): the one kept for good stays.
      if (this.index.has(name)) {
        await rm(path, { force: true });
        continue;
      }
      this.add(name, { size: st.size, used: st.mtimeMs, group });
    }
  }

  private async scan() {
    await mkdir(join(this.dir, KEPT), { recursive: true });
    for (const group of await readdir(join(this.dir, KEPT))) {
      const st = await stat(join(this.dir, KEPT, group)).catch(() => null);
      if (!st?.isDirectory()) continue;
      await this.scanFolder(group);
    }
    await this.scanFolder(null);
    await this.trim();
  }

  /** Whether it's kept, without reading it or counting it as used. */
  async has(key: string): Promise<boolean> {
    await this.ready;
    return this.index.has(this.nameOf(key));
  }

  async get(key: string): Promise<Picture | null> {
    await this.ready;
    const name = this.nameOf(key);
    const e = this.index.get(name);
    if (!e) return null;
    const path = this.pathOf(name, e.group);
    try {
      const data = await readFile(path);
      const type = this.typeOf(data);
      if (!type) throw new Error('Not what it keeps');
      e.used = Date.now();
      const t = new Date(e.used);
      void utimes(path, t, t).catch(() => {});
      return { data, type };
    } catch {
      // Moved meanwhile, kept for good or let go: still there, where it went.
      if (this.pathOf(name, e.group) !== path) return null;
      if (this.index.get(name) !== e) return null;
      this.drop(name, e);
      await rm(path, { force: true }).catch(() => {});
      return null;
    }
  }

  /** Kept, or kept again; one kept for good stays so. series: kept for good with that series' files. */
  async put(key: string, data: Uint8Array, series?: string): Promise<void> {
    await this.ready;
    // Nothing near the whole budget is worth keeping.
    if (data.byteLength > this.budget / 4) return;
    const name = this.nameOf(key);
    const had = this.index.get(name);
    let group: string | null = null;
    if (had && had.group !== null) group = had.group;
    else if (series !== undefined) group = this.groupOf(series);
    const path = this.pathOf(name, group);
    const part = `${path}.${randomBytes(4).toString('hex')}.part`;
    try {
      await mkdir(this.folderOf(group), { recursive: true });
      await writeFile(part, data);
      await rename(part, path);
    } catch (err) {
      await rm(part, { force: true }).catch(() => {});
      log.warn({ err }, 'couldn’t keep a manga page');
      return;
    }
    if (had) {
      this.drop(name, had);
      // Kept for good just now: the old one, where it was, goes.
      if (had.group !== group) await rm(this.pathOf(name, had.group), { force: true }).catch(() => {});
    }
    this.add(name, { size: data.byteLength, used: Date.now(), group });
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

  /**
   * Kept for good with the files of its series (named by the key it's kept under), out of reach of
   * the trim. False when it isn't kept at all, to be fetched first.
   */
  async pin(key: string, series: string): Promise<boolean> {
    await this.ready;
    const name = this.nameOf(key);
    const e = this.index.get(name);
    if (!e) return false;
    if (e.group !== null) return true;
    const group = this.groupOf(series);
    try {
      await mkdir(this.folderOf(group), { recursive: true });
      await rename(this.pathOf(name, null), this.pathOf(name, group));
    } catch {
      // Gone from under it: fetched again.
      if (this.index.get(name) === e) this.drop(name, e);
      return false;
    }
    if (this.index.get(name) !== e) return true;
    this.drop(name, e);
    this.add(name, { ...e, group });
    return true;
  }

  /**
   * Only these series' files kept for good: any other series' go back to the rest, to be trimmed
   * in turn, as it's in no library now. Returns how many files went back.
   */
  async keepOnly(series: string[]): Promise<number> {
    await this.ready;
    const wanted = new Set(series.map((s) => this.groupOf(s)));
    let back = 0;
    for (const [name, e] of [...this.index]) {
      if (e.group === null || wanted.has(e.group)) continue;
      if (this.index.get(name) !== e) continue;
      try {
        await rename(this.pathOf(name, e.group), this.pathOf(name, null));
      } catch {
        continue;
      }
      if (this.index.get(name) !== e) continue;
      this.drop(name, e);
      this.add(name, { ...e, group: null });
      back += 1;
    }
    // Their folders, empty now.
    for (const group of await readdir(join(this.dir, KEPT)).catch(() => [] as string[])) {
      if (wanted.has(group)) continue;
      await rmdir(join(this.dir, KEPT, group)).catch(() => {});
    }
    await this.trim();
    return back;
  }

  /** Over budget: down to nine tenths of it, so it isn't trimmed again with every page. What's kept for good stays. */
  private async trim() {
    if (this.total <= this.budget) return;
    const oldest = [...this.index].filter(([, e]) => e.group === null).sort((a, b) => a[1].used - b[1].used);
    for (const [name, e] of oldest) {
      if (this.total <= this.budget * 0.9) break;
      // Kept for good or kept again meanwhile.
      if (this.index.get(name) !== e) continue;
      this.drop(name, e);
      await rm(this.pathOf(name, null), { force: true }).catch(() => {});
    }
  }

  /** What's kept, and of that, what's kept for good. */
  get size() {
    let keptFiles = 0;
    for (const e of this.index.values()) {
      if (e.group !== null) keptFiles += 1;
    }
    return { files: this.index.size, bytes: this.total + this.keptTotal, kept: { files: keptFiles, bytes: this.keptTotal } };
  }
}
