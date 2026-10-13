import { describe, expect, it, vi } from 'vitest';
import { executeSlashCommand } from '../../../../src/slash-commands/index.js';
import securityReviewCommand from '../../../../src/slash-commands/securityReview.js';
import type { SlashCommandContext } from '../../../../src/slash-commands/types.js';

describe('/security-review', () => {
  const context = () => {
    const run = vi.fn(async () => ({
      reviewId: 'security-1',
      status: 'completed' as const,
      findings: 0,
      content: '## Security Review\n\nNo actionable findings.',
    }));
    const sendMessage = vi.fn();
    return {
      run,
      value: {
        cwd: '/workspace',
        codeReview: { run },
        acp: { sendMessage },
      } satisfies SlashCommandContext,
    };
  };

  it('dispatches the native security mode with an exact target', async () => {
    const fixture = context();
    const result = await executeSlashCommand(
      '/security-review base main',
      fixture.value
    );
    expect(fixture.run).toHaveBeenCalledWith(
      { kind: 'base', ref: 'main', mode: 'security' },
      undefined
    );
    expect(result).toMatchObject({
      success: true,
      data: { reviewId: 'security-1', findings: 0 },
    });
  });

  it('uses uncommitted changes by default and rejects extra input', async () => {
    const fixture = context();
    await securityReviewCommand.handler([], fixture.value);
    expect(fixture.run).toHaveBeenCalledWith(
      { kind: 'uncommitted', mode: 'security' },
      undefined
    );
    const invalid = await securityReviewCommand.handler(
      ['commit', 'HEAD', 'extra'],
      fixture.value
    );
    expect(invalid).toMatchObject({
      success: false,
      error: 'Usage: /security-review commit <ref>',
    });
  });

  it('requires a surface-owned review runtime', async () => {
    expect(
      await securityReviewCommand.handler([], { cwd: '/workspace' })
    ).toMatchObject({ success: false });
  });
});
