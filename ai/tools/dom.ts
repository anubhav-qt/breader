import { JSDOM } from 'jsdom';

/*
 * The app's own parsers (frontend/src/books) and paragraph rules (reader/dom.ts) run here
 * unchanged, on jsdom, so every paragraph gets the number the reader gives it. Load this before
 * them: DOMPurify binds to the window it finds when it's first imported.
 */

const { window } = new JSDOM('<!doctype html><html><body></body></html>');
const g = globalThis as unknown as Record<string, unknown>;
const w = window as unknown as Record<string, unknown>;
g.window = window;
g.document = window.document;
for (const name of ['DOMParser', 'Node', 'NodeFilter', 'Element', 'HTMLElement', 'DocumentFragment', 'XMLSerializer']) {
  g[name] ??= w[name];
}
