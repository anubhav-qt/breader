/**
 * The status page itself: one static document that asks for the admin token (kept for this tab
 * only) and reads /admin/status from the same server every few seconds while it's in view, so it
 * stays live. Book titles in the AI marker's section are the only thing on it that comes from
 * readers, and every value is set as text, never as markup. On the laptop it also lists the AI
 * accounts and connects new ones (routes/admin.ts), a minute apart or after each change, since
 * each look asks every provider for its limits.
 */
export const adminPage = (nonce: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Breader status</title>
<style nonce="${nonce}">
  :root { --fg: #000; --bg: #fff; --dim: rgba(0,0,0,.55); --line: rgba(0,0,0,.14); --bad: #d11a2a; --ok: #1a9e4b; color-scheme: light dark; }
  @media (prefers-color-scheme: dark) { :root { --fg: #fff; --bg: #000; --dim: rgba(255,255,255,.55); --line: rgba(255,255,255,.16); --bad: #ff5a5f; --ok: #3ddc84; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, sans-serif; }
  main { max-width: 760px; margin: 0 auto; padding: 32px 16px 64px; }
  header { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; margin-bottom: 24px; }
  h1 { font-size: 20px; font-weight: 600; margin: 0; }
  h2 { font-size: 12px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--dim); margin: 28px 0 8px; }
  dl { display: grid; grid-template-columns: minmax(140px, 220px) 1fr; margin: 0; border-top: 1px solid var(--line); }
  dt, dd { margin: 0; padding: 7px 0; border-bottom: 1px solid var(--line); }
  dt { color: var(--dim); padding-right: 16px; }
  dd { font-variant-numeric: tabular-nums; overflow-wrap: anywhere; white-space: pre-line; }
  .bad { color: var(--bad); }
  .dim { color: var(--dim); }
  h3 { font-size: 13px; font-weight: 600; margin: 18px 0 6px; }
  p { margin: 6px 0; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--dim); margin-right: 6px; vertical-align: 1px; }
  .dot.on { background: var(--ok); animation: pulse 2s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity: .35; } }
  @media (prefers-reduced-motion: reduce) { .dot.on { animation: none; } }
  .book { padding: 10px 0; border-bottom: 1px solid var(--line); }
  .books { border-top: 1px solid var(--line); }
  .title { font-weight: 600; overflow-wrap: anywhere; }
  .progress { display: flex; align-items: center; gap: 10px; margin-top: 6px; font-variant-numeric: tabular-nums; }
  .bar { flex: 1; height: 6px; border-radius: 3px; background: var(--line); overflow: hidden; }
  .bar > div { height: 100%; background: var(--fg); transition: width .4s ease; }
  .progress > span { min-width: 4ch; text-align: right; }
  ol { margin: 0; padding: 0 0 0 2.2em; border-top: 1px solid var(--line); }
  li { padding: 7px 0; border-bottom: 1px solid var(--line); overflow-wrap: anywhere; }
  form { display: flex; gap: 8px; margin-top: 24px; }
  [hidden] { display: none; }
  input { flex: 1; font: inherit; padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; background: transparent; color: inherit; }
  button { font: inherit; padding: 8px 14px; border: 1px solid var(--fg); border-radius: 8px; background: var(--fg); color: var(--bg); cursor: pointer; }
  button.quiet { background: transparent; color: inherit; border-color: var(--line); padding: 4px 10px; }
  .head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .limit { margin-top: 6px; }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
  .steps { margin-top: 12px; padding: 12px; border: 1px solid var(--line); border-radius: 8px; }
  .steps a { color: inherit; }
  .paste { display: flex; gap: 8px; margin-top: 8px; }
</style>
</head>
<body>
<main>
  <header><h1>Breader status</h1><span class="dim"><span id="dot" class="dot"></span><span id="when"></span></span></header>
  <form id="login" hidden>
    <input id="token" type="password" autocomplete="off" placeholder="Admin token" aria-label="Admin token">
    <button>Show</button>
  </form>
  <p id="error" class="bad" hidden></p>
  <div id="out"></div>
  <div id="accounts"></div>
</main>
<script nonce="${nonce}">
const KEY = 'breader.admin';
const $ = (id) => document.getElementById(id);
const mb = (b) => b == null ? '—' : b >= 1024 ** 3 ? (b / 1024 ** 3).toFixed(2) + ' GB' : (b / 1024 ** 2).toFixed(1) + ' MB';
const pct = (a, b) => a == null ? '' : ' (' + Math.round((a / b) * 100) + '% of the free ' + mb(b) + ')';
const dur = (s) => s < 90 ? s + ' s' : s < 5400 ? Math.round(s / 60) + ' min' : s < 172800 ? Math.round(s / 3600) + ' h' : Math.round(s / 86400) + ' days';
const ago = (s) => s == null ? '—' : dur(s) + ' ago';
const since = (t) => t ? ago(Math.round((Date.now() - new Date(t).getTime()) / 1000)) : 'never';
const until = (t) => {
  const s = Math.round((new Date(t).getTime() - Date.now()) / 1000);
  if (s <= 0) return 'any moment now';
  return 'in ' + dur(s);
};
const TASKS = { marks: 'Voice marks (M/F)', music: 'Background music', notes: 'Revisit notes' };
const KINDS = { antigravity: 'Antigravity', claude: 'Claude Code', codex: 'Codex' };

function el(tag, text, cls) {
  const e = document.createElement(tag);
  if (text != null) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}

function section(title, rows) {
  const h = document.createElement('h2');
  h.textContent = title;
  const dl = document.createElement('dl');
  for (const [k, v, bad] of rows) {
    const dt = document.createElement('dt');
    const dd = document.createElement('dd');
    dt.textContent = k;
    dd.textContent = v;
    if (bad) dd.className = 'bad';
    dl.append(dt, dd);
  }
  return [h, dl];
}

function render(s) {
  const out = [];
  out.push(...section('Server', [
    ['Answering', s.server.role === 'laptop' ? 'the laptop' : 'the fallback (Render)'],
    ['Release', s.server.release],
    ['Up for', dur(s.server.uptimeSeconds)],
    ['Errors to Sentry', s.server.sentry ? 'on' : 'off (SENTRY_DSN not set)', !s.server.sentry],
  ]));
  out.push(...section('Supabase', s.supabase ? [
    ['Database', mb(s.supabase.bytes) + pct(s.supabase.bytes, s.supabase.freeBytes), s.supabase.bytes > 0.8 * s.supabase.freeBytes],
    ['Sync timeline', s.supabase.timeline ?? '—'],
  ] : [['Database', 'not answering', true]]));
  if (s.feed) out.push(...section('Change feed', [
    ['Laptop last read it', ago(s.feed.ack), s.feed.ack == null || s.feed.ack > 600],
    ['Waiting for the laptop', s.feed.unread + ' records' + (s.feed.oldest_unread != null ? ', oldest ' + ago(s.feed.oldest_unread) : ''), s.feed.oldest_unread > 600],
    ['Records kept', String(s.feed.rows)],
  ]));
  if (s.copy) out.push(...section('Laptop copy', s.copy.down ? [['Copy', 'not answering', true]] : [
    ['Behind Supabase by', s.copy.lag == null ? '—' : s.copy.lag + ' s', s.copy.lag > 60],
    ['Last full reload', since(s.copy.loaded_at)],
  ]));
  if (s.libraries) out.push(...section('Libraries', [
    ['Libraries', s.libraries.total + ' (' + s.libraries.key_only + ' key only)'],
    ['Used this week', String(s.libraries.active_week)],
    ['Expire within 30 days', String(s.libraries.expiring)],
    ['Books', s.books ? s.books.books + ' (+ ' + s.books.removed + ' removed, kept for Undo)' : '—'],
  ]));
  const files = s.files.byStatus;
  const ready = files.find((f) => f.status === 'ready');
  out.push(...section('Files in R2', [
    ['Stored', ready ? ready.files + ' files, ' + mb(ready.bytes) + pct(ready.bytes, s.files.freeBytes) : 'none'],
    ...files.map((f) => [f.status, f.files + ' files, ' + mb(f.bytes) + (f.unused ? ', ' + f.unused + ' waiting for clean-up' : '')]),
  ]));
  const names = { 'backup': 'Nightly backup', 'restore-drill': 'Restore test', 'clean-up': 'Clean-up', 'storage-check': 'R2 check', 'extensions': 'Manga extensions', 'manga-prefetch': 'Manga prefetch', 'ai-marker': 'AI marker', 'yt-dlp': 'yt-dlp update' };
  out.push(...section('Workers', s.jobs.length ? s.jobs.flatMap((j) => {
    const failing = j.last_error_at && (!j.last_ok_at || new Date(j.last_error_at) > new Date(j.last_ok_at));
    const rows = [[names[j.name] || j.name, 'worked ' + since(j.last_ok_at), !j.last_ok_at]];
    if (failing) rows.push(['', 'failed ' + since(j.last_error_at) + ': ' + j.last_error, true]);
    return rows;
  }) : [['Jobs', 'none have run yet']]));
  const ai = s.jobs.find((j) => j.name === 'ai-marker');
  if (ai && ai.detail && Array.isArray(ai.detail.working)) out.push(...marker(ai.detail));
  const headers = Object.entries(s.request.headers).map(([k, v]) => k + ': ' + v).join('\\n') || 'none';
  out.push(...section('Your request', [
    ['Your address, as seen', s.request.ip],
    ['Read from', s.request.from === 'none' ? 'the connection (CLIENT_IP_HEADER not set)' : s.request.from, s.request.from === 'none'],
    ['Forwarding headers', headers],
  ]));
  $('out').replaceChildren(...out);
  $('when').textContent = 'Live, ' + new Date().toLocaleTimeString();
}

/** The AI marker, as it last said (ai/tools/marker.ts, liveNow): the books it's on, and the queue. */
function marker(d) {
  const out = [el('h2', 'AI marker')];
  out.push(el('p', d.books + ' books with AI on: ' + d.finished + ' finished, ' + d.working.length + ' being worked on, ' + d.queue.length + ' waiting.'));
  // It says how it's doing at least once a minute, so three quiet minutes mean it has stopped.
  const quiet = Math.round((Date.now() - new Date(d.at).getTime()) / 1000);
  if (quiet > 180) out.push(el('p', 'Not heard from in ' + dur(quiet) + ', so it may have stopped. What follows is from then.', 'bad'));
  if (d.limitedUntil) out.push(el('p', 'Every Antigravity account is out of Gemini until it fills again ' + until(d.limitedUntil) + ': research and soundtracks wait for it, and everything else carries on.', 'bad'));

  out.push(el('h3', 'Working on'));
  if (!d.working.length) out.push(el('p', 'Nothing right now.', 'dim'));
  const books = el('div', null, 'books');
  for (const w of d.working) {
    const line = [TASKS[w.task] || w.task, w.step];
    if (w.of) line.push(w.parts + ' of ' + w.of + ' parts');
    line.push('started ' + since(w.since));
    const fill = el('div');
    fill.style.width = w.percent + '%';
    const bar = el('div', null, 'bar');
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-valuenow', String(w.percent));
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', '100');
    bar.append(fill);
    const progress = el('div', null, 'progress');
    progress.append(bar, el('span', w.percent + '%'));
    const book = el('div', null, 'book');
    book.append(el('div', w.title, 'title'), el('div', line.join(' · '), 'dim'), progress);
    books.append(book);
  }
  if (d.working.length) out.push(books);

  out.push(el('h3', 'Queue'));
  if (!d.queue.length) out.push(el('p', 'Empty.', 'dim'));
  const ol = el('ol');
  for (const q of d.queue) {
    const li = el('li');
    li.append(el('span', q.title), el('span', ' · ' + (TASKS[q.task] || q.task), 'dim'));
    if (q.failed) {
      const times = q.failed.times === 1 ? 'once' : q.failed.times + ' times in a row';
      const why = q.failed.why ? ': ' + q.failed.why : '';
      li.append(el('div', 'Failed ' + times + ', trying again ' + until(q.failed.next) + why, 'bad'));
    }
    ol.append(li);
  }
  if (d.queue.length) out.push(ol);
  return out;
}

/** A call to the admin API with the token. Fails with the server's own words. */
async function call(method, path, body) {
  const init = { method, headers: { authorization: 'Bearer ' + sessionStorage.getItem(KEY) }, cache: 'no-store' };
  if (body) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(path, init);
  const answer = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(answer.message || 'The server answered ' + res.status + '.');
    e.status = res.status;
    throw e;
  }
  return answer;
}

