#!/usr/bin/env node
/*
 * The engine's load test (ADR 0002): readers reading aloud live while libraries make audiobooks and
 * readers have manga panels found, all through one API and its engines. Test stack only, never
 * production. How to run it, and the numbers: docs/load-tests.md.
 *
 *   node voices.mjs --base http://api:8787 --live 4 --books 12 --panels 4 --minutes 2
 *
 * OWNER_EMAIL, OWNER_PASSWORD: an account in the API's SPEECH_EMAILS, its address confirmed. Each
 * live reader logs in to it, so each has a login, and a line at the engine, of its own.
 *
 * Live reader: reads passages of --passage sentences aloud as the app does, a sentence playing while the next two are
 * asked for, a few seconds' rest between passages. Reported: time to first sound (each passage's
 * first sentence), and stalls (playing waits for the next sentence).
 * Audiobooks: each library sends a book of --paragraphs paragraphs, 3 sentences each, and waits for
 * it. Reported: paragraphs made a minute, all books together.
 * Panels: each reader takes a seat and has the pages of a chapter of Yotsuba to! found, a page every
 * --page-ms. Reported: time a page. Pages found before are kept, so clear page_panels first.
 */

const args = {
  base: 'http://localhost:8797',
  origin: 'http://localhost:5173',
  live: 1,
  voice: 'kokoro:af_heart',
  passage: 8,
  books: 0,
  bookVoice: 'kokoro:af_heart',
  paragraphs: 40,
  panels: 0,
  pageMs: 2_000,
  minutes: 1,
};
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i].replace(/^--/, '').replace(/-(\w)/g, (_, c) => c.toUpperCase());
  if (!(key in args)) throw new Error(`Unknown option ${process.argv[i]}`);
  args[key] = typeof args[key] === 'number' ? Number(process.argv[i + 1]) : process.argv[i + 1];
}
const SERIES = '58be6aa6-06cb-4ca5-bd20-f1392ce451fb'; // Yotsuba to!, on MangaDex
const run = Date.now().toString(36);
const startedAt = Date.now();
const timeLeft = () => Date.now() < startedAt + args.minutes * 60_000;
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

/* ---------- What's seen ---------- */

const seen = { ttfs: [], stalls: [], say: [], sayErr: {}, passages: 0, sentences: 0, pages: [], pageErr: {}, made: 0, books: [] };
const pct = (xs, p) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const ms = (x) => (x === null ? '-' : x >= 10_000 ? `${(x / 1000).toFixed(0)} s` : x >= 1000 ? `${(x / 1000).toFixed(1)} s` : `${Math.round(x)} ms`);
const count = (o, k) => { o[k] = (o[k] ?? 0) + 1; };

/* ---------- Asking ---------- */

let ips = 0;
function client() {
  const n = ++ips;
  return { cookie: '', ip: `10.77.${(n >> 8) & 255}.${n & 255}` };
}

async function ask(c, method, path, body) {
  const headers = { origin: args.origin, 'x-forwarded-for': c.ip };
  if (c.cookie) headers.cookie = c.cookie;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${args.base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(120_000) });
  const got = res.headers.getSetCookie().map((x) => x.split(';')[0]);
  if (got.length) {
    const jar = new Map(c.cookie ? c.cookie.split('; ').map((x) => x.split(/=(.*)/s).slice(0, 2)) : []);
    for (const x of got) {
      const [k, v] = x.split(/=(.*)/s);
      jar.set(k, v);
    }
    c.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  return res;
}

const KEY_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function newKey() {
  let s = '';
  for (let i = 0; i < 20; i++) s += KEY_ALPHABET[Math.floor(Math.random() * 32)];
  return `BRDR-${s.match(/.{4}/g).join('-')}`;
}

async function library() {
  const c = client();
  const res = await ask(c, 'POST', '/v1/libraries', { libraryId: crypto.randomUUID(), key: newKey() });
  if (!res.ok) throw new Error(`A library couldn't be made: ${res.status}`);
  return c;
}

async function owner() {
  const c = client();
  const res = await ask(c, 'POST', '/v1/auth/sign-in/email', { email: process.env.OWNER_EMAIL, password: process.env.OWNER_PASSWORD });
  if (!res.ok) throw new Error(`The owner couldn't log in: ${res.status}`);
  return c;
}

