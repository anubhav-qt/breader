import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FEEDBACK_CHARS } from '@breader/shared/feedback';

const post = vi.fn();
vi.mock('../../lib/api', () => ({ api: { post: (...a: unknown[]) => post(...a) } }));

const load = async () => {
  vi.resetModules();
  return import('./send');
};

describe('feedback', () => {
  beforeEach(() => {
    post.mockReset();
    vi.unstubAllEnvs();
  });

  it('can be sent with some words, not with none or too many', async () => {
    const { canSend } = await load();
    expect(canSend('')).toBe(false);
    expect(canSend('   \n ')).toBe(false);
    expect(canSend('Dark covers')).toBe(true);
    expect(canSend(`  ${'x'.repeat(FEEDBACK_CHARS)}  `)).toBe(true);
    expect(canSend('x'.repeat(FEEDBACK_CHARS + 1))).toBe(false);
  });

  it('sends the words trimmed, with the build, and forgets the draft once sent', async () => {
    vi.stubEnv('VITE_RELEASE', 'abc123');
    const { keepDraft, readDraft, sendFeedback } = await load();
    keepDraft('feedback', '  Love it  ');
    post.mockResolvedValue({ ok: true });
    await sendFeedback('feedback', '  Love it  ');
    expect(post).toHaveBeenCalledWith('/v1/feedback', { kind: 'feedback', body: 'Love it', release: 'abc123' });
    expect(readDraft()).toEqual({ kind: 'feedback', body: '' });
  });

  it('keeps the draft when sending fails', async () => {
    const { keepDraft, readDraft, sendFeedback } = await load();
    keepDraft('feature', 'Zoom per series');
    post.mockRejectedValue(new Error('Can’t reach the server.'));
    await expect(sendFeedback('feature', 'Zoom per series')).rejects.toThrow('reach');
    expect(readDraft()).toEqual({ kind: 'feature', body: 'Zoom per series' });
    expect(post.mock.calls[0][1]).not.toHaveProperty('release');
  });
});