// The AI accounts: the last list, when it was read, and the sign-in under way, if any.
let accounts = [];
let accountsAt = 0;
let signIn = null;
const pause = (ms) => new Promise((ok) => setTimeout(ok, ms));

function limit(w) {
  let line = w.label + ': ' + Math.round(w.usedPercent) + '% used';
  if (w.resetsAt && w.usedPercent > 0) line += ', full again ' + until(w.resetsAt);
  const fill = el('div');
  fill.style.width = w.usedPercent + '%';
  const bar = el('div', null, 'bar');
  bar.append(fill);
  const box = el('div', null, 'limit');
  box.append(el('div', line, w.usedPercent >= 100 ? 'bad' : 'dim'), bar);
  return box;
}

async function loadAccounts() {
  accountsAt = Date.now();
  try {
    accounts = (await call('GET', '/admin/accounts')).accounts;
  } catch (e) {
    // Only the laptop has them.
    if (e.status === 404) { $('accounts').replaceChildren(); return; }
    $('accounts').replaceChildren(el('h2', 'AI accounts'), el('p', e.message, 'bad'));
    return;
  }
  showAccounts();
}

function showAccounts() {
  const out = [el('h2', 'AI accounts')];
  out.push(el('p', 'The AI marker’s research and music run on these, Antigravity’s Gemini first. With several, one is used until it reaches a limit, then the next.', 'dim'));
  const list = el('div', null, 'books');
  for (const a of accounts) {
    const head = el('div', null, 'head');
    const remove = el('button', 'Remove', 'quiet');
    remove.addEventListener('click', () => removeAccount(a));
    head.append(el('span', (KINDS[a.kind] || a.kind) + ' · ' + a.name, 'title'), remove);
    const row = el('div', null, 'book');
    row.append(head);
    if (a.problem) row.append(el('div', a.problem, 'bad'));
    if (a.usage) {
      for (const w of a.usage) row.append(limit(w));
    } else {
      row.append(el('div', 'Its limits couldn’t be read.', 'dim'));
    }
    list.append(row);
  }
  if (accounts.length) out.push(list);
  else out.push(el('p', 'None connected yet.', 'dim'));
  if (signIn) {
    out.push(signIn.panel);
  } else {
    const actions = el('div', null, 'actions');
    for (const kind of Object.keys(KINDS)) {
      const b = el('button', 'Connect ' + KINDS[kind]);
      b.addEventListener('click', () => connect(kind));
      actions.append(b);
    }
    out.push(actions);
  }
  $('accounts').replaceChildren(...out);
}

