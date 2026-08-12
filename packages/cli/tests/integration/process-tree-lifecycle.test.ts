import { spawn } from 'node:child_process';
import { access, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getTerminalService } from '../../src/acp/AcpServiceContext.js';
import { PermissionMode } from '../../src/config/types.js';
import { getProjectStoragePath } from '../../src/context/storage/pathUtils.js';
import { SecureProcessExecutor } from '../../src/hooks/SecureProcessExecutor.js';
import { HookEvent } from '../../src/hooks/types/HookTypes.js';
import { BackgroundShellLeaseStore } from '../../src/tools/builtin/shell/BackgroundShellLeaseStore.js';
import { BackgroundShellManager } from '../../src/tools/builtin/shell/BackgroundShellManager.js';
import { bashTool } from '../../src/tools/builtin/shell/bash.js';

const tempRoots: string[] = [];
const descendantPids = new Set<number>();
const FIXTURE_COMMAND_TIMEOUT_MS = 3_000;
const originalStorageRoot = process.env.BLADE_STORAGE_ROOT;
let suiteStorageRoot: string;

beforeAll(async () => {
  suiteStorageRoot = await mkdtemp(
    path.join(os.tmpdir(), 'blade-process-tree-storage-')
  );
  process.env.BLADE_STORAGE_ROOT = suiteStorageRoot;
  const childProcess =
    await vi.importActual<typeof import('node:child_process')>('node:child_process');
  vi.mocked(spawn).mockImplementation(childProcess.spawn);
});

afterAll(async () => {
  if (originalStorageRoot === undefined) delete process.env.BLADE_STORAGE_ROOT;
  else process.env.BLADE_STORAGE_ROOT = originalStorageRoot;
  await rm(suiteStorageRoot, { recursive: true, force: true });
});

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = 5_000
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return predicate();
}

async function launchOrphanBackgroundShell(
  workspace: string,
  sessionId: string
): Promise<number> {
  const fixture = path.join(
    import.meta.dirname,
    '..',
    'fixtures',
    'launch-orphan-background-shell.ts'
  );
  const launcher = spawn(
    process.env.BUN_EXEC_PATH ?? 'bun',
    [fixture, workspace, sessionId],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  const launched = await new Promise<{ pid: number }>((resolve, reject) => {
    let stderr = '';
    launcher.once('error', reject);
    launcher.stderr.setEncoding('utf8');
    launcher.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    launcher.once('close', (code) => {
      reject(new Error(`Orphan shell launcher exited ${code}: ${stderr}`));
    });
    launcher.stdout.setEncoding('utf8');
    launcher.stdout.once('data', (chunk: string) => {
      resolve(JSON.parse(chunk.trim()) as { pid: number });
    });
  });
  const closed = new Promise<void>((resolve) =>
    launcher.once('close', () => resolve())
  );
  if (!launcher.kill('SIGKILL')) {
    throw new Error('Failed to hard-exit background shell owner');
  }
  await closed;
  return launched.pid;
}

async function processIsGone(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

async function createProcessTreeFixture(label: string): Promise<{
  command: string;
  cleanupMarker: string;
  descendantPidFile: string;
  readDescendantPid: () => Promise<number>;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), `blade-process-tree-${label}-`));
  tempRoots.push(root);
  const script = path.join(root, 'parent.mjs');
  const cleanupMarker = path.join(root, 'cleanup.marker');
  const descendantPidFile = path.join(root, 'descendant.pid');

  await writeFile(
    script,
    [
      "import { spawn } from 'node:child_process';",
      "import { writeFileSync } from 'node:fs';",
      'const [pidFile, cleanupFile] = process.argv.slice(2);',
      'const descendant = spawn(process.execPath, [',
      "  '-e',",
      '  "process.on(\'SIGTERM\', () => {}); setInterval(() => {}, 1000);",',
      "], { stdio: 'ignore' });",
      'writeFileSync(pidFile, String(descendant.pid));',
      "process.on('SIGTERM', () => {",
      "  writeFileSync(cleanupFile, 'cleaned');",
      '  process.exit(0);',
      '});',
      'setInterval(() => {}, 1000);',
      '',
    ].join('\n')
  );

  const readDescendantPid = async () => {
    const ready = await waitFor(async () => {
      try {
        await access(descendantPidFile);
        return true;
      } catch {
        return false;
      }
    });
    expect(ready).toBe(true);
    const pid = Number.parseInt(await readFile(descendantPidFile, 'utf8'), 10);
    descendantPids.add(pid);
    return pid;
  };

  return {
    command: [
      shellQuote(process.execPath),
      shellQuote(script),
      shellQuote(descendantPidFile),
      shellQuote(cleanupMarker),
    ].join(' '),
    cleanupMarker,
    descendantPidFile,
    readDescendantPid,
  };
}

