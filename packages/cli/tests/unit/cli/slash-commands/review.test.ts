import { describe, expect, it, vi } from 'vitest';
import reviewCommand from '../../../../src/slash-commands/review.js';
import type { SlashCommandContext } from '../../../../src/slash-commands/types.js';

function context() {
  const run = vi.fn(async () => ({
    reviewId: 'review-1',
    status: 'completed' as const,
    findings: 1,
    content: '## Code Review\n\nOne finding.',
  }));
  const sendMessage = vi.fn();
  return {
    run,
    sendMessage,
    value: {
      cwd: '/workspace',
      sessionId: 'session-1',
      codeReview: { run },
      acp: { sendMessage },
    } satisfies SlashCommandContext,
  };
}

describe('/review command', () => {
  it('starts an uncommitted review by default', async () => {
    const fixture = context();
    const result = await reviewCommand.handler([], fixture.value);

    expect(fixture.run).toHaveBeenCalledWith({ kind: 'uncommitted' }, undefined);
    expect(result).toMatchObject({
      success: true,
      content: '## Code Review\n\nOne finding.',
      data: { reviewId: 'review-1', findings: 1 },
    });
  });

  it('parses base and commit targets without accepting trailing input', async () => {
    const fixture = context();
    await reviewCommand.handler(['base', 'main'], fixture.value);
    await reviewCommand.handler(['commit', 'HEAD'], fixture.value);
    const invalid = await reviewCommand.handler(
      ['base', 'main', 'extra'],
      fixture.value
    );

    expect(fixture.run).toHaveBeenNthCalledWith(
      1,
      { kind: 'base', ref: 'main' },
      undefined
    );
    expect(fixture.run).toHaveBeenNthCalledWith(
      2,
      { kind: 'commit', ref: 'HEAD' },
      undefined
    );
    expect(invalid.success).toBe(false);
  });

  it('fails closed when the surface has no native review boundary', async () => {
    const result = await reviewCommand.handler([], {
      cwd: '/workspace',
    });
    expect(result).toEqual({
      success: false,
      error: '当前入口不支持原生代码审查',
    });
  });
});