async function connect(kind) {
  let started;
  try {
    started = await call('POST', '/admin/accounts/connect', { kind });
  } catch (e) {
    alert(e.message);
    return;
  }
  const panel = el('div', null, 'steps');
  const open = el('a', 'Open the ' + KINDS[kind] + ' sign-in page');
  open.href = started.url;
  open.target = '_blank';
  open.rel = 'noopener noreferrer';
  const first = el('p', '1. ');
  first.append(open, document.createTextNode(' and sign in.'));
  const second = el('p', '2. It ends on a page that doesn’t load, at a localhost address. Copy that whole address from the address bar and paste it here, within 5 minutes.');
  const input = el('input');
  input.type = 'url';
  input.placeholder = 'http://localhost:…';
  input.setAttribute('aria-label', 'The address the sign-in ended on');
  const done = el('button', 'Connect');
  const cancel = el('button', 'Cancel', 'quiet');
  const paste = el('div', null, 'paste');
  paste.append(input, done, cancel);
  const said = el('p', null, 'dim');
  panel.append(first, second, paste, said);
  signIn = { state: started.state, panel, input, said };
  done.addEventListener('click', () => finish());
  cancel.addEventListener('click', () => stopSignIn());
  showAccounts();
}

function say(text, bad) {
  signIn.said.textContent = text;
  signIn.said.className = bad ? 'bad' : 'dim';
}

