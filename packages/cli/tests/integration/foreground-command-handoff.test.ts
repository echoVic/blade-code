import { spawn } from 'node:child_process';
import { access, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type * as acp from '@agentclientprotocol/sdk';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AcpServiceContext } from '../../src/acp/AcpServiceContext.js';
import { getProjectStoragePath } from '../../src/context/storage/pathUtils.js';
import { BackgroundShellLeaseStore } from '../../src/tools/builtin/shell/BackgroundShellLeaseStore.js';
import { BackgroundShellManager } from '../../src/tools/builtin/shell/BackgroundShellManager.js';
import { bashTool } from '../../src/tools/builtin/shell/bash.js';
import { killShellTool } from '../../src/tools/builtin/shell/killShell.js';
import { writeStdinTool } from '../../src/tools/builtin/shell/writeStdin.js';
import { taskOutputTool } from '../../src/tools/builtin/task/taskOutput.js';
import type { ExecutionContext } from '../../src/tools/types/index.js';
import { ControlledTerminalClient } from '../support/acp/ControlledTerminalClient.js';
import {
  createPairedAcpHarness,
  type PairedAcpHarness,
} from '../support/acp/createPairedAcpHarness.js';

const acpCapabilities: acp.ClientCapabilities = { terminal: true };

type HandoffExecutionContext = Partial<ExecutionContext> & {
  foregroundCommandHandoffMs: number;
};

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function nodeCommand(program: string): string {
  return `${shellQuote(process.execPath)} -e ${shellQuote(program)}`;
}

