import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BOOKS } from './features/guide/cards';

/*
 * What search engines read before any script runs: robots.txt lets them in, the sitemap lists the
 * public pages, the public pages aren't hidden from them, and an unknown address answers 404
 * (Cloudflare Pages serves public/404.html for it, with that status).
 */

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

const robots = read('../public/robots.txt');
const sitemap = read('../public/sitemap.xml');
const home = read('../index.html');
const privacy = read('../public/privacy.html');
const missing = read('../public/404.html');

describe('robots.txt', () => {
  it('blocks nothing for every crawler', () => {
    expect(robots).toMatch(/^User-agent: \*$/m);
    expect(robots).not.toMatch(/^Disallow: \/\s*$/m);
  });

  it('points to the sitemap', () => {
    expect(robots).toMatch(/^Sitemap: https:\/\/breader\.site\/sitemap\.xml$/m);
  });
});

describe('sitemap.xml', () => {
  it('lists the home page and the privacy page, by their canonical addresses', () => {
    const listed = [...sitemap.matchAll(/<loc>(.+?)<\/loc>/g)].map((m) => m[1]);
    expect(listed).toEqual(['https://breader.site/', 'https://breader.site/privacy']);
  });
});

describe('public pages', () => {
  it.each([
    ['home', home, 'https://breader.site/'],
    ['privacy', privacy, 'https://breader.site/privacy'],
  ])('the %s page can be indexed and names its own address', (_name, html, url) => {
    expect(html).not.toMatch(/noindex/);
    expect(html).toContain(`<link rel="canonical" href="${url}" />`);
    expect(html).toMatch(/<meta name="description" content=".+" \/>/);
  });

  it('the home page says what Breader is before any script runs, in the empty library’s words', () => {
    expect(home).toContain('<h1 class="wl-h">Start with a book</h1>');
    for (const card of BOOKS) {
      expect(home).toContain(`<b>${card.name}</b><span>${card.what}</span>`);
    }
  });

  it('keeps the tag that proves to Google Search Console the site is ours', () => {
    expect(home).toContain('<meta name="google-site-verification" content="zKlPGbwGdknb6y-z_4KmPNR6XWhsMWmAchUxQaouB00" />');
  });

  it('keeps the IndexNow key file, named for the key it holds', () => {
    const key = '843f0dfa3440c7c76b9d86d0aff7f6e0';
    expect(read(`../public/${key}.txt`).trim()).toBe(key);
  });

  it('an unknown address gets a page kept out of search', () => {
    expect(missing).toContain('<meta name="robots" content="noindex" />');
  });
});
