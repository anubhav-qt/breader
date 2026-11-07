#!/usr/bin/env node
/*
 * A load test: many readers at once, each doing what a real one does.
 *
 * Each reader gets a library of its own and an address of its own (sent as x-forwarded-for, so
 * the server under test needs CLIENT_IP_HEADER=x-forwarded-for). Then, over and over:
 *   1. Browse: a page of AniList's popular list, where its series are read, and 24 covers.
 *   2. Search: the names drop-down as "yots" is typed, then AniList's and the sites' search.
 *   3. A series: its sheet, its chapters, its copies, and its place saved.
 *   4. Reading: one chapter, a page every few seconds, the place saved every 5 pages.
 *
 * Only for a test stack: it uses fixed MangaDex chapters, warmed first, so MangaDex isn't asked.
 *
 *   node infra/load/readers.mjs --base http://localhost:8797 --readers 100 --minutes 3
 *   node infra/load/readers.mjs --base http://localhost:8797 --warm
 *
 * One Node process tops out near 2,000 readers. For more, run several, each with its own
 * --first (the number of its first reader), so their readers' addresses don't overlap.
 */

const SERIES = '58be6aa6-06cb-4ca5-bd20-f1392ce451fb'; // Yotsuba to!, on MangaDex
const CHAPTERS = 3;
const ORIGIN = 'http://localhost:5173';
const TIMEOUT_MS = 15_000;

function readArgs() {
  const args = { base: 'http://localhost:8797', first: 0, readers: 50, minutes: 2, ramp: 30, pageEvery: 5, warm: false };
  const list = process.argv.slice(2);
  for (let i = 0; i < list.length; i++) {
    const name = list[i];
    if (name === '--warm') {
      args.warm = true;
      continue;
    }
    const value = list[i + 1];
    i++;
    if (name === '--base') args.base = value;
    else if (name === '--readers') args.readers = Number(value);
    else if (name === '--first') args.first = Number(value);
    else if (name === '--minutes') args.minutes = Number(value);
    else if (name === '--ramp') args.ramp = Number(value);
    else if (name === '--page-every') args.pageEvery = Number(value);
    else throw new Error(`Unknown option ${name}`);
  }
  return args;
}

const args = readArgs();

/* ---------- What happened, for the report ---------- */

/** Every request's route, status and time. status 0 means no answer (timeout or network). */
const results = [];
const startedAt = Date.now();

function record(route, status, ms) {
  results.push({ route, status, ms, at: Date.now() - startedAt });
}

/* ---------- One request ---------- */

