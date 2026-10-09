import type { MangaSort } from '@breader/shared';
import type { Store } from '../lib/cache.ts';
import { log } from '../log.ts';
import type { Disk, Picture } from './disk.ts';

/*
 * Covers as Browse and a series' sheet show them: WebP, at the two widths they're drawn at, made
 * from whatever the site sent. 512 wide is the biggest any screen asks for, a card on a phone at
 * three pixels to the point (32vw of 430) or a sheet's cover on a laptop at two; 256 is a card
 * anywhere else. Each is fetched again once it's been kept as long as its list keeps covers: a day
 * for Updated, whose covers change with a new volume, three for Popular, a week for Top rated and
 * any other series. Until the new one's made, the old one is shown, then the new takes its place.
 */

export const COVER_WIDTHS = [256, 512] as const;
export type CoverWidth = (typeof COVER_WIDTHS)[number];

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** How long a cover is kept before it's fetched again, by the list its series is in. */
export const FRESH_FOR: Partial<Record<MangaSort, number>> = { latest: DAY, popular: 3 * DAY, rated: 7 * DAY };
/** A series in none of the lists, or one only searched for. */
export const FRESH_ANYWAY = 7 * DAY;
/** How long a series' list is remembered: past the next day's prefetch, which says it again. */
const LIST_KEPT = 2 * DAY;
/** How long when a cover was fetched is remembered: longer than the disk keeps any. */
const CLOCK_KEPT = 60 * DAY;
/** Past about 80, a WebP cover looks as the JPEG it's made from does, at around two thirds the bytes. */
const QUALITY = 84;
/** The browser asks again at least this often, so a cover fetched again reaches it soon. */
const LEAST_KEPT = 60;

type Sharp = (typeof import('sharp'))['default'];
let encoder: Promise<Sharp | null> | null = null;

/** sharp, or null where it can't be loaded: covers are then sent as the sites sent them. */
function sharp(): Promise<Sharp | null> {
  encoder ??= import('sharp').then(
    (m) => m.default,
    (err: unknown) => {
      log.warn({ err }, 'sharp couldn’t be loaded, so covers are sent as the sites sent them');
      return null;
    },
  );
  return encoder;
}

/** The picture as WebP, no wider than width (never wider than it was); as it was when it can't be. */
export async function webp(pic: Picture, width: number): Promise<Picture> {
  const s = await sharp();
  if (!s) return pic;
  try {
    const data = await s(pic.data, { failOn: 'none' })
      .rotate()
      .resize({ width, withoutEnlargement: true })
      .webp({ quality: QUALITY, smartSubsample: true })
      .toBuffer();
    return { data, type: 'image/webp' };
  } catch (err) {
    log.debug({ err }, 'a cover couldn’t be made WebP, so it goes as it came');
    return pic;
  }
}

/** A cover to send, its tag (changed when it's fetched again), and how many seconds the browser may keep it. */
export interface Cover {
  pic: Picture;
  tag: string;
  maxAge: number;
}

/** The cover's own picture, from its site. */
export type Original = () => Promise<Picture>;

export class Covers {
  private fetching = new Map<string, Promise<{ pics: Map<CoverWidth, Picture>; at: number }>>();
  private readonly disk: Disk;
  private readonly store: Store;

  constructor(disk: Disk, store: Store) {
    this.disk = disk;
    this.store = store;
  }

  /**
   * The cover under key (a series' own: md:, sw:) at a width: kept, or fetched and kept at every
   * width. Kept longer than its series' list keeps covers, it's fetched again behind this answer,
   * the old one sent meanwhile. early: fetched again this much before it's due, and waited for:
   * the prefetch's way, so a daily run never finds a cover a few minutes short of a day old.
   */
  async get(key: string, series: string, width: CoverWidth, original: Original, early?: number): Promise<Cover> {
    const freshFor = await this.freshFor(series);
    const now = Date.now();
    let at = await this.fetchedAt(key);
    let pic = await this.disk.get(this.nameOf(key, width));
    // Kept from before covers were timed: timed from now.
    if (pic && at === undefined) {
      at = now;
      void this.store.set(this.clockOf(key), at, CLOCK_KEPT).catch(() => {});
    }
    const due = (at ?? 0) + freshFor - (early ?? 0);
    if (!pic || at === undefined || now >= due) {
      const going = this.fetch(key, original);
      if (!pic || early !== undefined) {
        const made = await going;
        pic = made.pics.get(width)!;
        at = made.at;
      } else {
        void going.catch((err: unknown) => log.debug({ err, key }, 'a cover couldn’t be fetched again; the kept one stays'));
        // The browser asks again soon, for the new one.
        return { pic, tag: this.tagOf(at!, width), maxAge: LEAST_KEPT };
      }
    }
    const left = Math.round((at! + freshFor - now) / 1000);
    return { pic, tag: this.tagOf(at!, width), maxAge: Math.max(LEAST_KEPT, left) };
  }

  /** Whether it's kept, at the biggest width: the shelves' warming asks, so as not to fetch it twice. */
  has(key: string): Promise<boolean> {
    return this.disk.has(this.nameOf(key, COVER_WIDTHS[COVER_WIDTHS.length - 1]));
  }

  /** The prefetch says which list a series is in, the one fetched most often when it's in several. */
  async listed(series: string, freshFor: number): Promise<void> {
    await this.store.set(this.listOf(series), freshFor, LIST_KEPT);
  }

  /**
   * The cover fetched from its site, once however many ask at the same time, and made at every
   * width. The new one is written beside the old and then takes its name (disk.ts), so the old is
   * sent until the new is whole.
   */
  private fetch(key: string, original: Original) {
    let going = this.fetching.get(key);
    if (!going) {
      going = (async () => {
        const got = await original();
        const pics = new Map<CoverWidth, Picture>();
        for (const w of COVER_WIDTHS) {
          const pic = await webp(got, w);
          await this.disk.put(this.nameOf(key, w), pic.data);
          pics.set(w, pic);
        }
        const at = Date.now();
        await this.store.set(this.clockOf(key), at, CLOCK_KEPT).catch(() => {});
        return { pics, at };
      })().finally(() => this.fetching.delete(key));
      this.fetching.set(key, going);
    }
    return going;
  }

  private async freshFor(series: string): Promise<number> {
    const v = await this.store.get(this.listOf(series)).catch(() => undefined);
    if (typeof v === 'number' && v > 0) return v;
    return FRESH_ANYWAY;
  }

  private async fetchedAt(key: string): Promise<number | undefined> {
    const v = await this.store.get(this.clockOf(key)).catch(() => undefined);
    if (typeof v === 'number') return v;
    return undefined;
  }

  private nameOf(key: string, width: CoverWidth) {
    return `cover:v2:${key}:${width}`;
  }

  private clockOf(key: string) {
    return `manga:v1:cover-at:${key}`;
  }

  private listOf(series: string) {
    return `manga:v1:cover-for:${series}`;
  }

  private tagOf(at: number, width: CoverWidth) {
    return `"${at.toString(36)}-${width}"`;
  }
}
