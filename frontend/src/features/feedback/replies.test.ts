import { afterEach, describe, expect, it, vi } from 'vitest';

const post = vi.fn();
vi.mock('../../lib/api', () => ({ api: { post: (...a: unknown[]) => post(...a) } }));

const { anyWorking, askReplies, DONE, doneNote } = await import('./replies');

afterEach(() => post.mockReset());

describe('feedback replies', () => {
  it('asks the server once, and an error tells nothing', async () => {
    post.mockResolvedValueOnce({ replies: [{ id: 1, kind: 'working' }] });
    expect(await askReplies()).toEqual([{ id: 1, kind: 'working' }]);
    expect(post).toHaveBeenCalledWith('/v1/feedback/replies', {});

    post.mockRejectedValueOnce(new Error('offline'));
    expect(await askReplies()).toEqual([]);
    post.mockResolvedValueOnce({ nope: true });
    expect(await askReplies()).toEqual([]);
  });

  it('puts every done line in one What’s new note, and working ones in the toast', () => {
    const replies = [
      { id: 1, kind: 'working' as const },
      { id: 2, kind: 'done' as const, reply: 'Women’s words in Devils read in a woman’s voice.' },
      { id: 3, kind: 'done' as const, reply: 'A bigger pause button.' },
    ];
    expect(doneNote(replies)).toEqual({ id: 'feedback-done', title: DONE, lines: ['Women’s words in Devils read in a woman’s voice.', 'A bigger pause button.'] });
    expect(anyWorking(replies)).toBe(true);
    expect(doneNote([{ id: 1, kind: 'working' }])).toBeNull();
    expect(anyWorking([])).toBe(false);
  });
});
