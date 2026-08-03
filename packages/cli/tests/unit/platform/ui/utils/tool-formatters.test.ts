import { describe, expect, it } from 'vitest';
import { formatToolCallSummary } from '../../../../../src/ui/utils/toolFormatters.js';

describe('tool formatters', () => {
  it('identifies WriteStdin target without exposing input content', () => {
    const summary = formatToolCallSummary('WriteStdin', {
      shell_id: 'bash_owned',
      data: 'sensitive-input\n',
      close_stdin: true,
    });

    expect(summary).toBe('Sending input to Shell: bash_owned');
    expect(summary).not.toContain('sensitive-input');
  });
});
