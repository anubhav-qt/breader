import assert from 'node:assert/strict';
import { test } from 'node:test';
import { opensAt, usageRequest, usageWindows } from '../../../shared/src/accounts.ts';

/*
 * The AI accounts' limits (shared/src/accounts.ts): each provider's answer read into the admin
 * page's bars, and when an account that's used up can serve again. Sample answers in each
 * provider's shape, no network.
 */

const NOW = Date.parse('2026-10-10T12:00:00.000Z');

test('Antigravity: the Gemini group’s limits, and nothing from its other models', () => {
  const body = {
    groups: [
      {
        buckets: [
          { bucketId: 'gemini-5h', window: '5h', resetTime: '2026-10-10T15:00:00Z', remainingFraction: 0.25 },
          { bucketId: 'gemini-weekly', window: 'weekly', resetTime: '2026-10-14T00:00:00Z', remainingFraction: '1' },
          { bucketId: 'gemini-unknown', window: '5h' },
        ],
      },
      { buckets: [{ bucketId: 'claude-5h', window: '5h', resetTime: '2026-10-10T13:00:00Z', remainingFraction: 0 }] },
    ],
  };
  assert.deepEqual(usageWindows('antigravity', JSON.stringify(body)), [
    { label: '5 hours', usedPercent: 75, resetsAt: '2026-10-10T15:00:00Z' },
    { label: 'Week', usedPercent: 0, resetsAt: '2026-10-14T00:00:00Z' },
  ]);
});

test('Claude Code: its 5-hour and weekly limits, kept between 0 and 100', () => {
  const body = {
    five_hour: { utilization: 42.55, resets_at: '2026-10-10T14:00:00Z' },
    seven_day: { utilization: 130, resets_at: null },
    seven_day_opus: null,
  };
  assert.deepEqual(usageWindows('claude', JSON.stringify(body)), [
    { label: '5 hours', usedPercent: 42.6, resetsAt: '2026-10-10T14:00:00Z' },
    { label: 'Week', usedPercent: 100, resetsAt: null },
  ]);
});

test('Codex: a reset as a time, or as seconds from now', () => {
  const body = {
    rate_limit: {
      primary_window: { used_percent: 12, reset_after_seconds: 3600 },
      secondary_window: { used_percent: '100', reset_at: NOW / 1000 + 86_400 },
    },
  };
  assert.deepEqual(usageWindows('codex', JSON.stringify(body), NOW), [
    { label: '5 hours', usedPercent: 12, resetsAt: '2026-10-10T13:00:00.000Z' },
    { label: 'Week', usedPercent: 100, resetsAt: '2026-10-11T12:00:00.000Z' },
  ]);
});

test('an answer that can’t be read has no limits', () => {
  assert.equal(usageWindows('antigravity', 'not json'), null);
  assert.equal(usageWindows('antigravity', '{}'), null);
  assert.equal(usageWindows('claude', '{"five_hour":{"utilization":"lots"}}'), null);
  assert.equal(usageWindows('someone-else', '{"five_hour":{"utilization":5}}'), null);
});

test('an account serves now while every limit has some left', () => {
  const windows = [{ label: '5 hours', usedPercent: 99.9, resetsAt: null }, { label: 'Week', usedPercent: 10, resetsAt: null }];
  assert.equal(opensAt(windows, NOW), NOW);
});

test('a used-up account serves again when the last of its used-up limits fills', () => {
  const windows = [
    { label: '5 hours', usedPercent: 100, resetsAt: '2026-10-10T15:00:00Z' },
    { label: 'Week', usedPercent: 100, resetsAt: '2026-10-12T00:00:00Z' },
  ];
  assert.equal(opensAt(windows, NOW), Date.parse('2026-10-12T00:00:00Z'));
  assert.equal(opensAt([windows[0]], NOW), Date.parse('2026-10-10T15:00:00Z'));
});

test('a used-up limit that doesn’t say when it fills leaves it unknown', () => {
  assert.equal(opensAt([{ label: 'Week', usedPercent: 100, resetsAt: null }], NOW), null);
  assert.equal(opensAt([{ label: 'Week', usedPercent: 100, resetsAt: 'soon' }], NOW), null);
});

test('only an Antigravity account with a project can be asked; the token is left for the proxy to fill', () => {
  assert.equal(usageRequest({ provider: 'antigravity' }), null);
  const ag = usageRequest({ provider: 'antigravity', project_id: 'p-1' });
  assert.equal(ag?.method, 'POST');
  assert.equal(ag?.header.Authorization, 'Bearer $TOKEN$');
  assert.equal(ag?.data, '{"project":"p-1"}');
  assert.equal(usageRequest({ provider: 'codex', chatgpt_account_id: 'acc' })?.header['Chatgpt-Account-Id'], 'acc');
  assert.equal(usageRequest({ provider: 'gemini-cli' }), null);
});