function longRunningCommand(): string {
  return nodeCommand('setInterval(() => {}, 1000)');
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Condition not met within ${timeoutMs}ms`);
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function processGone(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

beforeAll(async () => {
  const childProcess =
    await vi.importActual<typeof import('node:child_process')>('node:child_process');
  vi.mocked(spawn).mockImplementation(childProcess.spawn);
});

describe.skipIf(process.platform === 'win32')(
  'bounded foreground command handoff',
  () => {
    const tempRoots: string[] = [];
    const acpHarnesses: PairedAcpHarness[] = [];
    const acpSessions = new Set<string>();

    afterEach(async () => {
      await BackgroundShellManager.getInstance().killAll();
      for (const sessionId of acpSessions) {
        await AcpServiceContext.destroySession(sessionId);
      }
      acpSessions.clear();
      await Promise.all(acpHarnesses.splice(0).map((harness) => harness.close()));
      await Promise.all(
        tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
      );
    });

    it('hands one local PID to TaskOutput and preserves output across the boundary', async () => {
      const workspace = await mkdtemp(
        path.join(os.tmpdir(), 'blade-foreground-handoff-')
      );
      tempRoots.push(workspace);
      const started = path.join(workspace, 'started');
      const release = path.join(workspace, 'release');
      const launches = path.join(workspace, 'launches');
      const script = [
        `require('node:fs').appendFileSync(${JSON.stringify(launches)}, 'launch\\n')`,
        `require('node:fs').writeFileSync(${JSON.stringify(started)}, 'started')`,
        "process.stdout.write('before-handoff\\n')",
        `const timer = setInterval(() => { if (require('node:fs').existsSync(${JSON.stringify(
          release
        )})) { clearInterval(timer); process.stdout.write('after-handoff\\n'); } }, 10)`,
      ].join(';');
      const controller = new AbortController();
      const sessionId = `handoff-local-${Date.now()}`;

      const result = await bashTool.execute(
        {
          command: nodeCommand(script),
          timeout: 10_000,
          env: {},
          run_in_background: false,
        },
        controller.signal,
        {
          sessionId,
          workspaceRoot: workspace,
          foregroundCommandHandoffMs: 1_000,
        } as HandoffExecutionContext
      );

      expect(await exists(started)).toBe(true);
      expect(result).toMatchObject({
        success: true,
        llmContent: {
          background: true,
          auto_backgrounded: true,
          background_reason: 'foreground_budget',
          foreground_budget_ms: 1_000,
          terminal_transport: 'local',
        },
        metadata: {
          background: true,
          auto_backgrounded: true,
          background_reason: 'foreground_budget',
          foreground_budget_ms: 1_000,
          terminal_transport: 'local',
        },
      });
      const shellId = String(result.metadata?.shell_id);
      const pid = Number(result.metadata?.pid);
      const manager = BackgroundShellManager.getInstance();
      expect(manager.getProcess(shellId, sessionId)).toMatchObject({
        id: shellId,
        pid,
        status: 'running',
      });
      expect(() => process.kill(pid, 0)).not.toThrow();
      const storageRoot = getProjectStoragePath(workspace);
      const foregroundLeases = await readdir(
        path.join(storageRoot, '.foreground-processes'),
        { recursive: true }
      );
      const backgroundLeases = await readdir(
        path.join(storageRoot, '.background-shells'),
        { recursive: true }
      );
      expect(foregroundLeases.some((name) => name.endsWith('.json'))).toBe(false);
      expect(backgroundLeases.filter((name) => name.endsWith('.json'))).toHaveLength(1);

      controller.abort('turn-finished-after-handoff');
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(manager.getProcess(shellId, sessionId)?.status).toBe('running');
      expect(() => process.kill(pid, 0)).not.toThrow();

      await writeFile(release, 'release');
      const output = await taskOutputTool.execute(
        { task_id: shellId, block: true, timeout: 5_000 },
        undefined,
        { sessionId }
      );

      expect(output).toMatchObject({
        success: true,
        llmContent: {
          task_id: shellId,
          status: 'exited',
          stdout: expect.stringContaining('before-handoff'),
        },
      });
      expect(JSON.stringify(output.llmContent)).toContain('after-handoff');
      expect((await readFile(launches, 'utf8')).trim().split('\n')).toEqual(['launch']);
      const finalBackgroundLeases = await readdir(
        path.join(storageRoot, '.background-shells'),
        { recursive: true }
      );
      expect(finalBackgroundLeases.some((name) => name.endsWith('.json'))).toBe(false);
    });

    it('keeps standalone sleep foreground and lets an earlier timeout win', async () => {
      const sleepResult = await bashTool.execute(
        {
          command: 'sleep 0.2',
          timeout: 2_000,
          env: {},
          run_in_background: false,
        },
        undefined,
        {
          sessionId: `handoff-sleep-${Date.now()}`,
          workspaceRoot: os.tmpdir(),
          foregroundCommandHandoffMs: 1_000,
        } as HandoffExecutionContext
      );

      expect(sleepResult.success).toBe(true);
      expect(sleepResult.metadata?.auto_backgrounded).not.toBe(true);

      const timeoutResult = await bashTool.execute(
        {
          command: longRunningCommand(),
          timeout: 1_000,
          env: {},
          run_in_background: false,
        },
        undefined,
        {
          sessionId: `handoff-timeout-${Date.now()}`,
          workspaceRoot: os.tmpdir(),
          foregroundCommandHandoffMs: 1_500,
        } as HandoffExecutionContext
      );

      expect(timeoutResult).toMatchObject({
        success: false,
        error: { type: 'timeout_error' },
        metadata: { timeout: true },
      });
    });

    it('preserves exact foreground accounting when a large command beats the budget', async () => {
      const tail = 'FAST_FOREGROUND_TAIL';
      const result = await bashTool.execute(
        {
          command: nodeCommand(
            `process.stdout.write('x'.repeat(${1024 * 1024 + 4096}) + ${JSON.stringify(
              tail
            )})`
          ),
          timeout: 10_000,
          env: {},
          run_in_background: false,
        },
        undefined,
        {
          sessionId: `handoff-fast-output-${Date.now()}`,
          workspaceRoot: os.tmpdir(),
          foregroundCommandHandoffMs: 5_000,
        } as HandoffExecutionContext
      );

      expect(result).toMatchObject({
        success: true,
        llmContent: {
          stdout: expect.stringContaining(tail),
          output_truncated: true,
          output_accounting_complete: true,
        },
        metadata: {
          capture_truncated: true,
          output_accounting_complete: true,
          terminal_transport: 'local',
        },
      });
      expect(result.metadata?.auto_backgrounded).not.toBe(true);
      expect(result.metadata?.stdout_omitted_bytes).toBeGreaterThan(0);
      expect(result.metadata?.stdout_total_bytes).toBeGreaterThan(1024 * 1024);
    });

    it('continues the same foreground process when background lease commit fails', async () => {
      const workspace = await mkdtemp(
        path.join(os.tmpdir(), 'blade-handoff-lease-failure-')
      );
      tempRoots.push(workspace);
      const launches = path.join(workspace, 'launches');
      const register = vi
        .spyOn(BackgroundShellLeaseStore.prototype, 'register')
        .mockImplementationOnce(() => {
          throw new Error('injected background lease failure');
        });

      try {
        const result = await bashTool.execute(
          {
            command: nodeCommand(
              `require('node:fs').appendFileSync(${JSON.stringify(
                launches
              )}, 'launch\\n'); setTimeout(() => process.stdout.write('completed'), 1200)`
            ),
            timeout: 3_000,
            env: {},
            run_in_background: false,
          },
          undefined,
          {
            sessionId: `handoff-lease-failure-${Date.now()}`,
            workspaceRoot: workspace,
            foregroundCommandHandoffMs: 1_000,
          } as HandoffExecutionContext
        );

        expect(result).toMatchObject({
          success: true,
          llmContent: { stdout: 'completed', exit_code: 0 },
        });
        expect(result.metadata?.auto_backgrounded).not.toBe(true);
        expect((await readFile(launches, 'utf8')).trim().split('\n')).toEqual([
          'launch',
        ]);
      } finally {
        register.mockRestore();
      }
    });

    it('aborts a hidden candidate before handoff and releases its capacity', async () => {
      const workspace = await mkdtemp(
        path.join(os.tmpdir(), 'blade-handoff-pre-abort-')
      );
      tempRoots.push(workspace);
      const pidFile = path.join(workspace, 'pid');
      const sessionId = `handoff-pre-abort-${Date.now()}`;
      const controller = new AbortController();
      const resultPromise = bashTool.execute(
        {
          command: nodeCommand(
            `require('node:fs').writeFileSync(${JSON.stringify(
              pidFile
            )}, String(process.pid)); setInterval(() => {}, 1000)`
          ),
          timeout: 10_000,
          env: {},
          run_in_background: false,
        },
        controller.signal,
        {
          sessionId,
          workspaceRoot: workspace,
          foregroundCommandHandoffMs: 1_000,
        } as HandoffExecutionContext
      );

      await waitFor(() => exists(pidFile));
      const pid = Number.parseInt(await readFile(pidFile, 'utf8'), 10);
      controller.abort('pre-handoff-abort');
      const result = await resultPromise;

      expect(result).toMatchObject({
        success: false,
        metadata: { aborted: true },
      });
      expect(BackgroundShellManager.getInstance().listForSession(sessionId)).toEqual(
        []
      );
      expect(BackgroundShellManager.getInstance().getAdmissionStats().active).toBe(0);
      await waitFor(() => processGone(pid));
    });

    it('rejects the fifth active Session background shell before user code starts', async () => {
      const workspace = await mkdtemp(
        path.join(os.tmpdir(), 'blade-background-capacity-')
      );
      tempRoots.push(workspace);
      const marker = path.join(workspace, 'must-not-run');
      const sessionId = `background-cap-${Date.now()}`;
      const started = await Promise.all(
        Array.from({ length: 4 }, () =>
          bashTool.execute(
            {
              command: longRunningCommand(),
              timeout: 10_000,
              env: {},
              run_in_background: true,
            },
            undefined,
            { sessionId, workspaceRoot: workspace }
          )
        )
      );

      expect(started.every((result) => result.success)).toBe(true);
      const rejected = await bashTool.execute(
        {
          command: nodeCommand(
            `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`
          ),
          timeout: 10_000,
          env: {},
          run_in_background: true,
        },
        undefined,
        { sessionId, workspaceRoot: workspace }
      );

      expect(rejected).toMatchObject({
        success: false,
        error: {
          type: 'resource_exhausted',
          code: 'background_shell_busy',
        },
        metadata: {
          background_shell_admission: {
            code: 'background_shell_busy',
            scope: 'session',
            limit: 4,
            retryable: true,
          },
        },
      });
      expect(await exists(marker)).toBe(false);

      const launches = path.join(workspace, 'foreground-launches');
      const foreground = await bashTool.execute(
        {
          command: nodeCommand(
            `require('node:fs').appendFileSync(${JSON.stringify(
              launches
            )}, 'launch\\n'); setInterval(() => {}, 1000)`
          ),
          timeout: 1_200,
          env: {},
          run_in_background: false,
        },
        undefined,
        {
          sessionId,
          workspaceRoot: workspace,
          foregroundCommandHandoffMs: 1_000,
        } as HandoffExecutionContext
      );

      expect(foreground).toMatchObject({
        success: false,
        error: { type: 'timeout_error' },
      });
      expect((await readFile(launches, 'utf8')).trim().split('\n')).toEqual(['launch']);
    });

    it('hands off a real ACP terminal without releasing or locally relaunching it', async () => {
      const sessionId = `handoff-acp-${Date.now()}`;
      const client = new ControlledTerminalClient();
      const harness = createPairedAcpHarness(client);
      acpHarnesses.push(harness);
      acpSessions.add(sessionId);
      client.enqueueOutput({ output: 'before-acp', truncated: false });
      client.enqueueOutput({ output: 'before-acp-after-acp', truncated: false });
      AcpServiceContext.initializeSession(
        harness.agentConnection,
        sessionId,
        acpCapabilities,
        '/workspace/acp-handoff'
      );
      const controller = new AbortController();

      const result = await bashTool.execute(
        {
          command: 'node child.js',
          timeout: 10_000,
          cwd: '/workspace/acp-handoff',
          env: {},
          run_in_background: false,
        },
        controller.signal,
        {
          sessionId,
          workspaceRoot: '/workspace/acp-handoff',
          foregroundCommandHandoffMs: 1_000,
        } as HandoffExecutionContext
      );

      expect(result).toMatchObject({
        success: true,
        metadata: {
          auto_backgrounded: true,
          terminal_transport: 'acp',
          foreground_budget_ms: 1_000,
        },
      });
      expect(client.createRequests).toHaveLength(1);
      expect(client.killRequests).toHaveLength(0);
      expect(client.releaseRequests).toHaveLength(0);
      const shellId = String(result.metadata?.shell_id);
      expect(
        BackgroundShellManager.getInstance().getProcess(shellId, sessionId)
      ).toMatchObject({
        transport: 'acp',
        status: 'running',
      });

      controller.abort('turn-finished-after-acp-handoff');
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(client.killRequests).toHaveLength(0);
      expect(client.releaseRequests).toHaveLength(0);

      client.resolveWait({ exitCode: 0 });
      await waitFor(
        () =>
          BackgroundShellManager.getInstance().getProcess(shellId, sessionId)
            ?.status === 'exited'
      );
      const output = await taskOutputTool.execute(
        { task_id: shellId, block: false, timeout: 1_000 },
        undefined,
        { sessionId }
      );

      expect(output).toMatchObject({
        success: true,
        llmContent: {
          status: 'exited',
          stdout: expect.stringContaining('before-acp'),
        },
      });
      expect(JSON.stringify(output.llmContent)).toContain('after-acp');
      expect(client.killRequests).toHaveLength(0);
      expect(client.releaseRequests).toHaveLength(1);
    });

    it('routes ACP handoff KillShell to the terminal and rejects unsupported stdin', async () => {
      const sessionId = `handoff-acp-kill-${Date.now()}`;
      const client = new ControlledTerminalClient();
      const harness = createPairedAcpHarness(client);
      acpHarnesses.push(harness);
      acpSessions.add(sessionId);
      client.enqueueOutput({ output: 'running', truncated: false });
      client.enqueueOutput({ output: 'stopped', truncated: false });
      AcpServiceContext.initializeSession(
        harness.agentConnection,
        sessionId,
        acpCapabilities,
        '/workspace/acp-kill'
      );

      const result = await bashTool.execute(
        {
          command: 'node child.js',
          timeout: 10_000,
          cwd: '/workspace/acp-kill',
          env: {},
          run_in_background: false,
        },
        undefined,
        {
          sessionId,
          workspaceRoot: '/workspace/acp-kill',
          foregroundCommandHandoffMs: 1_000,
        } as HandoffExecutionContext
      );
      const shellId = String(result.metadata?.shell_id);

      const write = await writeStdinTool.execute(
        { shell_id: shellId, data: 'input\n', close_stdin: false },
        undefined,
        { sessionId }
      );
      expect(write).toMatchObject({
        success: false,
        error: {
          message: 'ACP background terminals do not support stdin writes',
        },
      });

      const killed = await killShellTool.execute({ shell_id: shellId }, undefined, {
        sessionId,
      });
      expect(killed).toMatchObject({
        success: true,
        llmContent: { shell_id: shellId, status: 'killed' },
      });
      expect(client.killRequests).toHaveLength(1);
      expect(client.releaseRequests).toHaveLength(1);
      expect(
        BackgroundShellManager.getInstance().getProcess(shellId, sessionId)?.status
      ).toBe('killed');
    });
  }
);