/* ---------- Sentences, each new, so none is kept from before ---------- */

const WORDS = 'the old house stood at the end of a long road where the rain fell soft on the grey stones and a small dog slept by the door while the wind moved through the tall trees and somebody far away was singing a song about the sea'.split(' ');
let said = 0;
function sentence() {
  const n = 10 + (said % 7);
  const words = [`${run}${++said}`];
  for (let i = 1; i < n; i++) words.push(WORDS[(said * 7 + i * 13) % WORDS.length]);
  const s = words.join(' ');
  return `${s[0].toUpperCase()}${s.slice(1)}.`;
}

/* ---------- Live reading ---------- */

async function say(c) {
  const t = Date.now();
  try {
    const res = await ask(c, 'POST', '/v1/speech/say', { voice: args.voice, text: sentence(), speed: 1 });
    const took = Date.now() - t;
    if (!res.ok) {
      count(seen.sayErr, res.status);
      await res.arrayBuffer();
      return { ok: false, took };
    }
    await res.arrayBuffer();
    seen.say.push(took);
    seen.sentences++;
    return { ok: true, took, playMs: (1000 * Number(res.headers.get('x-samples'))) / Number(res.headers.get('x-rate')) };
  } catch (err) {
    count(seen.sayErr, err.name);
    return { ok: false, took: Date.now() - t };
  }
}

async function liveReader() {
  const c = await owner();
  const ready = await ask(c, 'POST', '/v1/speech/ready', { voice: args.voice });
  if (!ready.ok) throw new Error(`The voice didn't get ready: ${ready.status}`);
  while (timeLeft()) {
    const asked = [];
    const want = (k) => (asked[k] ??= say(c));
    want(0);
    want(1);
    want(2);
    const first = await asked[0];
    if (!first.ok) {
      await sleep(2_000);
      continue;
    }
    seen.ttfs.push(first.took);
    seen.passages++;
    // Sentence k-1 plays till `end`; as sentence k starts, the two after it are asked for.
    let end = Date.now() + first.playMs;
    for (let k = 1; k < args.passage && timeLeft(); k++) {
      const r = await asked[k];
      if (Date.now() > end) seen.stalls.push(Date.now() - end);
      if (!r.ok) break;
      await sleep(Math.max(0, end - Date.now()));
      want(k + 1);
      want(k + 2);
      end = Date.now() + r.playMs;
    }
    // A rest, then another passage.
    await sleep(Math.max(0, end - Date.now()) + 2_000 + Math.random() * 3_000);
  }
}

/* ---------- Audiobooks ---------- */

async function bookMaker(i) {
  const c = await library();
  const engine = args.bookVoice.split(':')[0];
  const path = `/v1/audiobooks/load-${run}-${i}/${engine}`;
  const parts = Array.from({ length: args.paragraphs }, () => [sentence(), sentence(), sentence()]);
  for (let from = 0; from < parts.length; from += 100) {
    const res = await ask(c, 'POST', `${path}/text`, { voice: args.bookVoice, total: parts.length, from, parts: parts.slice(from, from + 100) });
    if (!res.ok) throw new Error(`An audiobook's text was turned away: ${res.status} ${await res.text()}`);
  }
  const t = Date.now();
  let made = 0;
  let state = 'queued';
  while (timeLeft() && state !== 'ready' && state !== 'failed') {
    await sleep(1_000);
    const s = await (await ask(c, 'GET', path)).json();
    seen.made += s.made - made;
    made = s.made;
    state = s.state;
  }
  seen.books.push({ state, made, ms: Date.now() - t });
  await ask(c, 'DELETE', path);
}

/* ---------- Panels ---------- */

async function chapters(c) {
  const res = await ask(c, 'GET', `/v1/manga/series/${SERIES}/chapters?lang=en`);
  if (!res.ok) throw new Error(`Chapters: ${res.status}`);
  const seenNo = new Set();
  return (await res.json()).chapters.filter((x) => !x.external && x.pages > 0 && !seenNo.has(x.chapter) && seenNo.add(x.chapter));
}

