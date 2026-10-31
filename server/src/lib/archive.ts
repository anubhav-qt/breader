import { join } from 'node:path';
import { promisify } from 'node:util';
import { gunzip, gzip } from 'node:zlib';
import { Disk } from '../manga/disk.ts';

/*
 * Everything fetched from elsewhere, kept for good on the laptop's disk, so that if AniList, MangaDex
 * or a source goes away, Breader still has what it had: every answer a Memo kept (lib/cache.ts), as
 * gzipped JSON, and every page and cover a reader or the keeper fetched (manga/disk.ts). Up to its
 * own budget, apart from the page cache's: answers first, pages in what they leave, so it's the pages
 * read longest ago that go when it's full, never what the sites said.
 *
 * A Memo whose site doesn't answer gives what's here instead; a page gone from the page cache comes
 * back from here before anyone is asked for it.
 */

const zip = promisify(gzip);
const unzip = promisify(gunzip);

const gzipped = (b: Uint8Array) => (b.length > 2 && b[0] === 0x1f && b[1] === 0x8b ? 'application/gzip' : null);

/** An answer as it's kept: what it answered, and when. */
interface Kept {
  kind: string;
  key: string;
  at: number;
  v: unknown;
}

export class Archive {
  /** Pages and covers, behind the page cache. */
  readonly pages: Disk;
  private readonly data: Disk;

  constructor(dir: string, budget: number) {
    this.data = new Disk(join(dir, 'data'), budget, gzipped);
    this.pages = new Disk(join(dir, 'pages'), () => Math.max(0, budget - this.data.size.bytes));
  }

  /** Keeps an answer, in the background. */
  keep(kind: string, key: string, v: unknown): void {
    if (v === undefined) return;
    const kept: Kept = { kind, key, at: Date.now(), v };
    void zip(JSON.stringify(kept))
      .then((data) => this.data.put(`${kind}:${key}`, data))
      .catch(() => {});
  }

  /** The answer last kept, if any. */
  async find(kind: string, key: string): Promise<{ at: number; v: unknown } | undefined> {
    const hit = await this.data.get(`${kind}:${key}`);
    if (!hit) return undefined;
    try {
      const kept = JSON.parse((await unzip(hit.data)).toString('utf8')) as Kept;
      // Two keys can't share a file name, but make sure.
      if (kept.kind !== kind || kept.key !== key) return undefined;
      return { at: kept.at, v: kept.v };
    } catch {
      return undefined;
    }
  }

  get size() {
    const d = this.data.size;
    const p = this.pages.size;
    return { answers: d.files, pages: p.files, bytes: d.bytes + p.bytes };
  }
}
