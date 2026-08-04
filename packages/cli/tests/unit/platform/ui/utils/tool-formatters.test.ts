import { describe, expect, it } from 'vitest';
import {
  formatToolCallSummary,
  formatToolDisplay,
} from '../../../../../src/ui/utils/toolFormatters.js';

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

  it('shows bounded TaskOutput diagnostics consistently across surfaces', () => {
    const display = formatToolDisplay('TaskOutput', {
      success: true,
      llmContent: {
        status: 'exited',
        stdout: 'latest stdout marker',
        stderr: 'latest stderr marker',
        output_truncated: true,
        stdout_omitted_bytes: 4096,
        stderr_omitted_bytes: 2048,
      },
      metadata: { summary: 'Task output: bash_bounded' },
    });

    expect(display.detail).toContain('Output truncated');
    expect(display.detail).toContain('6144 earlier bytes omitted');
    expect(display.detail).toContain('latest stdout marker');
    expect(display.detail).toContain('latest stderr marker');
    expect(display.detail?.length).toBeLessThanOrEqual(500);
  });
});
