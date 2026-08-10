import { describe, expect, it, vi } from 'vitest';
import {
  executeUserShellCommand,
  MAX_USER_SHELL_CAPTURE_BYTES,
  MAX_USER_SHELL_STREAM_BYTES,
  parseUserShellCommandRecord,
  renderUserShellCommandForDisplay,
  renderUserShellCommandForModel,
  type UserShellExecutor,
} from '../../../src/services/UserShellCommandService.js';

function options(executor: UserShellExecutor, onEvent = vi.fn()) {
  return {
    executionId: 'shell-test',
    cwd: process.cwd(),
    env: {},
    signal: new AbortController().signal,
    executor,
    onEvent,
  };
}

describe('UserShellCommandService', () => {
  it('streams UTF-8 safely, removes ANSI, and records a model-safe boundary', async () => {
    const onEvent = vi.fn();
    const executor: UserShellExecutor = {
      execute: vi.fn(async (_command, execution) => {
        const utf8 = Buffer.from('你好');
        execution.onOutput?.(
          'stdout',
          Buffer.concat([Buffer.from('\u001b[31m'), utf8.subarray(0, 2)])
        );
        execution.onOutput?.(
          'stdout',
          Buffer.concat([utf8.subarray(2), Buffer.from('\u001b[0m\n')])
        );
        execution.onOutput?.('stderr', 'warning\n');
        return { exitCode: 0, stdout: '', stderr: '' };
      }),
    };

    const record = await executeUserShellCommand(
      'printf "<unsafe>&"',
      options(executor, onEvent)
    );

    expect(record).toMatchObject({
      status: 'completed',
      exitCode: 0,
      stdout: '你好',
      stderr: 'warning',
      binaryOutput: false,
    });
    expect(onEvent.mock.calls.map(([event]) => event.type)).toEqual([
      'started',
      'output',
      'output',
      'completed',
    ]);
    const model = renderUserShellCommandForModel(record);
    expect(model).toContain('<user_shell_command>');
    expect(model).toContain('&lt;unsafe&gt;&amp;');
    expect(model).not.toContain('\u001b');
    expect(renderUserShellCommandForDisplay(record)).toContain('! printf');
  });

  it('omits binary output and bounds capture plus streaming independently', async () => {
    const onEvent = vi.fn();
    const oversized = Buffer.alloc(MAX_USER_SHELL_CAPTURE_BYTES, 0x61);
    const executor: UserShellExecutor = {
      execute: vi.fn(async (_command, execution) => {
        execution.onOutput?.('stdout', oversized);
        execution.onOutput?.('stderr', Buffer.from([0x41, 0x00, 0x42]));
        return { exitCode: 3, stdout: '', stderr: '' };
      }),
    };

    const record = await executeUserShellCommand(
      'generate-output',
      options(executor, onEvent)
    );

    expect(record.status).toBe('failed');
    expect(record.binaryOutput).toBe(true);
    expect(record.stderr).toContain('binary stderr omitted');
    expect(record.stdoutOmittedBytes).toBeGreaterThan(0);
    expect(record.truncated).toBe(true);
    const streamedBytes = onEvent.mock.calls
      .map(([event]) => event)
      .filter((event) => event.type === 'output')
      .reduce((total, event) => total + Buffer.byteLength(event.chunk), 0);
    expect(streamedBytes).toBeLessThanOrEqual(MAX_USER_SHELL_STREAM_BYTES);
  });

  it('classifies abort, timeout, and executor failures without throwing', async () => {
    for (const [result, status] of [
      [
        {
          exitCode: null,
          stdout: '',
          stderr: '',
          aborted: true,
        },
        'aborted',
      ],
      [
        {
          exitCode: null,
          stdout: '',
          stderr: '',
          timedOut: true,
        },
        'timed_out',
      ],
      [
        {
          exitCode: null,
          stdout: '',
          stderr: '',
          error: 'spawn denied',
        },
        'spawn_error',
      ],
    ] as const) {
      const record = await executeUserShellCommand(
        'test',
        options({
          execute: vi.fn(async () => result),
        })
      );
      expect(record.status).toBe(status);
    }
  });

  it('waits for asynchronous output projection before completion', async () => {
    const order: string[] = [];
    await executeUserShellCommand('echo ordered', {
      ...options({
        execute: vi.fn(async (_command, execution) => {
          execution.onOutput?.('stdout', 'ordered');
          return { exitCode: 0, stdout: '', stderr: '' };
        }),
      }),
      onEvent: async (event) => {
        if (event.type === 'output') {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        order.push(event.type);
      },
    });
    expect(order).toEqual(['started', 'output', 'completed']);
  });

  it('parses only complete versioned durable records', async () => {
    const record = await executeUserShellCommand(
      'true',
      options({
        execute: vi.fn(async () => ({
          exitCode: 0,
          stdout: '',
          stderr: '',
        })),
      })
    );
    expect(parseUserShellCommandRecord(record)).toEqual(record);
    expect(parseUserShellCommandRecord({ ...record, version: 2 })).toBeUndefined();
    expect(parseUserShellCommandRecord({ ...record, stdout: 42 })).toBeUndefined();
  });
});
