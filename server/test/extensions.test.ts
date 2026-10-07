import { describe, expect, it } from 'vitest';
import { updateExtensions } from '../src/jobs/extensions.ts';

/*
 * The daily update of Suwayomi's extensions, against a Suwayomi of our own answering GraphQL as
 * the real one does.
 */

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

function fakeSuwayomi(extensions: Array<{ name: string; isInstalled: boolean; hasUpdate: boolean }>, broken: string[] = []) {
  const updates: string[] = [];
  const fetch = (async (_input: string | URL | Request, init: RequestInit = {}) => {
    const body = JSON.parse(String(init.body));
    if (body.query.includes('fetchExtensions')) {
      const list = extensions.map((x) => ({ ...x, pkgName: `eu.kanade.tachiyomi.extension.en.${x.name.toLowerCase()}` }));
      return json({ data: { fetchExtensions: { extensions: list } } });
    }
    const name = String(body.variables.id).split('.').pop();
    updates.push(String(name));
    if (broken.includes(String(name))) return json({ data: null, errors: [{ message: 'Failed to download\n\tat somewhere' }] });
    return json({ data: { updateExtension: { extension: { name, versionName: '1.6.2' } } } });
  }) as typeof globalThis.fetch;
  return { fetch, updates };
}

describe('Suwayomi’s extensions', () => {
  it('updates each installed extension that has a newer version, and nothing else', async () => {
    const sw = fakeSuwayomi([
      { name: 'Old', isInstalled: true, hasUpdate: true },
      { name: 'Fresh', isInstalled: true, hasUpdate: false },
      { name: 'Elsewhere', isInstalled: false, hasUpdate: true },
    ]);
    expect(await updateExtensions('http://suwayomi.test/', sw.fetch)).toEqual({ updated: ['old 1.6.2'], failed: [] });
    expect(sw.updates).toEqual(['old']);
  });

  it('says nothing when none has a newer version', async () => {
    const sw = fakeSuwayomi([{ name: 'Fresh', isInstalled: true, hasUpdate: false }]);
    expect(await updateExtensions('http://suwayomi.test', sw.fetch)).toBeNull();
  });

  it('goes on past one that fails, and fails only when every one did', async () => {
    const some = fakeSuwayomi(
      [
        { name: 'Broken', isInstalled: true, hasUpdate: true },
        { name: 'Fine', isInstalled: true, hasUpdate: true },
      ],
      ['broken'],
    );
    expect(await updateExtensions('http://suwayomi.test', some.fetch)).toEqual({ updated: ['fine 1.6.2'], failed: ['Broken'] });

    const all = fakeSuwayomi([{ name: 'Broken', isInstalled: true, hasUpdate: true }], ['broken']);
    await expect(updateExtensions('http://suwayomi.test', all.fetch)).rejects.toThrow('No extension could be updated: Broken');
  });
});
