import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import vm from 'node:vm';
import { gcm } from '@noble/ciphers/aes.js';
import * as cheerio from 'cheerio';
import dayjs from 'dayjs';
import * as htmlparser2 from 'htmlparser2';
import { log } from '../log.ts';
import type { Fetcher } from './fetch.ts';

/*
 * LNReader's plugins (github.com/LNReader/lnreader-plugins, MIT), one for each novel site: their
 * list and their code, kept in NOVELS_DIR so a restart doesn't fetch them again, and brought up to
 * date once a day (update). Each is a small CommonJS script that asks for its site's pages through
 * @libs/fetch and reads them with cheerio. They run in this process, which holds no secrets and
 * reaches nothing of Breader's but the API that asks it (infra/compose.yml): what a plugin could
 * do here, it could do on any phone running LNReader.
 */

/** LNReader's list of its plugins, their versions and where their code is. */
export const PLUGIN_LIST = 'https://raw.githubusercontent.com/LNReader/lnreader-plugins/plugins/v3.0.0/.dist/plugins.min.json';

/** A plugin as the list has it, its language as a code (en). */
export interface PluginMeta {
  id: string;
  name: string;
  site: string;
  lang: string;
  version: string;
  url: string;
}

export interface NovelItem {
  name: string;
  path: string;
  cover?: string;
}

export interface ChapterItem {
  name: string;
  path: string;
  releaseTime?: string | null;
  chapterNumber?: number;
  page?: string;
}

export interface SourceNovel extends NovelItem {
  genres?: string;
  summary?: string;
  author?: string;
  artist?: string;
  status?: string;
  chapters?: ChapterItem[];
  /** For a site that lists its chapters page by page (parsePage). */
  totalPages?: number;
}

interface FilterValue {
  value: unknown;
  type: string;
}

/** What a plugin is, as LNReader's Plugin.PluginBase and PagePlugin describe it. */
export interface Plugin {
  id: string;
  name: string;
  site: string;
  version: string;
  filters?: Record<string, FilterValue>;
  imageRequestInit?: { method?: string; headers?: Record<string, string>; body?: string };
  popularNovels(page: number, options: { showLatestNovels?: boolean; filters?: Record<string, FilterValue> }): Promise<NovelItem[]>;
  searchNovels(q: string, page: number): Promise<NovelItem[]>;
  parseNovel(path: string): Promise<SourceNovel>;
  parsePage?(path: string, page: string): Promise<{ chapters: ChapterItem[] }>;
  parseChapter(path: string): Promise<string>;
  resolveUrl?(path: string, isNovel?: boolean): string;
}

export interface Loaded {
  meta: PluginMeta;
  plugin: Plugin;
}

/** The cover a plugin gives a novel with none of its own. */
export const DEFAULT_COVER = 'https://github.com/LNReader/lnreader-plugins/blob/main/icons/src/coverNotAvailable.jpg?raw=true';

const NovelStatus = {
  Unknown: 'Unknown',
  Ongoing: 'Ongoing',
  Completed: 'Completed',
  Licensed: 'Licensed',
  PublishingFinished: 'Publishing Finished',
  Cancelled: 'Cancelled',
  OnHiatus: 'On Hiatus',
  STUB: 'STUB',
  Inactive: 'Inactive',
};
const FilterTypes = { TextInput: 'Text', Picker: 'Picker', CheckboxGroup: 'Checkbox', Switch: 'Switch', ExcludableCheckboxGroup: 'XCheckbox' };

/** The list's languages, as they name themselves, and their codes. */
const LANGS: Record<string, string> = {
  English: 'en',
  'Русский': 'ru',
  'العربية': 'ar',
  'Français': 'fr',
  'Español': 'es',
  'Türkçe': 'tr',
  'Português': 'pt',
  'Bahasa Indonesia': 'id',
  '中文, 汉语, 漢語': 'zh',
  'Tiếng Việt': 'vi',
  '日本語': 'ja',
  '조선말, 한국어': 'ko',
  'ไทย': 'th',
  'Українська': 'uk',
  Polski: 'pl',
  Multi: 'multi',
};

export function langOf(name: string): string {
  const bare = name.replace(/[‎‏]/g, '').trim();
  return LANGS[bare] ?? 'other';
}

/** A url, as a plugin's own isUrlAbsolute tells it. */
function isUrlAbsolute(url: string): boolean {
  if (!url) return false;
  if (url.indexOf('//') === 0) return true;
  if (url.indexOf('://') === -1) return false;
  if (url.indexOf('.') === -1) return false;
  if (url.indexOf('/') === -1) return false;
  if (url.indexOf(':') > url.indexOf('/')) return false;
  return url.indexOf('://') < url.indexOf('.');
}

/** A plugin's own store, as LNReader's @libs/storage: kept in memory, each value until it expires. */
class Storage {
  private db = new Map<string, { value: unknown; expires?: number; created: Date }>();

  set(key: string, value: unknown, expires?: Date | number) {
    let until = expires;
    if (expires instanceof Date) until = expires.getTime();
    this.db.set(key, { value, expires: until as number | undefined, created: new Date() });
  }

  get(key: string, raw?: boolean) {
    const item = this.db.get(key);
    if (item?.expires && Date.now() > item.expires) {
      this.db.delete(key);
      return undefined;
    }
    if (raw) return item;
    return item?.value;
  }

  getAllKeys() {
    return [...this.db.keys()];
  }

  delete(key: string) {
    this.db.delete(key);
  }

  clearAll() {
    this.db.clear();
  }
}

