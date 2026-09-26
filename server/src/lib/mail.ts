import type { Env } from '../env.ts';
import { log } from '../log.ts';

/*
 * Account emails (confirm your address, reset your password), sent through Resend's HTTP API
 * within the request, so they work from either server. Without RESEND_API_KEY (local development)
 * the link is logged instead.
 */

export interface Mail {
  to: string;
  subject: string;
  /** Plain paragraphs; the link goes in as a button in the HTML version. */
  lines: string[];
  link: { label: string; url: string };
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

function html(m: Mail) {
  const p = (s: string) => `<p style="margin:0 0 16px;font:16px/1.5 system-ui,sans-serif;color:#222">${esc(s)}</p>`;
  return `<!doctype html><html><body style="margin:0;padding:32px 20px;background:#f6f5f2">
<div style="max-width:480px;margin:0 auto;background:#fff;border-radius:14px;padding:28px">
<p style="margin:0 0 20px;font:800 18px/1 system-ui,sans-serif;color:#111">breader</p>
${m.lines.map(p).join('\n')}
<p style="margin:24px 0"><a href="${esc(m.link.url)}" style="display:inline-block;padding:12px 18px;border-radius:10px;background:#111;color:#fff;text-decoration:none;font:700 15px/1 system-ui,sans-serif">${esc(m.link.label)}</a></p>
<p style="margin:0;font:13px/1.5 system-ui,sans-serif;color:#777">Or open this link: ${esc(m.link.url)}</p>
</div></body></html>`;
}

const text = (m: Mail) => [...m.lines, '', `${m.link.label}: ${m.link.url}`].join('\n\n');

export async function sendMail(env: Env, m: Mail) {
  if (!env.RESEND_API_KEY) {
    log.info({ to: m.to, subject: m.subject, link: m.link.url }, 'email not sent (no RESEND_API_KEY); its link is here');
    return;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: env.MAIL_FROM, to: [m.to], subject: m.subject, html: html(m), text: text(m) }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Resend refused the email (${res.status}): ${(await res.text()).slice(0, 300)}`);
}