async function expectTreeTerminated(
  cleanupMarker: string,
  descendantPid: number
): Promise<void> {
  expect(await readFile(cleanupMarker, 'utf8')).toBe('cleaned');
  expect(await waitFor(() => processIsGone(descendantPid))).toBe(true);
  descendantPids.delete(descendantPid);
}

afterEach(async () => {
  await BackgroundShellManager.getInstance().killAll();
  for (const pid of descendantPids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // The regression passed and the process is already gone.
    }
  }
  descendantPids.clear();
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe.skipIf(process.platform === 'win32')('owned process-tree lifecycle', () => {
  it('does not admit a background command before its lease commits', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'blade-shell-gate-'));
    tempRoots.push(workspace);
    const marker = path.join(workspace, 'must-not-run');
    const register = vi
      .spyOn(BackgroundShellLeaseStore.prototype, 'register')
      .mockImplementationOnce(() => {
        throw new Error('injected lease commit failure');
      });

    try {
      await expect(
        BackgroundShellManager.getInstance().startBackgroundProcess({
          command: `printf admitted > ${shellQuote(marker)}`,
          sessionId: `shell-gate-${Date.now()}`,
          projectPath: workspace,
          cwd: workspace,
        })
      ).rejects.toThrow('injected lease commit failure');
      await new Promise((resolve) => setTimeout(resolve, 100));
      await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      register.mockRestore();
    }
  });

  it('reaps a durable background shell after its owner hard-exits', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'blade-orphan-shell-'));
    tempRoots.push(workspace);
    const sessionId = `orphan-shell-${Date.now()}`;
    const rootPid = await launchOrphanBackgroundShell(workspace, sessionId);
    descendantPids.add(rootPid);

    const result = await BackgroundShellManager.getInstance().reapOrphanedSession(
      sessionId,
      workspace
    );

    expect(result).toMatchObject({ reaped: 1, protected: 0 });
    expect(await waitFor(() => processIsGone(rootPid))).toBe(true);
    descendantPids.delete(rootPid);
  });

  it('protects a reused PID when the durable identity does not match', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'blade-reused-shell-'));
    tempRoots.push(workspace);
    const sessionId = `reused-shell-${Date.now()}`;
    const rootPid = await launchOrphanBackgroundShell(workspace, sessionId);
    descendantPids.add(rootPid);

    try {
      const leaseRoot = path.join(
        getProjectStoragePath(workspace),
        '.background-shells'
      );
      const leaseNames = await readdir(leaseRoot, { recursive: true });
      const leaseName = leaseNames.find((name) => name.endsWith('.json'));
      expect(leaseName).toBeDefined();
      const leasePath = path.join(leaseRoot, leaseName!);
      const lease = JSON.parse(await readFile(leasePath, 'utf8')) as {
        identity: { fingerprint: string };
      };
      lease.identity.fingerprint = '0'.repeat(64);
      await writeFile(leasePath, `${JSON.stringify(lease)}\n`, { mode: 0o600 });

      const result = await BackgroundShellManager.getInstance().reapOrphanedSession(
        sessionId,
        workspace
      );

      expect(result).toMatchObject({ reaped: 0, protected: 1 });
      expect(() => process.kill(rootPid, 0)).not.toThrow();
    } finally {
      try {
        process.kill(-rootPid, 'SIGKILL');
      } catch {
        // The process group has already exited.
      }
      await waitFor(() => processIsGone(rootPid));
      descendantPids.delete(rootPid);
    }
  });

  it('fails closed when a durable shell lease is malformed', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'blade-corrupt-shell-'));
    tempRoots.push(workspace);
    const sessionId = `corrupt-shell-${Date.now()}`;
    const rootPid = await launchOrphanBackgroundShell(workspace, sessionId);
    descendantPids.add(rootPid);

    try {
      const leaseRoot = path.join(
        getProjectStoragePath(workspace),
        '.background-shells'
      );
      const leaseNames = await readdir(leaseRoot, { recursive: true });
      const leaseName = leaseNames.find((name) => name.endsWith('.json'));
      expect(leaseName).toBeDefined();
      await writeFile(path.join(leaseRoot, leaseName!), '{}\n', { mode: 0o600 });

      await expect(
        BackgroundShellManager.getInstance().reapOrphanedSession(sessionId, workspace)
      ).rejects.toThrow('Invalid durable background shell lease');
      expect(() => process.kill(rootPid, 0)).not.toThrow();
    } finally {
      try {
        process.kill(-rootPid, 'SIGKILL');
      } catch {
        // The process group has already exited.
      }
      await waitFor(() => processIsGone(rootPid));
      descendantPids.delete(rootPid);
    }
  });

  it('kills a TERM-ignoring grandchild after a foreground Bash timeout', async () => {
    const fixture = await createProcessTreeFixture('foreground');

    const result = await bashTool.execute({
      command: fixture.command,
      timeout: FIXTURE_COMMAND_TIMEOUT_MS,
      env: {},
      run_in_background: false,
    });
    const descendantPid = await fixture.readDescendantPid();

    expect(result.success).toBe(false);
    expect(result.error?.type).toBe('timeout_error');
    await expectTreeTerminated(fixture.cleanupMarker, descendantPid);
  }, 20_000);

  it('does not wait for timeout when foreground Bash is already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const startedAt = Date.now();

    const result = await bashTool.execute(
      {
        command: `${shellQuote(process.execPath)} -e ${shellQuote(
          'setInterval(() => {}, 1000)'
        )}`,
        timeout: 2_000,
        env: {},
        run_in_background: false,
      },
      controller.signal,
      { workspaceRoot: os.tmpdir() }
    );

    expect(result.success).toBe(false);
    expect(result.error?.type).toBe('execution_error');
    expect(Date.now() - startedAt).toBeLessThan(1_500);
  }, 5_000);

  it('kills the full tree for a managed background shell', async () => {
    const fixture = await createProcessTreeFixture('background');
    const manager = BackgroundShellManager.getInstance();
    const shell = await manager.startBackgroundProcess({
      command: fixture.command,
      sessionId: 'process-tree-test',
    });
    const descendantPid = await fixture.readDescendantPid();

    const result = await manager.kill(shell.id, 'process-tree-test');

    expect(result).toMatchObject({ success: true, alreadyExited: false });
    await expectTreeTerminated(fixture.cleanupMarker, descendantPid);
  }, 15_000);

  it('kills the full tree when the ACP local terminal fallback times out', async () => {
    const fixture = await createProcessTreeFixture('acp-fallback');

    const result = await getTerminalService().execute(fixture.command, {
      timeout: FIXTURE_COMMAND_TIMEOUT_MS,
    });
    const descendantPid = await fixture.readDescendantPid();

    expect(result).toMatchObject({ success: false, error: 'Command was terminated' });
    await expectTreeTerminated(fixture.cleanupMarker, descendantPid);
  }, 20_000);

  it('kills the full tree when a command hook times out', async () => {
    const fixture = await createProcessTreeFixture('hook');
    const executor = new SecureProcessExecutor();

    const result = await executor.execute(
      fixture.command,
      {
        hook_event_name: HookEvent.SessionStart,
        hook_execution_id: 'process-tree-hook',
        timestamp: new Date().toISOString(),
        project_dir: path.dirname(fixture.descendantPidFile),
        session_id: 'process-tree-test',
        permission_mode: PermissionMode.DEFAULT,
        is_resume: false,
      },
      {
        projectDir: path.dirname(fixture.descendantPidFile),
        sessionId: 'process-tree-test',
        permissionMode: PermissionMode.DEFAULT,
        config: {},
      },
      FIXTURE_COMMAND_TIMEOUT_MS
    );
    const descendantPid = await fixture.readDescendantPid();

    expect(result).toMatchObject({ exitCode: 124, timedOut: true });
    await expectTreeTerminated(fixture.cleanupMarker, descendantPid);
  }, 20_000);

  it('waits for the full command-hook tree to exit after cancellation', async () => {
    const fixture = await createProcessTreeFixture('hook-abort');
    const controller = new AbortController();
    const executor = new SecureProcessExecutor();
    const execution = executor.execute(
      fixture.command,
      {
        hook_event_name: HookEvent.SessionStart,
        hook_execution_id: 'process-tree-hook-abort',
        timestamp: new Date().toISOString(),
        project_dir: path.dirname(fixture.descendantPidFile),
        session_id: 'process-tree-test',
        permission_mode: PermissionMode.DEFAULT,
        is_resume: false,
      },
      {
        projectDir: path.dirname(fixture.descendantPidFile),
        sessionId: 'process-tree-test',
        permissionMode: PermissionMode.DEFAULT,
        config: {},
        abortSignal: controller.signal,
      },
      10_000
    );
    const descendantPid = await fixture.readDescendantPid();

    controller.abort();
    const result = await execution;

    expect(result).toMatchObject({ exitCode: 1, timedOut: false });
    expect(result.stderr).toBe('Hook cancelled by abort signal');
    await expectTreeTerminated(fixture.cleanupMarker, descendantPid);
  }, 15_000);
});
