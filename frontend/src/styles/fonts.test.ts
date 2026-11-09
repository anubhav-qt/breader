import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import config from '../../vite.config';

const at = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const html = readFileSync(at('../../index.html'), 'utf8');
const css = readFileSync(at('./fonts.css'), 'utf8');
const preloads = [...html.matchAll(/<link rel="preload" as="font"[^>]*href="([^"]+)"/g)].map((m) => m[1]);
const used = [...css.matchAll(/url\(\.\/fonts\/([^)]+)\)/g)].map((m) => m[1]);

describe('the card fonts', () => {
  it('are preloaded from files that are there', () => {
    expect(preloads.length).toBeGreaterThan(0);
    for (const href of preloads) {
      expect(href).toMatch(/^\/src\/styles\/fonts\/[\w-]+\.woff2$/);
      expect(existsSync(at('../..' + href)), href).toBe(true);
    }
  });

  it('are preloaded only as fonts.css asks for them, so the preload is used, not fetched twice', () => {
    for (const href of preloads) expect(used, href).toContain(href.split('/').pop());
  });

  it('name only files that are there', () => {
    for (const file of used) expect(existsSync(at('./fonts/' + file)), file).toBe(true);
  });

  it('ship with their licences', () => {
    const families = new Set(used.map((f) => f.split('-')[0]));
    for (const family of families) expect(existsSync(at(`./fonts/${family}-OFL.txt`)), family).toBe(true);
  });

  it('are never inlined into the build, however small', () => {
    const limit = config.build?.assetsInlineLimit;
    expect(typeof limit).toBe('function');
    const inline = limit as (file: string, content: Buffer) => boolean | undefined;
    for (const file of used) expect(inline(`/x/${file}`, Buffer.alloc(100)), file).toBe(false);
    expect(inline('/x/icon.svg', Buffer.alloc(100))).toBeUndefined();
  });
});