/** What a plugin may require: LNReader's libraries, each plugin with its own store. */
function libsFor(fetcher: Fetcher): Record<string, unknown> {
  const empty = { get: () => ({}) };
  return {
    '@libs/fetch': fetcher,
    '@libs/storage': { storage: new Storage(), localStorage: empty, sessionStorage: empty },
    '@libs/filterInputs': { FilterTypes },
    '@libs/novelStatus': { NovelStatus },
    '@libs/defaultCover': { defaultCover: DEFAULT_COVER },
    '@libs/isAbsoluteUrl': { isUrlAbsolute },
    '@libs/aes': { gcm },
    '@/types/constants': { NovelStatus, defaultCover: DEFAULT_COVER },
    cheerio,
    htmlparser2,
    dayjs,
  };
}

/** A plugin's code run, its plugin given back. Throws when it asks for what isn't here, or doesn't make one. */
export function loadPlugin(code: string, id: string, fetcher: Fetcher): Plugin {
  const libs = libsFor(fetcher);
  const module = { exports: {} as Record<string, unknown> };
  const need = (name: string) => {
    if (name in libs) return libs[name];
    throw new Error(`The plugin asks for ${name}`);
  };
  const run = vm.runInThisContext(`(function (require, module, exports) {${code}\n})`, { filename: `plugin:${id}` }) as (
    req: typeof need,
    mod: typeof module,
    exp: Record<string, unknown>,
  ) => void;
  run.call(module.exports, need, module, module.exports);
  let plugin = module.exports as unknown as Plugin;
  if (module.exports.default) plugin = module.exports.default as Plugin;
  if (typeof plugin?.popularNovels !== 'function' || typeof plugin.parseChapter !== 'function') {
    throw new Error('Not a plugin');
  }
  return plugin;
}

interface RawMeta {
  id: string;
  name: string;
  site: string;
  lang: string;
  version: string;
  url: string;
}

export interface Updated {
  updated: string[];
  failed: string[];
}

export class Plugins {
  private loaded = new Map<string, Loaded>();
  private readonly dir: string;
  private readonly listUrl: string;
  private readonly fetcher: Fetcher;
  private readonly fetchFn: typeof fetch;

  constructor(opts: { dir: string; fetcher: Fetcher; listUrl?: string; fetch?: typeof fetch }) {
    this.dir = opts.dir;
    this.fetcher = opts.fetcher;
    this.listUrl = opts.listUrl ?? PLUGIN_LIST;
    this.fetchFn = opts.fetch ?? fetch;
  }

  get(id: string): Loaded | undefined {
    return this.loaded.get(id);
  }

  all(): Loaded[] {
    return [...this.loaded.values()];
  }

  /** The plugins kept from last time, or fetched when there are none. */
  async start(): Promise<void> {
    let kept: PluginMeta[] = [];
    try {
      kept = JSON.parse(await readFile(join(this.dir, 'plugins.json'), 'utf8')) as PluginMeta[];
    } catch {
      // None kept yet.
    }
    for (const meta of kept) {
      try {
        const code = await readFile(this.codePath(meta.id), 'utf8');
        this.loaded.set(meta.id, { meta, plugin: loadPlugin(code, meta.id, this.fetcher) });
      } catch (err) {
        log.warn({ err, plugin: meta.id }, 'a kept novel plugin couldn’t be loaded');
      }
    }
    if (this.loaded.size === 0) await this.update();
    log.info({ plugins: this.loaded.size }, 'novel plugins loaded');
  }

  /**
   * The list fetched again: each plugin with a new version (or new to the list) fetched and loaded,
   * and those the list dropped let go. Null when nothing changed. One that fails keeps its old version.
   */
  async update(): Promise<Updated | null> {
    const res = await this.fetchFn(this.listUrl, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`LNReader’s plugin list answered ${res.status}`);
    const list = (await res.json()) as RawMeta[];
    const updated: string[] = [];
    const failed: string[] = [];
    const listed = new Set<string>();
    for (const raw of list) {
      if (!/^[\w.-]{1,40}$/.test(raw.id)) continue;
      listed.add(raw.id);
      const had = this.loaded.get(raw.id);
      if (had && had.meta.version === raw.version) continue;
      const meta: PluginMeta = { id: raw.id, name: raw.name, site: raw.site, lang: langOf(raw.lang), version: raw.version, url: raw.url };
      try {
        const got = await this.fetchFn(raw.url, { signal: AbortSignal.timeout(60_000) });
        if (!got.ok) throw new Error(`Its code answered ${got.status}`);
        const code = await got.text();
        const plugin = loadPlugin(code, raw.id, this.fetcher);
        await this.keep(this.codePath(raw.id), code);
        this.loaded.set(raw.id, { meta, plugin });
        updated.push(`${raw.name} ${raw.version}`);
      } catch (err) {
        log.warn({ err, plugin: raw.id }, 'a novel plugin couldn’t be updated');
        failed.push(raw.name);
      }
    }
    for (const id of [...this.loaded.keys()]) {
      if (!listed.has(id)) this.loaded.delete(id);
    }
    await this.keep(join(this.dir, 'plugins.json'), JSON.stringify(this.all().map((l) => l.meta)));
    if (updated.length === 0 && failed.length === 0) return null;
    return { updated, failed };
  }

  private codePath(id: string) {
    return join(this.dir, 'code', `${id}.js`);
  }

  /** Written beside, then put in its place, so a stop halfway leaves the old one whole. */
  private async keep(path: string, text: string) {
    await mkdir(join(this.dir, 'code'), { recursive: true });
    await writeFile(`${path}.part`, text);
    await rename(`${path}.part`, path);
  }
}
