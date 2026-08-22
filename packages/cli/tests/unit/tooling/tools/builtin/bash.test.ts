import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type * as acp from '@agentclientprotocol/sdk';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AcpServiceContext } from '../../../../../src/acp/AcpServiceContext.js';
import { bashTool } from '../../../../../src/tools/builtin/shell/bash.js';
import {
  installWorkspaceSandboxBackendForTests,
  type WorkspaceSandboxBackend,
} from '../../../../../src/tools/builtin/shell/WorkspaceWriteSandbox.js';
import { ControlledTerminalClient } from '../../../../support/acp/ControlledTerminalClient.js';
import {
  createPairedAcpHarness,
  type PairedAcpHarness,
} from '../../../../support/acp/createPairedAcpHarness.js';

describe('Bash Tool', () => {
  const cleanups: Array<() => void | Promise<void>> = [];
  const outputBudget = 1024 * 1024;
  const acpCapabilities: acp.ClientCapabilities = { terminal: true };

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

  it('projects real ACP terminal capture without forwarding raw output as progress', async () => {
    const sessionId = 'bash-acp-terminal';
    const client = new ControlledTerminalClient();
    const harness = createPairedAcpHarness(client);
    const sentinel = 'ACP_RAW_OUTPUT_MUST_NOT_ENTER_PROGRESS';
    const updateOutput = vi.fn<(message: string) => void>();
    client.enqueueOutput({ output: sentinel, truncated: false });
    client.enqueueOutput({ output: sentinel, truncated: false });
    client.resolveWait({ exitCode: 0 });
    AcpServiceContext.initializeSession(
      harness.agentConnection,
      sessionId,
      acpCapabilities,
      '/workspace/acp'
    );
    cleanups.push(
      () => AcpServiceContext.destroySession(sessionId),
      () => harness.close()
    );

    const result = await bashTool.execute(
      {
        command: 'printf remote-output',
        timeout: 10_000,
        cwd: '/workspace/acp',
        env: {},
        run_in_background: false,
      },
      undefined,
      {
        sessionId,
        workspaceRoot: '/workspace/acp',
        updateOutput,
      }
    );

    expect(client.createRequests).toEqual([
      expect.objectContaining({
        sessionId,
        command: 'printf remote-output',
        cwd: '/workspace/acp',
      }),
    ]);
    expect(result.success).toBe(true);
    expect(result.llmContent).toMatchObject({
      stdout: sentinel,
      stderr: '',
      terminal_output_merged: true,
      stdout_total_bytes: Buffer.byteLength(sentinel),
      stderr_total_bytes: 0,
      output_accounting_complete: true,
    });
    expect(result.metadata).toMatchObject({
      acp_mode: true,
      terminal_transport: 'acp',
      terminal_output_merged: true,
      stdout_total_bytes: Buffer.byteLength(sentinel),
      stderr_total_bytes: 0,
      output_accounting_complete: true,
    });
    expect(updateOutput.mock.calls.flat().join('\n')).not.toContain(sentinel);
  });

  it('fails closed when the real ACP terminal cannot be created', async () => {
    const sessionId = 'bash-acp-fail-closed';
    const directory = await mkdtemp(path.join(os.tmpdir(), 'blade-acp-bash-'));
    const marker = path.join(directory, 'must-not-exist');
    const client = new ControlledTerminalClient();
    const harness: PairedAcpHarness = createPairedAcpHarness(client);
    client.failCreate(new Error('terminal unavailable'));
    AcpServiceContext.initializeSession(
      harness.agentConnection,
      sessionId,
      acpCapabilities,
      directory
    );
    cleanups.push(
      () => AcpServiceContext.destroySession(sessionId),
      () => harness.close(),
      () => rm(directory, { recursive: true, force: true })
    );

    const result = await bashTool.execute(
      {
        command: commandFor(
          `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`
        ),
        timeout: 10_000,
        env: {},
        run_in_background: false,
      },
      undefined,
      { sessionId, workspaceRoot: directory }
    );

    expect(result.success).toBe(false);
    expect(result.error?.message).toContain('ACP terminal unavailable');
    await expect(realpath(marker)).rejects.toThrow();
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
    const previousPath = process.env.PATH;
    const sessionBin = path.join(workspace, 'session-bin');
    await mkdir(sessionBin);
    await symlink(process.execPath, path.join(sessionBin, 'node'));
    const sessionPath = [sessionBin, '/usr/bin', '/bin'].join(path.delimiter);
    process.env.DEEPSEEK_API_KEY = 'must-not-reach-verifier';
    process.env.PATH = ['/usr/bin', '/bin'].join(path.delimiter);
    const prepare = vi.fn<WorkspaceSandboxBackend['prepare']>(async (input) => ({
      executable: '/bin/bash',
      args: ['-c', input.command],
      env: {
        PATH: '/sandbox-path-without-node',
        TMPDIR: '/sandbox-verifier-tmp',
      },
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
      () => {
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
      },
      () => rm(workspace, { recursive: true, force: true })
    );

    const program = [
      'process.stdout.write(JSON.stringify({',
      'path: process.env.PATH,',
      "secret: process.env.DEEPSEEK_API_KEY ?? 'unset',",
      'gitConfig: process.env.GIT_CONFIG_GLOBAL,',
      'tmpDir: process.env.TMPDIR,',
      '}))',
    ].join('');
    const command = `node -e ${JSON.stringify(program)}`;
    for (const subagentType of ['verification', 'goal-verification', 'review']) {
      const result = await bashTool.execute(
        {
          command,
          timeout: 10_000,
          env: {},
          run_in_background: false,
        },
        undefined,
        {
          environment: { PATH: sessionPath },
          workspaceRoot: canonicalWorkspace,
          subagentType,
        }
      );

      expect(result.success).toBe(true);
      expect(result.metadata?.sandboxed).toBe(true);
      const stdout = (result.llmContent as { stdout: string }).stdout;
      const projected = JSON.parse(stdout) as {
        path: string;
        secret: string;
        gitConfig: string;
        tmpDir: string;
      };
      expect(projected).toMatchObject({
        secret: 'unset',
        gitConfig: '/dev/null',
        tmpDir: '/sandbox-verifier-tmp',
      });
      expect(projected.path.split(path.delimiter)).toContain(sessionBin);
      expect(projected.path).not.toBe('/sandbox-path-without-node');
    }
    process.env.PATH = sessionPath;
    const processPathResult = await bashTool.execute(
      {
        command,
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
    expect(processPathResult.success).toBe(true);
    expect(
      JSON.parse((processPathResult.llmContent as { stdout: string }).stdout)
    ).toMatchObject({
      secret: 'unset',
      gitConfig: '/dev/null',
      tmpDir: '/sandbox-verifier-tmp',
    });
    expect(prepare).toHaveBeenCalledTimes(4);
    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        command,
        cwd: canonicalWorkspace,
        workspaceRoot: canonicalWorkspace,
        access: 'workspace-read-only',
        trustedPath: sessionPath,
      })
    );
  });

  it('removes safe audit output truncation without hiding the command exit code', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'blade-verifier-exit-'));
    const canonicalWorkspace = await realpath(workspace);
    await writeFile(
      path.join(workspace, 'failing.test.js'),
      "const test = require('node:test'); test('fails', () => { throw new Error('expected failure'); });"
    );
    const prepare = vi.fn<WorkspaceSandboxBackend['prepare']>(async (input) => ({
      executable: '/bin/bash',
      args: ['-c', input.command],
      env: { PATH: process.env.PATH },
      sandboxed: true,
      inheritProcessEnv: false,
      cleanup: () => undefined,
    }));
    cleanups.push(installWorkspaceSandboxBackendForTests({ prepare }), () =>
      rm(workspace, { recursive: true, force: true })
    );

    const result = await bashTool.execute(
      {
        command:
          'node --test failing.test.js 2>&1 | tail -20; ' +
          'echo "EXIT:${PIPESTATUS[0]}"',
        timeout: 10_000,
        run_in_background: false,
      },
      undefined,
      { workspaceRoot: canonicalWorkspace, subagentType: 'verification' }
    );

    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'node --test failing.test.js' })
    );
    expect(result.success).toBe(false);
    expect(result.metadata?.exit_code).toBe(1);
  });
});
