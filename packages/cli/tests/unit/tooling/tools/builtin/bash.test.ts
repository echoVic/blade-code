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

  it('runs local verification commands through a workspace-read-only sandbox', async () => {
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

    const result = await bashTool.execute(
      {
        command: 'printf "%s:%s" "$PATH" "${DEEPSEEK_API_KEY-unset}"',
        timeout: 10_000,
        env: {},
        run_in_background: false,
      },
      undefined,
      {
        workspaceRoot: canonicalWorkspace,
        subagentType: 'verification',
      }
    );

    expect(result.success).toBe(true);
    expect(result.metadata?.sandboxed).toBe(true);
    expect(result.llmContent).toMatchObject({
      stdout: expect.stringMatching(/.+:unset$/),
    });
    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'printf "%s:%s" "$PATH" "${DEEPSEEK_API_KEY-unset}"',
        cwd: canonicalWorkspace,
        workspaceRoot: canonicalWorkspace,
        access: 'workspace-read-only',
      })
    );
  });
});
