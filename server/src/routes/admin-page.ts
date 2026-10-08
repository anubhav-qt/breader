/**
 * The status page itself: one static document that asks for the admin token (kept for this tab
 * only) and reads /admin/status from the same server. Nothing on it comes from readers, and every
 * value is set as text, never as markup.
 */
export const adminPage = (nonce: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Breader status</title>
<style nonce="${nonce}">
  :root { --fg: #000; --bg: #fff; --dim: rgba(0,0,0,.55); --line: rgba(0,0,0,.14); --bad: #d11a2a; color-scheme: light dark; }
  @media (prefers-color-scheme: dark) { :root { --fg: #fff; --bg: #000; --dim: rgba(255,255,255,.55); --line: rgba(255,255,255,.16); --bad: #ff5a5f; } }
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
  form { display: flex; gap: 8px; margin-top: 24px; }
  input { flex: 1; font: inherit; padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; background: transparent; color: inherit; }
  button { font: inherit; padding: 8px 14px; border: 1px solid var(--fg); border-radius: 8px; background: var(--fg); color: var(--bg); cursor: pointer; }
</style>
</head>
<body>
<main>
  <header><h1>Breader status</h1><span id="when" class="dim"></span></header>
  <form id="login" hidden>
    <input id="token" type="password" autocomplete="off" placeholder="Admin token" aria-label="Admin token">
    <button>Show</button>
  </form>
  <p id="error" class="bad" hidden></p>
  <div id="out"></div>
</main>
<script nonce="${nonce}">
const KEY = 'breader.admin';
const $ = (id) => document.getElementById(id);
const mb = (b) => b == null ? '—' : b >= 1024 ** 3 ? (b / 1024 ** 3).toFixed(2) + ' GB' : (b / 1024 ** 2).toFixed(1) + ' MB';
const pct = (a, b) => a == null ? '' : ' (' + Math.round((a / b) * 100) + '% of the free ' + mb(b) + ')';
const ago = (s) => s == null ? '—' : s < 90 ? s + ' s ago' : s < 5400 ? Math.round(s / 60) + ' min ago' : s < 172800 ? Math.round(s / 3600) + ' h ago' : Math.round(s / 86400) + ' days ago';
const since = (t) => t ? ago(Math.round((Date.now() - new Date(t).getTime()) / 1000)) : 'never';

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
    ['Up for', ago(s.server.uptimeSeconds).replace(' ago', '')],
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
  const names = { 'backup': 'Nightly backup', 'restore-drill': 'Restore test', 'clean-up': 'Clean-up', 'storage-check': 'R2 check', 'extensions': 'Manga extensions', 'manga-prefetch': 'Manga prefetch', 'ai-marker': 'AI marker' };
  out.push(...section('Worker jobs', s.jobs.length ? s.jobs.flatMap((j) => {
    const failing = j.last_error_at && (!j.last_ok_at || new Date(j.last_error_at) > new Date(j.last_ok_at));
    const rows = [[names[j.name] || j.name, 'worked ' + since(j.last_ok_at), !j.last_ok_at]];
    if (failing) rows.push(['', 'failed ' + since(j.last_error_at) + ': ' + j.last_error, true]);
    return rows;
  }) : [['Jobs', 'none have run yet']]));
  const headers = Object.entries(s.request.headers).map(([k, v]) => k + ': ' + v).join('\\n') || 'none';
  out.push(...section('Your request', [
    ['Your address, as seen', s.request.ip],
    ['Read from', s.request.from === 'none' ? 'the connection (CLIENT_IP_HEADER not set)' : s.request.from, s.request.from === 'none'],
    ['Forwarding headers', headers],
  ]));
  $('out').replaceChildren(...out);
  $('when').textContent = new Date().toLocaleTimeString();
}

async function load() {
  const token = sessionStorage.getItem(KEY);
  if (!token) { $('login').hidden = false; return; }
  try {
    const res = await fetch('/admin/status', { headers: { authorization: 'Bearer ' + token }, cache: 'no-store' });
    if (res.status === 401) { sessionStorage.removeItem(KEY); $('login').hidden = false; throw new Error('That token didn’t work.'); }
    if (!res.ok) throw new Error('The server answered ' + res.status + '.');
    render(await res.json());
    $('login').hidden = true;
    $('error').hidden = true;
  } catch (e) {
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
setInterval(() => { if (document.visibilityState === 'visible') load(); }, 30000);
</script>
</body>
</html>`;
