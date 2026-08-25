import { describe, expect, it } from 'vitest';
import {
  fitToolDisplayForSurface,
  projectDurableToolResult,
} from '../../../../../src/tools/display/ToolResultProjector.js';
import { ToolErrorType } from '../../../../../src/tools/types/index.js';
import {
  formatToolCallSummary,
  formatToolDisplay,
  renderToolDisplayToString,
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

  it.each([
    {
      success: true,
      summary: 'Explore 任务完成',
      childSummary: 'CHILD_SUCCESS_RESULT',
      error: undefined,
    },
    {
      success: false,
      summary: 'Explore 任务失败',
      childSummary: 'CHILD_FAILED_RESULT',
      error: {
        type: ToolErrorType.EXECUTION_ERROR,
        message: 'child failed',
      },
    },
  ])('shows a bounded terminal Task result when success=$success', (fixture) => {
    const display = formatToolDisplay('Task', {
      success: fixture.success,
      llmContent: fixture.childSummary,
      ...(fixture.error ? { error: fixture.error } : {}),
      metadata: {
        summary: fixture.summary,
        subagentSummary: fixture.childSummary,
      },
    });

    expect(display.summary).toBe(fixture.summary);
    expect(display.detail).toBe(fixture.childSummary);
    expect(renderToolDisplayToString(display)).toContain(fixture.childSummary);
  });

  it('summarizes ApplyPatch without exposing the full patch body', () => {
    const patch =
      '*** Begin Patch\n' +
      '*** Update File: first.ts\n@@\n-secret\n+public\n' +
      '*** Add File: second.ts\n+value\n' +
      '*** End Patch';
    expect(formatToolCallSummary('ApplyPatch', { patch })).toBe(
      'Applying atomic patch to 2 file(s)'
    );
    const display = formatToolDisplay('ApplyPatch', {
      success: true,
      llmContent: 'done',
      metadata: {
        changes: [
          { kind: 'update', path: '/workspace/first.ts' },
          { kind: 'add', path: '/workspace/second.ts' },
        ],
      },
    });
    expect(display.detail).toContain('M /workspace/first.ts');
    expect(display.detail).toContain('A /workspace/second.ts');
    expect(JSON.stringify(display)).not.toContain('secret');
  });

  it('projects failed durable output null without rendering null', () => {
    const restored = projectDurableToolResult({
      toolName: 'Bash',
      output: null,
      error: 'Command interrupted because Blade restarted',
      metadata: { processRestartRecovery: true },
    });
    const display = formatToolDisplay('Bash', restored);
    const rendered = renderToolDisplayToString(display);

    expect(display.status).toBe('fail');
    expect(rendered).toContain('Blade restarted');
    expect(rendered).not.toContain('null');
  });

  it('keeps both Bash stream tails and exactly one truncation suffix', () => {
    const display = formatToolDisplay('Bash', {
      success: true,
      llmContent: {
        stdout: `${'stdout-head\n'.repeat(10)}STDOUT_TAIL`,
        stderr: `${'stderr-head\n'.repeat(10)}STDERR_TAIL`,
        output_truncated: true,
        truncation_info:
          'Output truncated: stdout: retained tail shown; stderr: retained tail shown',
      },
      metadata: {
        summary: 'Command completed',
        output_truncated: true,
        stdout_omitted_bytes: 4096,
        stderr_omitted_bytes: 2048,
      },
    });

    expect(display.detail).toContain('stdout:');
    expect(display.detail).toContain('STDOUT_TAIL');
    expect(display.detail).toContain('stderr:');
    expect(display.detail).toContain('STDERR_TAIL');
    expect(display.detail?.split('Output truncated')).toHaveLength(2);
    expect(display.detail?.split('\n').at(-1)).toMatch(/^Output truncated:/);
  });

  it('fits Bash details to a surface budget without losing stream tails or suffix', () => {
    const display = formatToolDisplay('Bash', {
      success: true,
      llmContent: {
        stdout: `stdout-${'x'.repeat(600)}-STDOUT_TAIL`,
        stderr: `stderr-${'y'.repeat(600)}-STDERR_TAIL`,
        output_truncated: true,
        truncation_info: 'Output truncated: earliest bytes omitted',
      },
      metadata: { summary: 'Command completed', output_truncated: true },
    });
    const fitted = fitToolDisplayForSurface(display, 500);

    expect(fitted.detail?.length).toBeLessThanOrEqual(500);
    expect(fitted.detail).toContain('stdout:');
    expect(fitted.detail).toContain('STDOUT_TAIL');
    expect(fitted.detail).toContain('stderr:');
    expect(fitted.detail).toContain('STDERR_TAIL');
    expect(fitted.detail?.split('Output truncated')).toHaveLength(2);
    expect(fitted.detail?.split('\n').at(-1)).toBe(
      'Output truncated: earliest bytes omitted'
    );
  });

  it('does not split surrogate pairs while fitting a long Bash line', () => {
    const display = formatToolDisplay('Bash', {
      success: true,
      llmContent: {
        stdout: `prefix-${'😀'.repeat(300)}-EMOJI_TAIL`,
        stderr: '',
      },
      metadata: { summary: 'Command completed' },
    });
    const fitted = fitToolDisplayForSurface(display, 180);
    const detail = fitted.detail ?? '';

    expect(detail.length).toBeLessThanOrEqual(180);
    expect(detail).toContain('EMOJI_TAIL');
    expect(/[\uD800-\uDBFF]$/.test(detail)).toBe(false);
    expect(/^[\uDC00-\uDFFF]/.test(detail)).toBe(false);
  });

  it('renders bounded Browser summaries without page snapshot content', () => {
    expect(
      formatToolCallSummary('BrowserNavigate', {
        url: 'https://example.com/path?token=secret',
      })
    ).toBe('Browser navigate: https://example.com');
    expect(
      formatToolCallSummary('BrowserInteract', {
        action: { kind: 'click' },
      })
    ).toBe('Browser interact: click');

    const display = formatToolDisplay('BrowserInteract', {
      success: false,
      llmContent: '<browser_data>untrusted page content</browser_data>',
      error: { message: 'Action timed out' },
      metadata: {
        summary: 'BrowserInteract: error',
        browser: {
          action: 'BrowserInteract',
          status: 'error',
          pageId: 'browser_page_123',
          origin: 'https://example.com:443',
          errorCode: 'browser_timeout',
          sideEffectsUncertain: true,
          diagnosticCount: 4,
          truncated: true,
        },
      },
    });

    expect(display).toEqual({
      status: 'fail',
      summary: 'BrowserInteract: error',
      detail: [
        'Origin: https://example.com:443',
        'Page: browser_page_123',
        'Error: browser_timeout',
        'Side effects: uncertain; inspect before retrying',
        'Diagnostics: 4',
        'Output: truncated',
      ].join('\n'),
    });
    expect(display.detail).not.toContain('untrusted page content');
  });
});
