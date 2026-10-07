import { log } from '../log.ts';

/*
 * Keeps the extensions of Breader's Suwayomi server current (manga/suwayomi.ts reads through
 * them). A site that moves to a new address or changes its pages is mostly mended by its
 * extension's next version, so once a day the worker has Suwayomi fetch the store's list again,
 * and each installed extension with a newer version takes it. Nothing is installed or removed
 * here: which sites to read stays a person's choice, at Suwayomi's own page.
 */

const LIST = 'mutation { fetchExtensions(input: {}) { extensions { pkgName name isInstalled hasUpdate } } }';
const UPDATE = 'mutation($id: String!) { updateExtension(input: { id: $id, patch: { update: true } }) { extension { name versionName } } }';

interface Extension {
  pkgName: string;
  name: string;
  isInstalled: boolean;
  hasUpdate: boolean;
}

async function ask<T>(url: string, fetchFn: typeof fetch, query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetchFn(`${url.replace(/\/+$/, '')}/api/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ query, variables }),
    // Fetching the store's list, or a new version, can take a while.
    signal: AbortSignal.timeout(120_000),
  });
  const body = (await res.json()) as { data?: T | null; errors?: Array<{ message?: string }> };
  const error = body.errors?.[0];
  if (error) {
    const said = String(error.message ?? '').split(/\r?\n/)[0].slice(0, 300);
    throw new Error(`Suwayomi said: ${said}`);
  }
  if (!body.data) throw new Error('Suwayomi didn’t say.');
  return body.data;
}

/**
 * Updates every installed extension that has a newer version. Says which were updated and which
 * couldn't be, or null when none had one. One that fails doesn't stop the rest.
 */
export async function updateExtensions(url: string, fetchFn: typeof fetch = fetch): Promise<{ updated: string[]; failed: string[] } | null> {
  const r = await ask<{ fetchExtensions: { extensions: Extension[] } }>(url, fetchFn, LIST, {});
  const due = r.fetchExtensions.extensions.filter((x) => x.isInstalled && x.hasUpdate);
  if (due.length === 0) return null;

  const updated: string[] = [];
  const failed: string[] = [];
  for (const x of due) {
    try {
      const u = await ask<{ updateExtension: { extension: { name: string; versionName: string } } }>(url, fetchFn, UPDATE, { id: x.pkgName });
      updated.push(`${u.updateExtension.extension.name} ${u.updateExtension.extension.versionName}`);
    } catch (err) {
      log.warn({ err, extension: x.name }, 'a Suwayomi extension couldn’t be updated');
      failed.push(x.name);
    }
  }
  if (updated.length > 0) log.info({ updated }, 'updated Suwayomi extensions');
  if (failed.length > 0 && updated.length === 0) throw new Error(`No extension could be updated: ${failed.join(', ')}`);
  return { updated, failed };
}
