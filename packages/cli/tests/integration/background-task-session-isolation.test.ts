import { spawn } from 'node:child_process';
import os from 'node:os';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { SessionRuntime } from '../../src/agent/runtime/SessionRuntime.js';
import { bashTool } from '../../src/tools/builtin/shell/bash.js';
import { BackgroundShellManager } from '../../src/tools/builtin/shell/BackgroundShellManager.js';
import { killShellTool } from '../../src/tools/builtin/shell/killShell.js';
import { taskOutputTool } from '../../src/tools/builtin/task/taskOutput.js';

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
      const shell = manager.startBackgroundProcess({
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
      const shell = manager.startBackgroundProcess({
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

    it('reclaims only the disposing runtime session shells', async () => {
      const manager = BackgroundShellManager.getInstance();
      const owned = manager.startBackgroundProcess({
        command: longRunningCommand(),
        sessionId: 'session-disposed',
        cwd: os.tmpdir(),
      });
      const unrelated = manager.startBackgroundProcess({
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
