import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionMode } from '../../src/config/types.js';
import { bashTool } from '../../src/tools/builtin/shell/bash.js';
import {
  AnthropicWorkspaceSandboxBackend,
  installWorkspaceSandboxBackendForTests,
  isWorkspaceSandboxRuntimeFailure,
  type SandboxedCommand,
  WorkspaceSandboxUnavailableError,
  WorkspaceWriteSandbox,
} from '../../src/tools/builtin/shell/WorkspaceWriteSandbox.js';

vi.unmock('child_process');
vi.unmock('node:child_process');

const cleanups: Array<() => void> = [];
const tempRoots: string[] = [];
const SANDBOX_COMMAND_TIMEOUT_MS = 90_000;

async function makeWorkspace(): Promise<{
  root: string;
  workspaceRoot: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'blade-sandbox-integration-'));
  const workspaceRoot = path.join(root, 'workspace');
  await mkdir(workspaceRoot);
  tempRoots.push(root);
  return { root, workspaceRoot };
}

async function waitForExit(
  child: ReturnType<typeof spawn>
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.once('error', reject);
    child.once('close', (code) => {
      resolvePromise({ code, stdout, stderr });
    });
  });
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    cleanup();
  }
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe('Bash workspace-write sandbox integration', () => {
  it('routes foreground worktree commands through the sandbox backend', async () => {
    const { workspaceRoot } = await makeWorkspace();
    const cleanup = vi.fn();
    const prepare = vi.fn(
      async (): Promise<SandboxedCommand> => ({
        executable: process.execPath,
        args: ['-e', 'process.stdout.write(process.cwd())'],
        env: {},
        sandboxed: true,
        cleanup,
      })
    );
    cleanups.push(installWorkspaceSandboxBackendForTests({ prepare }));

    const result = await bashTool
      .build({
        command: 'this raw command must not execute',
        timeout: SANDBOX_COMMAND_TIMEOUT_MS,
        run_in_background: false,
      })
      .execute(new AbortController().signal, undefined, {
        workspaceRoot,
        worktreeActive: true,
        permissionMode: PermissionMode.YOLO,
      });

    expect(result.success).toBe(true);
    expect((result.llmContent as { stdout: string }).stdout).toBe(
      await realpath(workspaceRoot)
    );
    expect(result.metadata?.sandboxed).toBe(true);
    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'this raw command must not execute',
        workspaceRoot: await realpath(workspaceRoot),
      })
    );
    expect(cleanup).toHaveBeenCalledOnce();
  }, 100_000);

  it('keeps ordinary non-worktree Bash execution compatible', async () => {
    const { workspaceRoot } = await makeWorkspace();
    const prepare = vi.fn(async () => {
      throw new Error('sandbox backend should not be called');
    });
    cleanups.push(installWorkspaceSandboxBackendForTests({ prepare }));

    const result = await bashTool
      .build({
        command: `${process.execPath} -e "process.stdout.write('ordinary-bash')"`,
        timeout: SANDBOX_COMMAND_TIMEOUT_MS,
        run_in_background: false,
      })
      .execute(new AbortController().signal, undefined, {
        workspaceRoot,
        worktreeActive: false,
        permissionMode: PermissionMode.YOLO,
      });

    expect(result.success).toBe(true);
    expect((result.llmContent as { stdout: string }).stdout).toBe('ordinary-bash');
    expect(result.metadata?.sandboxed).toBe(false);
    expect(prepare).not.toHaveBeenCalled();
  }, 100_000);

  it('does not execute the raw command when sandbox preparation fails', async () => {
    const { root, workspaceRoot } = await makeWorkspace();
    const outsidePath = path.join(root, 'escaped.txt');
    cleanups.push(
      installWorkspaceSandboxBackendForTests({
        prepare: vi.fn(async () => {
          throw new WorkspaceSandboxUnavailableError('sandbox unavailable');
        }),
      })
    );

    const result = await bashTool
      .build({
        command: `${process.execPath} -e "require('fs').writeFileSync('${outsidePath}', 'escaped')"`,
        timeout: 30_000,
        run_in_background: false,
      })
      .execute(new AbortController().signal, undefined, {
        workspaceRoot,
        worktreeActive: true,
        permissionMode: PermissionMode.YOLO,
      });

    expect(result.success).toBe(false);
    expect(result.error?.type).toBe('permission_denied');
    await expect(access(outsidePath)).rejects.toThrow();
  });

  it('routes background worktree commands through the same sandbox backend', async () => {
    const { workspaceRoot } = await makeWorkspace();
    const cleanup = vi.fn();
    cleanups.push(
      installWorkspaceSandboxBackendForTests({
        prepare: vi.fn(
          async (): Promise<SandboxedCommand> => ({
            executable: process.execPath,
            args: ['-e', 'process.stdout.write("background-sandboxed")'],
            env: {},
            sandboxed: true,
            cleanup,
          })
        ),
      })
    );

    const started = await bashTool
      .build({
        command: 'this background raw command must not execute',
        timeout: 30_000,
        run_in_background: true,
      })
      .execute(new AbortController().signal, undefined, {
        sessionId: 'workspace-sandbox-background',
        workspaceRoot,
        worktreeActive: true,
        permissionMode: PermissionMode.YOLO,
      });
    const taskId = String(started.metadata?.bash_id);
    const { BackgroundShellManager } = await import(
      '../../src/tools/builtin/shell/BackgroundShellManager.js'
    );
    const manager = BackgroundShellManager.getInstance();

    for (let attempt = 0; attempt < 100; attempt++) {
      if (
        manager.getProcess(taskId, 'workspace-sandbox-background')?.status !== 'running'
      )
        break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    }
    const output = manager.consumeOutput(taskId, 'workspace-sandbox-background');

    expect(started.success).toBe(true);
    expect(started.metadata?.sandboxed).toBe(true);
    expect(output?.status).toBe('exited');
    expect(output?.stdout).toBe('background-sandboxed');
    expect(cleanup).toHaveBeenCalledOnce();
  });
});

describe('native workspace-write sandbox', () => {
  it('enforces writes or fails closed when nested sandboxing is unavailable', async () => {
    const { root, workspaceRoot } = await makeWorkspace();
    const insidePath = path.join(workspaceRoot, 'inside.txt');
    const outsidePath = path.join(root, 'outside.txt');
    const backend = new AnthropicWorkspaceSandboxBackend({
      tempRoot: path.join(root, 'sandbox-temp'),
    });
    const sandbox = new WorkspaceWriteSandbox(backend);

    let command: SandboxedCommand | undefined;
    try {
      command = await sandbox.prepare({
        command:
          `printf inside > "${insidePath}"; ` + `printf outside > "${outsidePath}"`,
        cwd: workspaceRoot,
        workspaceRoot,
      });
    } catch (error) {
      expect(error).toBeInstanceOf(WorkspaceSandboxUnavailableError);
      await expect(access(insidePath)).rejects.toThrow();
      await expect(access(outsidePath)).rejects.toThrow();
      await backend.dispose();
      return;
    }

    const child = spawn(command.executable, command.args, {
      cwd: workspaceRoot,
      env: { ...process.env, ...command.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const result = await waitForExit(child);
    command.cleanup();
    await backend.dispose();

    if (isWorkspaceSandboxRuntimeFailure(result.code, result.stderr)) {
      await expect(access(insidePath)).rejects.toThrow();
      await expect(access(outsidePath)).rejects.toThrow();
      return;
    }

    expect(await readFile(insidePath, 'utf-8')).toBe('inside');
    await expect(access(outsidePath)).rejects.toThrow();
    expect(result.code).not.toBe(0);
  }, 60_000);
});
