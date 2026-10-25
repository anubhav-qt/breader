import { main } from '../lib.ts';
import { check, NOT_CHAT, type Check } from '../models.ts';
import { NIM_BASE, nvidiaKey } from '../nim.ts';

/*
 * npm --prefix ai run models [-- --at-once 6]
 *
 * Every model NVIDIA lists, each asked the marker's small daily question now (models.ts), a few at
 * once: which really answer this key, how long before they start, and how fast they go. Writes
 * nothing; the marker keeps its own daily checks for the admin page.
 */

main(async () => {
  nvidiaKey();
  const atOnce = Number(process.argv[process.argv.indexOf('--at-once') + 1]) || 6;
  const res = await fetch(`${NIM_BASE}/models`);
  const body = (await res.json()) as { data?: Array<{ id: string }> };
  const ids = (body.data ?? []).map((m) => m.id).filter((id) => !NOT_CHAT.test(id)).sort();
  console.log(`NVIDIA lists ${body.data?.length ?? 0} models; asking the ${ids.length} that chat, ${atOnce} at once…`);
  const done: Array<{ id: string; c: Check }> = [];
  let next = 0;
  await Promise.all(Array.from({ length: atOnce }, async () => {
    while (next < ids.length) {
      const id = ids[next++];
      const c = await check(id);
      done.push({ id, c });
      console.log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${id}`);
    }
  }));
  const ok = done.filter((d) => d.c.ok).sort((a, b) => (b.c.tps ?? 0) - (a.c.tps ?? 0));
  const bad = done.filter((d) => !d.c.ok).sort((a, b) => a.id.localeCompare(b.id));
  console.log(`\nAnswering: ${ok.length}, fastest first`);
  for (const { id, c } of ok) console.log(`  ${id.padEnd(48)} ${String(c.firstS ?? '-').padStart(6)} s to start  ${String(c.tps ?? '-').padStart(6)} tok/s`);
  console.log(`\nNot answering: ${bad.length}`);
  for (const { id, c } of bad) console.log(`  ${id.padEnd(48)} ${c.kind}: ${c.why}`);
});