async function panelReader(i, list) {
  const c = await library();
  const device = `load-${run}-${i}-device`;
  const seat = await (await ask(c, 'POST', '/v1/panels/seat', { device })).json();
  if (!seat.seated) {
    count(seen.pageErr, 'no seat');
    return;
  }
  // As the app does: the seat is kept every half a minute, or it's given up after 75 s.
  const keep = setInterval(() => ask(c, 'POST', '/v1/panels/seat', { device }).catch(() => {}), 30_000);
  for (let k = i; timeLeft(); k += args.panels) {
    const ch = list[k % list.length];
    for (let n = 0; n < ch.pages && timeLeft(); n++) {
      const t = Date.now();
      const res = await ask(c, 'GET', `/v1/panels/${ch.id}/${n}`);
      await res.arrayBuffer();
      if (res.ok) seen.pages.push(Date.now() - t);
      else count(seen.pageErr, res.status);
      await sleep(Math.max(0, args.pageMs - (Date.now() - t)));
    }
  }
  clearInterval(keep);
  await ask(c, 'POST', '/v1/panels/seat/leave', { device });
}

/* ---------- The engine, every 2 s ---------- */

const health = { waiting: 0, busy: 0, workers: 0, low: false };
async function watch() {
  while (timeLeft()) {
    try {
      const h = await (await fetch(`${args.base}/health`)).json();
      health.workers = h.engine?.workers ?? 0;
      health.busy = Math.max(health.busy, h.engine?.busy ?? 0);
      health.waiting = Math.max(health.waiting, h.engine?.waiting ?? 0);
      health.low ||= !!h.engine?.low;
    } catch {
      // Asked again in a moment.
    }
    await sleep(2_000);
  }
}

/* ---------- Run ---------- */

const list = args.panels ? await chapters(await library()) : [];
const jobs = [watch()];
for (let i = 0; i < args.books; i++) jobs.push(bookMaker(i));
for (let i = 0; i < args.panels; i++) jobs.push(panelReader(i, list));
// Live readers start once the rest are under way, a second apart.
await sleep(args.books || args.panels ? 5_000 : 0);
for (let i = 0; i < args.live; i++) {
  jobs.push(liveReader());
  await sleep(1_000);
}
const results = await Promise.allSettled(jobs);
for (const r of results) if (r.status === 'rejected') console.error('failed:', r.reason?.message ?? r.reason);

const minutes = (Date.now() - startedAt) / 60_000;
console.log(`\n${args.live} live (${args.voice}), ${args.books} audiobooks (${args.bookVoice}), ${args.panels} panel readers, ${minutes.toFixed(1)} min`);
console.log(`engine: ${health.workers} workers, most busy ${health.busy}, most waiting ${health.waiting}${health.low ? ', went short of memory' : ''}`);
if (args.live) {
  console.log(`live: ${seen.passages} passages, ${seen.sentences} sentences; first sound p50 ${ms(pct(seen.ttfs, 50))} p95 ${ms(pct(seen.ttfs, 95))} max ${ms(pct(seen.ttfs, 100))}`);
  console.log(`      a sentence p50 ${ms(pct(seen.say, 50))} p95 ${ms(pct(seen.say, 95))}; stalls ${seen.stalls.length}, p95 ${ms(pct(seen.stalls, 95))}, max ${ms(pct(seen.stalls, 100))}; failed ${JSON.stringify(seen.sayErr)}`);
}
if (args.books) {
  const ready = seen.books.filter((b) => b.state === 'ready');
  console.log(`audiobooks: ${seen.made} paragraphs made, ${(seen.made / minutes).toFixed(1)} a minute (${((seen.made * 3) / (minutes * 60)).toFixed(2)} sentences a second); ${ready.length} of ${args.books} done${ready.length ? `, slowest ${ms(Math.max(...ready.map((b) => b.ms)))}` : ''}`);
}
if (args.panels) {
  console.log(`panels: ${seen.pages.length} pages, p50 ${ms(pct(seen.pages, 50))} p95 ${ms(pct(seen.pages, 95))} max ${ms(pct(seen.pages, 100))}; failed ${JSON.stringify(seen.pageErr)}`);
}