async function finish() {
  const s = signIn;
  const pasted = s.input.value.trim();
  if (!pasted) return;
  say('Finishing the sign-in…');
  try {
    await call('POST', '/admin/accounts/finish', { state: s.state, redirectUrl: pasted });
    for (let i = 0; i < 30; i++) {
      const r = await call('GET', '/admin/accounts/status?state=' + encodeURIComponent(s.state));
      if (r.status === 'ok') {
        signIn = null;
        await loadAccounts();
        return;
      }
      if (r.status === 'error') throw new Error(r.error);
      await pause(2000);
    }
    throw new Error('It’s taking long. Look at the list again in a minute.');
  } catch (e) {
    say(e.message, true);
  }
}

async function stopSignIn() {
  const s = signIn;
  signIn = null;
  showAccounts();
  await call('POST', '/admin/accounts/cancel', { state: s.state }).catch(() => {});
}

async function removeAccount(a) {
  if (!confirm('Remove ' + a.name + '? The marker stops using it until it’s connected again.')) return;
  try {
    await call('DELETE', '/admin/accounts/' + encodeURIComponent(a.id));
  } catch (e) {
    alert(e.message);
  }
  await loadAccounts();
}

async function load() {
  const token = sessionStorage.getItem(KEY);
  if (!token) { $('login').hidden = false; return; }
  try {
    const res = await fetch('/admin/status', { headers: { authorization: 'Bearer ' + token }, cache: 'no-store' });
    if (res.status === 401) { sessionStorage.removeItem(KEY); $('login').hidden = false; throw new Error('That token didn’t work.'); }
    if (!res.ok) throw new Error('The server answered ' + res.status + '.');
    render(await res.json());
    $('dot').className = 'dot on';
    $('login').hidden = true;
    $('error').hidden = true;
    // Not while a sign-in is under way: it would take the panel away mid-paste.
    if (!signIn && Date.now() - accountsAt > 60_000) void loadAccounts();
  } catch (e) {
    $('dot').className = 'dot';
    $('error').textContent = e.message;
    $('error').hidden = false;
  }
}

$('login').addEventListener('submit', (e) => {
  e.preventDefault();
  sessionStorage.setItem(KEY, $('token').value.trim());
  $('token').value = '';
  load();
});
load();
// Live while it's in view: every 5 s (the server allows 30 a minute), and at once on coming back.
setInterval(() => { if (document.visibilityState === 'visible') load(); }, 5000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') load();
  else $('dot').className = 'dot';
});
</script>
</body>
</html>`;