async function ask(reader, route, path, init = {}) {
  const headers = { 'x-forwarded-for': reader.ip, origin: ORIGIN, ...init.headers };
  if (reader.cookie) headers.cookie = reader.cookie;
  const began = performance.now();
  try {
    const res = await fetch(args.base + path, { ...init, headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const body = await res.arrayBuffer();
    record(route, res.status, performance.now() - began);
    return { res, body };
  } catch {
    record(route, 0, performance.now() - began);
    return null;
  }
}

async function askJson(reader, route, path, init) {
  const got = await ask(reader, route, path, init);
  if (!got || !got.res.ok) return null;
  return JSON.parse(Buffer.from(got.body).toString('utf8'));
}

function post(reader, route, path, body) {
  return ask(reader, route, path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Runs the jobs at most `most` at a time, as a browser does with one host. */
async function fewAtOnce(jobs, most) {
  let next = 0;
  async function lane() {
    while (next < jobs.length) {
      const job = jobs[next];
      next++;
      await job();
    }
  }
  const lanes = [];
  for (let i = 0; i < most; i++) lanes.push(lane());
  await Promise.all(lanes);
}

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const timeLeft = () => Date.now() < startedAt + args.minutes * 60_000;

/* ---------- A reader ---------- */

const KEY_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function newKey() {
  let s = '';
  for (let i = 0; i < 20; i++) s += KEY_ALPHABET[Math.floor(Math.random() * 32)];
  return `BRDR-${s.match(/.{4}/g).join('-')}`;
}

function newReader(n) {
  const id = `load-${Date.now().toString(36)}-${n}`;
  const ip = `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
  return { n, id, ip, cookie: '', mutation: 0, bookId: `load-book-${n}` };
}

async function register(reader) {
  const got = await post(reader, 'POST /libraries', '/v1/libraries', { libraryId: reader.id, key: newKey() });
  if (!got || !got.res.ok) return false;
  const cookies = got.res.headers.getSetCookie().map((c) => c.split(';')[0]);
  reader.cookie = cookies.join('; ');
  return true;
}

function savePlace(reader, page) {
  const now = Date.now();
  const mutations = [];
  if (reader.mutation === 0) {
    reader.mutation++;
    mutations.push({
      id: reader.mutation,
      type: 'book.put',
      book: {
        id: reader.bookId, title: 'Yotsuba to!', author: 'Azuma Kiyohiko', format: 'CBZ', source: 'remote',
        url: `mangadex:${SERIES}`, shared: false, addedAt: now, words: 0, color: '#2C6668',
        progress: 0, line: '', lastOpened: now,
      },
    });
  }
  reader.mutation++;
  mutations.push({
    id: reader.mutation,
    type: 'read.put',
    bookId: reader.bookId,
    read: { progress: Math.min(1, page / 100), line: '', lastOpened: now },
  });
  return post(reader, 'POST /sync/push', '/v1/sync/push', { clientId: `load-client-${reader.n}`, mutations });
}

async function browse(reader) {
  const page = 1 + Math.floor(Math.random() * 5);
  const list = await askJson(reader, 'GET /anilist', `/v1/manga/anilist?sort=popular&page=${page}`);
  if (!list) return;
  const ids = list.items.map((card) => card.id);
  await askJson(reader, 'GET /anilist/found', `/v1/manga/anilist/found?ids=${ids.join(',')}&lang=en`);
  const covers = ids.slice(0, 24).map((id) => () => ask(reader, 'GET /anilist/cover', `/v1/manga/anilist/cover/${id}?size=512`));
  await fewAtOnce(covers, 6);
}

async function search(reader) {
  for (const typed of ['y', 'yo', 'yot', 'yots']) {
    await ask(reader, 'GET /anilist/names', `/v1/manga/anilist/names?q=${typed}`);
    await sleep(150);
  }
  await Promise.all([
    ask(reader, 'GET /anilist/search', '/v1/manga/anilist/search?q=yotsuba'),
    ask(reader, 'GET /manga/search', '/v1/manga/search?q=yotsuba'),
  ]);
}

async function openSeries(reader) {
  await Promise.all([
    ask(reader, 'GET /series', `/v1/manga/series/${SERIES}`),
    ask(reader, 'GET /series/copies', `/v1/manga/series/${SERIES}/copies?lang=en`),
  ]);
  const got = await askJson(reader, 'GET /series/chapters', `/v1/manga/series/${SERIES}/chapters?lang=en`);
  await savePlace(reader, 0);
  if (!got) return [];
  return got.chapters;
}

/** The first copy of each of the first chapters, the ones warmed. */
function testChapters(chapters) {
  const picked = [];
  const seen = new Set();
  for (const c of chapters) {
    if (seen.has(c.chapter) || c.external) continue;
    seen.add(c.chapter);
    picked.push(c);
    if (picked.length === CHAPTERS) break;
  }
  return picked;
}

async function read(reader, chapter) {
  for (let n = 0; n < chapter.pages && timeLeft(); n++) {
    await ask(reader, 'GET /chapter/page', `/v1/manga/chapter/${chapter.id}/${n}`);
    if (n % 5 === 4) await savePlace(reader, n);
    await sleep(args.pageEvery * 1000);
  }
}

async function live(reader) {
  if (!(await register(reader))) return;
  while (timeLeft()) {
    await browse(reader);
    await search(reader);
    const chapters = testChapters(await openSeries(reader));
    if (!chapters.length) {
      await sleep(5000);
      continue;
    }
    await read(reader, chapters[reader.n % chapters.length]);
  }
}

/* ---------- Warming: every test page and cover fetched once, before the test ---------- */

async function warm() {
  const reader = newReader(999_999);
  if (!(await register(reader))) throw new Error('Could not open a library to warm with.');
  for (let page = 1; page <= 5; page++) await browse(reader);
  await search(reader);
  const chapters = testChapters(await openSeries(reader));
  for (const c of chapters) {
    for (let n = 0; n < c.pages; n++) await ask(reader, 'GET /chapter/page', `/v1/manga/chapter/${c.id}/${n}`);
    console.log(`warmed chapter ${c.chapter}: ${c.pages} pages`);
  }
}

/* ---------- The report ---------- */

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i];
}

function isFailure(r) {
  return r.status === 0 || r.status >= 500;
}

function report() {
  const seconds = (Date.now() - startedAt) / 1000;
  const routes = new Map();
  for (const r of results) {
    if (!routes.has(r.route)) routes.set(r.route, []);
    routes.get(r.route).push(r);
  }
  console.log(`\n${args.readers} readers, ${seconds.toFixed(0)} s, ${results.length} requests, ${(results.length / seconds).toFixed(1)} a second`);
  console.log('route'.padEnd(22), 'count'.padStart(6), 'p50'.padStart(7), 'p95'.padStart(7), 'max'.padStart(7), 'fail'.padStart(5), ' statuses');
  for (const [route, rows] of routes) {
    const times = rows.map((r) => r.ms).sort((a, b) => a - b);
    const fails = rows.filter(isFailure).length;
    const statuses = {};
    for (const r of rows) statuses[r.status] = (statuses[r.status] ?? 0) + 1;
    console.log(
      route.padEnd(22),
      String(rows.length).padStart(6),
      `${percentile(times, 50).toFixed(0)}ms`.padStart(7),
      `${percentile(times, 95).toFixed(0)}ms`.padStart(7),
      `${times[times.length - 1].toFixed(0)}ms`.padStart(7),
      String(fails).padStart(5),
      '',
      JSON.stringify(statuses),
    );
  }
  const all = results.map((r) => r.ms).sort((a, b) => a - b);
  const fails = results.filter(isFailure).length;
  console.log(`all: p50 ${percentile(all, 50).toFixed(0)}ms, p95 ${percentile(all, 95).toFixed(0)}ms, failed ${fails} (${((100 * fails) / Math.max(1, results.length)).toFixed(1)}%)`);
}

async function main() {
  if (args.warm) {
    await warm();
    return;
  }
  const readers = [];
  for (let i = 0; i < args.readers; i++) {
    const reader = newReader(args.first + i);
    readers.push(sleep((i * args.ramp * 1000) / args.readers).then(() => live(reader)));
  }
  await Promise.all(readers);
  report();
}

await main();
