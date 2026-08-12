import { spawn } from 'node:child_process';
import os from 'node:os';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { SessionRuntime } from '../../src/agent/runtime/SessionRuntime.js';
import { BackgroundShellManager } from '../../src/tools/builtin/shell/BackgroundShellManager.js';
import { bashTool } from '../../src/tools/builtin/shell/bash.js';
import { killShellTool } from '../../src/tools/builtin/shell/killShell.js';
import { taskOutputTool } from '../../src/tools/builtin/task/taskOutput.js';

const SHELL_EXIT_OBSERVATION_MS = 15_000;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

beforeAll(async () => {
  const childProcess =
    await vi.importActual<typeof import('node:child_process')>('node:child_process');
  vi.mocked(spawn).mockImplementation(childProcess.spawn);
});

function longRunningCommand(output = ''): string {
  const script = `${output ? `process.stdout.write(${JSON.stringify(output)});` : ''} setInterval(() => {}, 1000);`;
  return `${shellQuote(process.execPath)} -e ${shellQuote(script)}`;
}

async function waitForProcessGone(pid: number, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

async function waitForShellExit(
  manager: BackgroundShellManager,
  shellId: string,
  sessionId: string,
  timeoutMs = SHELL_EXIT_OBSERVATION_MS
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = manager.getProcess(shellId, sessionId)?.status;
    if (status && status !== 'running') return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Shell ${shellId} did not exit within ${timeoutMs}ms`);
}

afterEach(async () => {
  await BackgroundShellManager.getInstance().killAll();
});

describe.skipIf(process.platform === 'win32')(
  'background task session isolation',
  () => {
    it('binds background Bash to the calling session', async () => {
      const started = await bashTool
        .build({
          command: longRunningCommand(),
          timeout: 30_000,
          run_in_background: true,
        })
        .execute(new AbortController().signal, undefined, {
          sessionId: 'session-owner',
          workspaceRoot: os.tmpdir(),
        });
      const shellId = String(started.metadata?.shell_id);
      const manager = BackgroundShellManager.getInstance();

      expect(started.success).toBe(true);
      expect(manager.getProcess(shellId, 'session-owner')?.sessionId).toBe(
        'session-owner'
      );
      expect(manager.getProcess(shellId, 'session-other')).toBeUndefined();
    });

    it('denies TaskOutput access from another session', async () => {
      const manager = BackgroundShellManager.getInstance();
      const shell = await manager.startBackgroundProcess({
        command: longRunningCommand('private-output'),
        sessionId: 'session-owner',
        cwd: os.tmpdir(),
      });

      const denied = await taskOutputTool
        .build({ task_id: shell.id, block: false, timeout: 1_000 })
        .execute(new AbortController().signal, undefined, {
          sessionId: 'session-other',
        });

      expect(denied.success).toBe(false);
      expect(denied.llmContent).not.toContain('private-output');
      expect(manager.getProcess(shell.id, 'session-owner')?.status).toBe('running');
    });

    it('denies KillShell from another session while allowing the owner', async () => {
      const manager = BackgroundShellManager.getInstance();
      const shell = await manager.startBackgroundProcess({
        command: longRunningCommand(),
        sessionId: 'session-owner',
        cwd: os.tmpdir(),
      });

      const denied = await killShellTool
        .build({ shell_id: shell.id })
        .execute(new AbortController().signal, undefined, {
          sessionId: 'session-other',
        });
      const killed = await killShellTool
        .build({ shell_id: shell.id })
        .execute(new AbortController().signal, undefined, {
          sessionId: 'session-owner',
        });

      expect(denied.success).toBe(false);
      expect(killed.success).toBe(true);
    });

    it('writes to an owned background shell stdin and closes it explicitly', async () => {
      const manager = BackgroundShellManager.getInstance();
      const script = [
        "process.stdin.setEncoding('utf8')",
        "let input = ''",
        "process.stdin.on('data', (chunk) => { input += chunk })",
        "process.stdin.on('end', () => process.stdout.write(`received:${input}`))",
      ].join(';');
      const shell = await manager.startBackgroundProcess({
        command: `${shellQuote(process.execPath)} -e ${shellQuote(script)}`,
        sessionId: 'session-owner',
        cwd: os.tmpdir(),
      });

      expect(typeof manager.writeInput).toBe('function');
      const written = await manager.writeInput(
        shell.id,
        'session-owner',
        'owned-input\n',
        true
      );
      await waitForShellExit(manager, shell.id, 'session-owner');
      const output = manager.consumeOutput(shell.id, 'session-owner');

      expect(written).toMatchObject({
        success: true,
        bytesWritten: 12,
        stdinClosed: true,
      });
      expect(output?.stdout).toBe('received:owned-input\n');
      expect(output?.status).toBe('exited');
    }, 20_000);

    it('denies stdin writes from another session', async () => {
      const manager = BackgroundShellManager.getInstance();
      const shell = await manager.startBackgroundProcess({
        command: longRunningCommand(),
        sessionId: 'session-owner',
        cwd: os.tmpdir(),
      });

      const denied = await manager.writeInput(
        shell.id,
        'session-other',
        'private-input\n',
        false
      );

      expect(denied).toBeUndefined();
      expect(manager.getProcess(shell.id, 'session-owner')?.status).toBe('running');
    });

    it('bounds unread background output while preserving the latest diagnostics', async () => {
      const manager = BackgroundShellManager.getInstance();
      const outputBytes = 1_100_000;
      const stdoutTail = 'STDOUT_TAIL';
      const stderrTail = 'STDERR_TAIL';
      const script = [
        `process.stdout.write('a'.repeat(${outputBytes}))`,
        `process.stdout.write('${stdoutTail}')`,
        `process.stderr.write('b'.repeat(${outputBytes}))`,
        `process.stderr.write('${stderrTail}')`,
      ].join(';');
      const shell = await manager.startBackgroundProcess({
        command: `${shellQuote(process.execPath)} -e ${shellQuote(script)}`,
        sessionId: 'session-bounded-output',
        cwd: os.tmpdir(),
      });

      await waitForShellExit(manager, shell.id, 'session-bounded-output');
      const output = manager.consumeOutput(shell.id, 'session-bounded-output');

      expect(Buffer.byteLength(output?.stdout ?? '')).toBeLessThanOrEqual(1024 * 1024);
      expect(Buffer.byteLength(output?.stderr ?? '')).toBeLessThanOrEqual(1024 * 1024);
      expect(output?.stdout.endsWith(stdoutTail)).toBe(true);
      expect(output?.stderr.endsWith(stderrTail)).toBe(true);
      expect(output?.stdoutOmittedBytes).toBeGreaterThan(0);
      expect(output?.stderrOmittedBytes).toBeGreaterThan(0);
    }, 20_000);

    it('reclaims only the disposing runtime session shells', async () => {
      const manager = BackgroundShellManager.getInstance();
      const owned = await manager.startBackgroundProcess({
        command: longRunningCommand(),
        sessionId: 'session-disposed',
        cwd: os.tmpdir(),
      });
      const unrelated = await manager.startBackgroundProcess({
        command: longRunningCommand(),
        sessionId: 'session-still-active',
        cwd: os.tmpdir(),
      });
      const runtime = new SessionRuntime({} as never, {
        sessionId: 'session-disposed',
      });

      await runtime.dispose();

      expect(manager.getProcess(owned.id, 'session-disposed')).toBeUndefined();
      expect(await waitForProcessGone(owned.pid as number)).toBe(true);
      expect(manager.getProcess(unrelated.id, 'session-still-active')?.status).toBe(
        'running'
      );
    });
  }
);
