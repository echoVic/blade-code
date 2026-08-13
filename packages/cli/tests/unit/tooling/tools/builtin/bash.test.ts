import { spawn } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { bashTool } from '../../../../../src/tools/builtin/shell/bash.js';
import {
  installWorkspaceSandboxBackendForTests,
  type WorkspaceSandboxBackend,
} from '../../../../../src/tools/builtin/shell/WorkspaceWriteSandbox.js';

describe('Bash Tool', () => {
  const cleanups: Array<() => void | Promise<void>> = [];
  const outputBudget = 1024 * 1024;

  function commandFor(program: string): string {
    return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(program)}`;
  }

  function rendered(value: unknown): string {
    return JSON.stringify(value);
  }

  beforeAll(async () => {
    const childProcess =
      await vi.importActual<typeof import('node:child_process')>('node:child_process');
    vi.mocked(spawn).mockImplementation(childProcess.spawn);
  });

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('shares batch execution while retaining execute-bucket limits', () => {
    expect(bashTool.isConcurrencySafe).toBe(false);
    expect(bashTool.parallelism).toBe('shared');
  });

  it('reports a non-zero foreground exit as a tool failure', async () => {
    const result = await bashTool.execute({
      command:
        'node -e \"process.stderr.write(\\\"expected failure\\\"); process.exit(7)\"',
      timeout: 10_000,
      env: {},
      run_in_background: false,
    });

    expect(result.success).toBe(false);
    expect(result.error?.type).toBe('execution_error');
    expect(result.error?.message).toContain('Command exited with code 7');
    expect(result.error?.message).toContain('stderr:\nexpected failure');
    expect(result.llmContent).toMatchObject({
      stderr: 'expected failure',
      exit_code: 7,
    });
    expect(result.metadata).toMatchObject({
      exit_code: 7,
      has_stderr: true,
    });
  });

  it('never includes a command or its output in raw progress', async () => {
    const sentinel = 'MUST_NOT_ENTER_PROGRESS';
    const updateOutput = vi.fn<(message: string) => void>();
    const result = await bashTool.execute(
      {
        command: commandFor(`process.stdout.write(${JSON.stringify(sentinel)})`),
        timeout: 10_000,
        env: {},
        run_in_background: false,
      },
      undefined,
      { updateOutput }
    );

    expect(result.success).toBe(true);
    expect(updateOutput.mock.calls.flat().join('\n')).not.toContain(sentinel);
  });

  it('bounds successful stdout capture while retaining its tail and accounting facts', async () => {
    const prefix = 'SUCCESS_PREFIX_MUST_NOT_LEAK';
    const tail = 'SUCCESS_TAIL_RETAINED';
    const result = await bashTool.execute({
      command: commandFor(
        `process.stdout.write(${JSON.stringify(prefix)} + 'x'.repeat(${
          outputBudget + 4096
        }) + ${JSON.stringify(tail)})`
      ),
      timeout: 10_000,
      env: {},
      run_in_background: false,
    });

    expect(result.success).toBe(true);
    expect(result.llmContent).toMatchObject({
      stdout: expect.stringContaining(tail),
      output_truncated: true,
      stdout_omitted_bytes: expect.any(Number),
      stdout_total_bytes: expect.any(Number),
      output_accounting_complete: true,
    });
    expect(rendered(result.llmContent)).not.toContain(prefix);
    expect(result.metadata).toMatchObject({
      capture_truncated: true,
      output_truncated: true,
      output_accounting_complete: true,
      terminal_transport: 'local',
      terminal_output_merged: false,
    });
    expect(result.metadata?.stdout_total_bytes).toBeGreaterThan(outputBudget);
    expect(result.metadata?.stdout_retained_bytes).toBeLessThanOrEqual(outputBudget);
    expect(result.metadata?.stdout_omitted_bytes).toBeGreaterThan(0);
    expect(result.metadata?.raw_output_bytes).toBeGreaterThan(outputBudget);
    expect(result.metadata?.stdout_length).toBeGreaterThan(outputBudget);
  });

  it('bounds failed stderr capture and builds the error from the safe projection', async () => {
    const prefix = 'FAILURE_PREFIX_MUST_NOT_LEAK';
    const tail = 'FAILURE_TAIL_RETAINED';
    const result = await bashTool.execute({
      command: commandFor(
        `process.stderr.write(${JSON.stringify(prefix)} + 'e'.repeat(${
          outputBudget + 4096
        }) + ${JSON.stringify(tail)}, () => process.exit(7))`
      ),
      timeout: 10_000,
      env: {},
      run_in_background: false,
    });

    expect(result.success).toBe(false);
    expect(result.error?.message).toContain(tail);
    expect(result.error?.message).not.toContain(prefix);
    expect(result.error?.message.length).toBeLessThan(outputBudget);
    expect(result.llmContent).toMatchObject({
      stderr: expect.stringContaining(tail),
      output_truncated: true,
      stderr_omitted_bytes: expect.any(Number),
      stderr_total_bytes: expect.any(Number),
      output_accounting_complete: true,
    });
    expect(result.metadata?.stderr_total_bytes).toBeGreaterThan(outputBudget);
    expect(result.metadata?.stderr_retained_bytes).toBeLessThanOrEqual(outputBudget);
    expect(result.metadata?.stderr_omitted_bytes).toBeGreaterThan(0);
  });

  it('keeps independent bounded budgets for stdout and stderr', async () => {
    const stdoutTail = 'STDOUT_TAIL_RETAINED';
    const stderrTail = 'STDERR_TAIL_RETAINED';
    const result = await bashTool.execute({
      command: commandFor(
        `process.stdout.write('stdout-prefix' + 'x'.repeat(${
          outputBudget + 4096
        }) + ${JSON.stringify(stdoutTail)}); process.stderr.write('stderr-prefix' + 'e'.repeat(${
          outputBudget + 4096
        }) + ${JSON.stringify(stderrTail)})`
      ),
      timeout: 10_000,
      env: {},
      run_in_background: false,
    });

    expect(result.success).toBe(true);
    expect(result.llmContent).toMatchObject({
      stdout: expect.stringContaining(stdoutTail),
      stderr: expect.stringContaining(stderrTail),
    });
    expect(result.metadata?.stdout_omitted_bytes).toBeGreaterThan(0);
    expect(result.metadata?.stderr_omitted_bytes).toBeGreaterThan(0);
    expect(result.metadata?.stdout_retained_bytes).toBeLessThanOrEqual(outputBudget);
    expect(result.metadata?.stderr_retained_bytes).toBeLessThanOrEqual(outputBudget);
  });

  it('uses bounded projected previews for timeout and abort terminal metadata', async () => {
    const prefix = 'INTERRUPTED_PREFIX_MUST_NOT_LEAK';
    const tail = 'INTERRUPTED_TAIL_RETAINED';
    const program = `process.stdout.write(${JSON.stringify(prefix)} + 'x'.repeat(${
      outputBudget + 4096
    }) + ${JSON.stringify(tail)}, () => setInterval(() => {}, 1000))`;
    const timeoutResult = await bashTool.execute({
      command: commandFor(program),
      timeout: 2_000,
      env: {},
      run_in_background: false,
    });

    const controller = new AbortController();
    const abortResultPromise = bashTool.execute(
      {
        command: commandFor(program),
        timeout: 10_000,
        env: {},
        run_in_background: false,
      },
      controller.signal
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    controller.abort();
    const abortResult = await abortResultPromise;

    for (const result of [timeoutResult, abortResult]) {
      expect(typeof result.llmContent).toBe('string');
      expect(result.metadata?.stdout).toContain(tail);
      expect(result.metadata?.stdout).not.toContain(prefix);
      expect(String(result.metadata?.stdout).length).toBeLessThan(outputBudget);
      expect(result.metadata).toMatchObject({
        has_stderr: false,
        output_accounting_complete: true,
        terminal_transport: 'local',
        terminal_output_merged: false,
      });
    }
  });

  it('merges Session environment before invocation overrides', async () => {
    const result = await bashTool.execute(
      {
        command:
          'node -e "process.stdout.write(process.env.SESSION_ONLY + \':\' + process.env.SHARED)"',
        timeout: 10_000,
        env: { SHARED: 'invocation' },
        run_in_background: false,
      },
      undefined,
      {
        environment: {
          SESSION_ONLY: 'session',
          SHARED: 'session',
        },
      }
    );

    expect(result.success).toBe(true);
    expect(result.llmContent).toMatchObject({
      stdout: 'session:invocation',
      exit_code: 0,
    });
  });

  it('runs local audit commands through a workspace-read-only sandbox', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'blade-verifier-bash-'));
    const canonicalWorkspace = await realpath(workspace);
    const previousSecret = process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_API_KEY = 'must-not-reach-verifier';
    const prepare = vi.fn<WorkspaceSandboxBackend['prepare']>(async (input) => ({
      executable: '/bin/bash',
      args: ['-c', input.command],
      env: {},
      sandboxed: true,
      inheritProcessEnv: false,
      cleanup: () => undefined,
    }));
    const restore = installWorkspaceSandboxBackendForTests({ prepare });
    cleanups.push(
      restore,
      () => {
        if (previousSecret === undefined) delete process.env.DEEPSEEK_API_KEY;
        else process.env.DEEPSEEK_API_KEY = previousSecret;
      },
      () => rm(workspace, { recursive: true, force: true })
    );

    for (const subagentType of ['verification', 'goal-verification', 'review']) {
      const result = await bashTool.execute(
        {
          command:
            'printf "%s:%s:%s" "$PATH" "${DEEPSEEK_API_KEY-unset}" "$GIT_CONFIG_GLOBAL"',
          timeout: 10_000,
          env: {},
          run_in_background: false,
        },
        undefined,
        {
          workspaceRoot: canonicalWorkspace,
          subagentType,
        }
      );

      expect(result.success).toBe(true);
      expect(result.metadata?.sandboxed).toBe(true);
      expect(result.llmContent).toMatchObject({
        stdout: expect.stringMatching(/.+:unset:\/dev\/null$/),
      });
    }
    expect(prepare).toHaveBeenCalledTimes(3);
    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        command:
          'printf "%s:%s:%s" "$PATH" "${DEEPSEEK_API_KEY-unset}" "$GIT_CONFIG_GLOBAL"',
        cwd: canonicalWorkspace,
        workspaceRoot: canonicalWorkspace,
        access: 'workspace-read-only',
      })
    );
  });
});
