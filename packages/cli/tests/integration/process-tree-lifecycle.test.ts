import { type ChildProcess, spawn } from 'node:child_process';
import { access, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getTerminalService } from '../../src/acp/AcpServiceContext.js';
import { PermissionMode } from '../../src/config/types.js';
import { ForegroundProcessLeaseStore } from '../../src/context/storage/ForegroundProcessLeaseStore.js';
import { getProjectStoragePath } from '../../src/context/storage/pathUtils.js';
import { SecureProcessExecutor } from '../../src/hooks/SecureProcessExecutor.js';
import { HookEvent } from '../../src/hooks/types/HookTypes.js';
import { BackgroundShellLeaseStore } from '../../src/tools/builtin/shell/BackgroundShellLeaseStore.js';
import { BackgroundShellManager } from '../../src/tools/builtin/shell/BackgroundShellManager.js';
import { bashTool } from '../../src/tools/builtin/shell/bash.js';
import * as CommandAdmissionGate from '../../src/utils/process/CommandAdmissionGate.js';

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

async function startBackgroundShellOwner(
  workspace: string,
  sessionId: string
): Promise<{
  launcher: ChildProcess;
  closed: Promise<void>;
  rootPid: number;
}> {
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
  return { launcher, closed, rootPid: launched.pid };
}

async function launchOrphanBackgroundShell(
  workspace: string,
  sessionId: string
): Promise<number> {
  const owner = await startBackgroundShellOwner(workspace, sessionId);
  if (!owner.launcher.kill('SIGKILL')) {
    throw new Error('Failed to hard-exit background shell owner');
  }
  await owner.closed;
  return owner.rootPid;
}

async function startForegroundFixtureOwner(
  workspace: string,
  sessionId: string,
  fixtureName: string
): Promise<{
  launcher: ChildProcess;
  closed: Promise<void>;
  commandPid: number;
}> {
  const fixture = path.join(import.meta.dirname, '..', 'fixtures', fixtureName);
  const launcher = spawn(
    process.env.BUN_EXEC_PATH ?? 'bun',
    [fixture, workspace, sessionId],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  const launched = await new Promise<{ commandPid: number }>((resolve, reject) => {
    let stderr = '';
    launcher.once('error', reject);
    launcher.stderr.setEncoding('utf8');
    launcher.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    launcher.once('close', (code) => {
      reject(new Error(`Foreground shell launcher exited ${code}: ${stderr}`));
    });
    launcher.stdout.setEncoding('utf8');
    launcher.stdout.once('data', (chunk: string) => {
      resolve(JSON.parse(chunk.trim()) as { commandPid: number });
    });
  });
  const closed = new Promise<void>((resolve) =>
    launcher.once('close', () => resolve())
  );
  return { launcher, closed, commandPid: launched.commandPid };
}

function startForegroundShellOwner(
  workspace: string,
  sessionId: string
): Promise<{
  launcher: ChildProcess;
  closed: Promise<void>;
  commandPid: number;
}> {
  return startForegroundFixtureOwner(
    workspace,
    sessionId,
    'launch-orphan-foreground-shell.ts'
  );
}

function startLeaderlessShellOwner(
  workspace: string,
  sessionId: string
): Promise<{
  launcher: ChildProcess;
  closed: Promise<void>;
  commandPid: number;
}> {
  return startForegroundFixtureOwner(
    workspace,
    sessionId,
    'launch-orphan-leaderless-shell.ts'
  );
}

async function readForegroundLease(workspace: string): Promise<{
  filePath: string;
  contents: string;
  value: {
    ownerIdentity: { fingerprint: string };
    rootPid: number;
    identity: { fingerprint: string };
  };
}> {
  const leaseRoot = path.join(
    getProjectStoragePath(workspace),
    '.foreground-processes'
  );
  const leaseNames = await readdir(leaseRoot, { recursive: true });
  const leaseName = leaseNames.find((name) => name.endsWith('.json'));
  if (!leaseName) throw new Error('Foreground process lease was not committed');
  const filePath = path.join(leaseRoot, leaseName);
  const contents = await readFile(filePath, 'utf8');
  return {
    filePath,
    contents,
    value: JSON.parse(contents) as {
      ownerIdentity: { fingerprint: string };
      rootPid: number;
      identity: { fingerprint: string };
    },
  };
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
    const owner = await startBackgroundShellOwner(workspace, sessionId);
    const rootPid = owner.rootPid;
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
        ownerIdentity: { fingerprint: string };
        identity: { fingerprint: string };
      };
      lease.ownerIdentity.fingerprint = '1'.repeat(64);
      lease.identity.fingerprint = '0'.repeat(64);
      await writeFile(leasePath, `${JSON.stringify(lease)}\n`, { mode: 0o600 });

      const result = await BackgroundShellManager.getInstance().reapOrphanedSession(
        sessionId,
        workspace
      );

      expect(result).toMatchObject({ reaped: 0, protected: 1 });
      expect(() => process.kill(rootPid, 0)).not.toThrow();
    } finally {
      owner.launcher.kill('SIGKILL');
      await owner.closed;
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
    const owner = await startBackgroundShellOwner(workspace, sessionId);
    const rootPid = owner.rootPid;
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
      owner.launcher.kill('SIGKILL');
      await owner.closed;
      try {
        process.kill(-rootPid, 'SIGKILL');
      } catch {
        // The process group has already exited.
      }
      await waitFor(() => processIsGone(rootPid));
      descendantPids.delete(rootPid);
    }
  });

  it('does not admit a foreground command before its lease commits', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'blade-foreground-gate-'));
    tempRoots.push(workspace);
    const marker = path.join(workspace, 'must-not-run');
    const register = vi
      .spyOn(ForegroundProcessLeaseStore.prototype, 'register')
      .mockImplementationOnce(() => {
        throw new Error('injected foreground lease failure');
      });

    try {
      const result = await bashTool.execute(
        {
          command: `printf admitted > ${shellQuote(marker)}`,
          timeout: 2_000,
          env: {},
          run_in_background: false,
        },
        new AbortController().signal,
        {
          sessionId: `foreground-gate-${Date.now()}`,
          workspaceRoot: workspace,
        }
      );

      expect(result.success).toBe(false);
      expect(result.metadata).toBeUndefined();
      await new Promise((resolve) => setTimeout(resolve, 100));
      await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      register.mockRestore();
    }
  });

  it('waits for cleanup when the foreground gate cannot be released', async () => {
    const workspace = await mkdtemp(
      path.join(os.tmpdir(), 'blade-foreground-release-')
    );
    tempRoots.push(workspace);
    const prefix = 'ADMISSION_PREFIX_MUST_NOT_LEAK';
    const tail = 'ADMISSION_TAIL_RETAINED';
    const outputBudget = 1024 * 1024;
    const originalRelease = CommandAdmissionGate.releaseCommandAdmissionGate;
    const release = vi
      .spyOn(CommandAdmissionGate, 'releaseCommandAdmissionGate')
      .mockImplementationOnce(async (child) => {
        await originalRelease(child);
        await new Promise((resolve) => setTimeout(resolve, 100));
        throw new Error('injected foreground gate write failure');
      });

    try {
      const result = await bashTool.execute(
        {
          command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(
            `process.stdout.write(${JSON.stringify(prefix)} + 'x'.repeat(${
              outputBudget + 4096
            }) + ${JSON.stringify(tail)}, () => setInterval(() => {}, 1000))`
          )}`,
          timeout: 2_000,
          env: {},
          run_in_background: false,
        },
        new AbortController().signal,
        {
          sessionId: `foreground-release-${Date.now()}`,
          workspaceRoot: workspace,
        }
      );

      expect(result).toMatchObject({
        success: false,
        error: { message: 'Foreground command admission failed' },
        metadata: { admission_failed: true },
      });
      expect(result.metadata).toMatchObject({
        output_accounting_complete: true,
        terminal_transport: 'local',
        terminal_output_merged: false,
      });
      expect(result.metadata?.stdout_total_bytes).toBeGreaterThan(outputBudget);
      expect(result.metadata?.stdout_omitted_bytes).toBeGreaterThan(0);
      expect(String(result.metadata?.stdout)).toContain(tail);
      expect(String(result.metadata?.stdout)).not.toContain(prefix);
      const names = await readdir(
        path.join(getProjectStoragePath(workspace), '.foreground-processes'),
        { recursive: true }
      );
      expect(names.some((name) => name.endsWith('.json'))).toBe(false);
    } finally {
      release.mockRestore();
    }
  });

  it('preserves real exit when admission release completion outlives timeout', async () => {
    const workspace = await mkdtemp(
      path.join(os.tmpdir(), 'blade-foreground-release-race-')
    );
    tempRoots.push(workspace);
    const marker = path.join(workspace, 'command-ran');
    let notifyChildClosed: (() => void) | undefined;
    const childClosed = new Promise<void>((resolve) => {
      notifyChildClosed = resolve;
    });
    let allowReleaseToFinish: (() => void) | undefined;
    const releaseMayFinish = new Promise<void>((resolve) => {
      allowReleaseToFinish = resolve;
    });
    const originalRelease = CommandAdmissionGate.releaseCommandAdmissionGate;
    const release = vi
      .spyOn(CommandAdmissionGate, 'releaseCommandAdmissionGate')
      .mockImplementationOnce(async (child) => {
        const gateClosed = new Promise<void>((resolve) => {
          child.once('close', () => resolve());
        });
        await originalRelease(child);
        await gateClosed;
        notifyChildClosed?.();
        await releaseMayFinish;
      });

    try {
      const resultPromise = bashTool.execute(
        {
          command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(
            `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'done')`
          )}`,
          timeout: 2_000,
          env: {},
          run_in_background: false,
        },
        new AbortController().signal,
        {
          sessionId: `foreground-release-race-${Date.now()}`,
          workspaceRoot: workspace,
        }
      );

      await childClosed;
      await new Promise((resolve) => setTimeout(resolve, 2_100));
      allowReleaseToFinish?.();
      const result = await resultPromise;

      expect(result).toMatchObject({
        success: true,
        llmContent: { exit_code: 0 },
      });
      expect(result.metadata?.timeout).not.toBe(true);
      expect(await readFile(marker, 'utf8')).toBe('done');
    } finally {
      allowReleaseToFinish?.();
      release.mockRestore();
    }
  }, 10_000);

  it('retains its lease when foreground group finalization fails', async () => {
    const workspace = await mkdtemp(
      path.join(os.tmpdir(), 'blade-foreground-finalize-')
    );
    tempRoots.push(workspace);
    const marker = path.join(workspace, 'command-ran');
    const prefix = 'FINALIZATION_PREFIX_MUST_NOT_LEAK';
    const tail = 'FINALIZATION_TAIL_RETAINED';
    const outputBudget = 1024 * 1024;
    const finalize = vi
      .spyOn(CommandAdmissionGate, 'finalizeCommandAdmissionGate')
      .mockResolvedValueOnce({
        success: false,
        alreadyExited: false,
        forced: false,
      });

    try {
      const result = await bashTool.execute(
        {
          command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(
            `require('node:fs').writeFileSync(${JSON.stringify(
              marker
            )}, 'admitted'); process.stdout.write(${JSON.stringify(
              prefix
            )} + 'x'.repeat(${outputBudget + 4096}) + ${JSON.stringify(
              tail
            )}, () => process.exit(0))`
          )}`,
          timeout: 2_000,
          env: {},
          run_in_background: false,
        },
        new AbortController().signal,
        {
          sessionId: `foreground-finalize-${Date.now()}`,
          workspaceRoot: workspace,
        }
      );

      expect(result).toMatchObject({
        success: false,
        error: { message: 'Foreground command finalization failed' },
        metadata: { finalization_failed: true },
      });
      expect(result.metadata).toMatchObject({
        output_accounting_complete: true,
        terminal_transport: 'local',
        terminal_output_merged: false,
      });
      expect(result.metadata?.stdout_total_bytes).toBeGreaterThan(outputBudget);
      expect(result.metadata?.stdout_omitted_bytes).toBeGreaterThan(0);
      expect(String(result.metadata?.stdout)).toContain(tail);
      expect(String(result.metadata?.stdout)).not.toContain(prefix);
      expect(await readFile(marker, 'utf8')).toBe('admitted');
      const names = await readdir(
        path.join(getProjectStoragePath(workspace), '.foreground-processes'),
        { recursive: true }
      );
      expect(names.some((name) => name.endsWith('.json'))).toBe(true);
    } finally {
      finalize.mockRestore();
    }
  });

  it('removes a durable foreground lease after natural exit', async () => {
    const workspace = await mkdtemp(
      path.join(os.tmpdir(), 'blade-foreground-natural-')
    );
    tempRoots.push(workspace);
    const marker = path.join(workspace, 'completed');
    const sessionId = `foreground-natural-${Date.now()}`;

    const result = await bashTool.execute(
      {
        command: `printf completed > ${shellQuote(marker)}`,
        timeout: 2_000,
        env: {},
        run_in_background: false,
      },
      new AbortController().signal,
      { sessionId, workspaceRoot: workspace }
    );

    expect(result.success).toBe(true);
    expect(await readFile(marker, 'utf8')).toBe('completed');
    const leaseRoot = path.join(
      getProjectStoragePath(workspace),
      '.foreground-processes'
    );
    const names = await readdir(leaseRoot, { recursive: true });
    expect(names.some((name) => name.endsWith('.json'))).toBe(false);
  });

  it('finalizes redirected descendants before reporting foreground completion', async () => {
    const workspace = await mkdtemp(
      path.join(os.tmpdir(), 'blade-foreground-redirected-')
    );
    tempRoots.push(workspace);
    const pidFile = path.join(workspace, 'redirected.pid');
    const sessionId = `foreground-redirected-${Date.now()}`;
    const script =
      `require('fs').writeFileSync(${JSON.stringify(pidFile)},` +
      `String(process.pid));process.on('SIGTERM',()=>{});` +
      `setInterval(()=>{},1000);`;

    const result = await bashTool.execute(
      {
        command:
          `${shellQuote(process.execPath)} -e ${shellQuote(script)} ` +
          `</dev/null >/dev/null 2>&1 & ` +
          `while [ ! -s ${shellQuote(pidFile)} ]; do sleep 0.01; done`,
        timeout: 5_000,
        env: {},
        run_in_background: false,
      },
      new AbortController().signal,
      { sessionId, workspaceRoot: workspace }
    );
    const descendantPid = Number.parseInt(await readFile(pidFile, 'utf8'), 10);

    expect(result.success).toBe(true);
    expect(await waitFor(() => processIsGone(descendantPid))).toBe(true);
    const names = await readdir(
      path.join(getProjectStoragePath(workspace), '.foreground-processes'),
      { recursive: true }
    );
    expect(names.some((name) => name.endsWith('.json'))).toBe(false);
  }, 10_000);

  it('reaps a durable foreground command after its owner hard-exits', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'blade-orphan-foreground-'));
    tempRoots.push(workspace);
    const sessionId = `orphan-foreground-${Date.now()}`;
    const owner = await startForegroundShellOwner(workspace, sessionId);
    descendantPids.add(owner.commandPid);
    const lease = await readForegroundLease(workspace);

    try {
      expect(lease.contents).not.toContain('foreground-command.pid');
      expect(lease.contents).not.toContain('BLADE_STORAGE_ROOT');
      expect(owner.launcher.kill('SIGKILL')).toBe(true);
      await owner.closed;

      const result = await new ForegroundProcessLeaseStore(
        workspace,
        sessionId
      ).reapOrphans();

      expect(result.reaped + result.stale).toBe(1);
      expect(result.protected).toBe(0);
      expect(await waitFor(() => processIsGone(owner.commandPid))).toBe(true);
      descendantPids.delete(owner.commandPid);
    } finally {
      owner.launcher.kill('SIGKILL');
      try {
        process.kill(-lease.value.rootPid, 'SIGKILL');
      } catch {
        // The durable orphan reaper already terminated the process group.
      }
      await waitFor(() => processIsGone(owner.commandPid));
      descendantPids.delete(owner.commandPid);
    }
  });

  it('reaps a leaderless process group after its owner hard-exits', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'blade-orphan-leaderless-'));
    tempRoots.push(workspace);
    const sessionId = `orphan-leaderless-${Date.now()}`;
    const owner = await startLeaderlessShellOwner(workspace, sessionId);
    descendantPids.add(owner.commandPid);
    const lease = await readForegroundLease(workspace);

    try {
      expect(lease.contents).not.toContain('leaderless-command.pid');
      expect(await waitFor(() => processIsGone(lease.value.rootPid))).toBe(true);
      expect(() => process.kill(owner.commandPid, 0)).not.toThrow();
      expect(owner.launcher.kill('SIGKILL')).toBe(true);
      await owner.closed;

      const result = await new ForegroundProcessLeaseStore(
        workspace,
        sessionId
      ).reapOrphans();

      expect(result).toMatchObject({ reaped: 1, stale: 0, protected: 0 });
      expect(await waitFor(() => processIsGone(owner.commandPid))).toBe(true);
      descendantPids.delete(owner.commandPid);
    } finally {
      owner.launcher.kill('SIGKILL');
      try {
        process.kill(-lease.value.rootPid, 'SIGKILL');
      } catch {
        try {
          process.kill(owner.commandPid, 'SIGKILL');
        } catch {
          // The leaderless reaper already terminated the process group.
        }
      }
      await waitFor(() => processIsGone(owner.commandPid));
      descendantPids.delete(owner.commandPid);
    }
  });

  it('protects a foreground lease whose root PID identity changed', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'blade-reused-foreground-'));
    tempRoots.push(workspace);
    const sessionId = `reused-foreground-${Date.now()}`;
    const owner = await startForegroundShellOwner(workspace, sessionId);
    descendantPids.add(owner.commandPid);
    const lease = await readForegroundLease(workspace);

    try {
      lease.value.ownerIdentity.fingerprint = '1'.repeat(64);
      lease.value.identity.fingerprint = '0'.repeat(64);
      await writeFile(lease.filePath, `${JSON.stringify(lease.value)}\n`, {
        mode: 0o600,
      });

      const result = await new ForegroundProcessLeaseStore(
        workspace,
        sessionId
      ).reapOrphans();

      expect(result).toMatchObject({ reaped: 0, protected: 1 });
      expect(() => process.kill(lease.value.rootPid, 0)).not.toThrow();
    } finally {
      owner.launcher.kill('SIGKILL');
      await owner.closed;
      try {
        process.kill(-lease.value.rootPid, 'SIGKILL');
      } catch {
        // The process group has already exited.
      }
      await waitFor(() => processIsGone(owner.commandPid));
      descendantPids.delete(owner.commandPid);
    }
  });

  it('fails closed for a malformed durable foreground lease', async () => {
    const workspace = await mkdtemp(
      path.join(os.tmpdir(), 'blade-corrupt-foreground-')
    );
    tempRoots.push(workspace);
    const sessionId = `corrupt-foreground-${Date.now()}`;
    const owner = await startForegroundShellOwner(workspace, sessionId);
    descendantPids.add(owner.commandPid);
    const lease = await readForegroundLease(workspace);

    try {
      await writeFile(
        lease.filePath,
        `${JSON.stringify({ ...lease.value, command: 'must-not-persist' })}\n`,
        { mode: 0o600 }
      );
      await expect(
        new ForegroundProcessLeaseStore(workspace, sessionId).reapOrphans()
      ).rejects.toThrow('Invalid durable foreground process lease');
      await writeFile(lease.filePath, '{}\n', { mode: 0o600 });
      await expect(
        new ForegroundProcessLeaseStore(workspace, sessionId).reapOrphans()
      ).rejects.toThrow('Invalid durable foreground process lease');
      expect(() => process.kill(lease.value.rootPid, 0)).not.toThrow();
    } finally {
      owner.launcher.kill('SIGKILL');
      await owner.closed;
      try {
        process.kill(-lease.value.rootPid, 'SIGKILL');
      } catch {
        // The process group has already exited.
      }
      await waitFor(() => processIsGone(owner.commandPid));
      descendantPids.delete(owner.commandPid);
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

  it('finalizes redirected descendants when a background shell leader exits', async () => {
    const workspace = await mkdtemp(
      path.join(os.tmpdir(), 'blade-background-redirected-')
    );
    tempRoots.push(workspace);
    const pidFile = path.join(workspace, 'background-redirected.pid');
    const script =
      `require('fs').writeFileSync(${JSON.stringify(pidFile)},` +
      `String(process.pid));process.on('SIGTERM',()=>{});` +
      `setInterval(()=>{},1000);`;
    const manager = BackgroundShellManager.getInstance();
    const shell = await manager.startBackgroundProcess({
      command:
        `${shellQuote(process.execPath)} -e ${shellQuote(script)} ` +
        `</dev/null >/dev/null 2>&1 & ` +
        `while [ ! -s ${shellQuote(pidFile)} ]; do sleep 0.01; done`,
      sessionId: 'background-redirected-test',
      projectPath: workspace,
      cwd: workspace,
    });
    const started = await waitFor(async () => {
      try {
        return (await readFile(pidFile, 'utf8')).length > 0;
      } catch {
        return false;
      }
    });
    expect(started).toBe(true);
    const descendantPid = Number.parseInt(await readFile(pidFile, 'utf8'), 10);

    const finalized = await waitFor(
      async () =>
        manager.getProcess(shell.id, 'background-redirected-test')?.status === 'exited'
    );
    expect(finalized).toBe(true);
    expect(await waitFor(() => processIsGone(descendantPid))).toBe(true);
    const leaseRoot = path.join(getProjectStoragePath(workspace), '.background-shells');
    const names = await readdir(leaseRoot, { recursive: true });
    expect(names.some((name) => name.endsWith('.json'))).toBe(false);
  }, 10_000);

  it('kills the full tree when the ACP local terminal fallback times out', async () => {
    const fixture = await createProcessTreeFixture('acp-fallback');
    const workspace = path.dirname(fixture.descendantPidFile);
    const sessionId = `acp-foreground-${Date.now()}`;

    const result = await getTerminalService().execute(fixture.command, {
      timeout: FIXTURE_COMMAND_TIMEOUT_MS,
      durableOwnership: { sessionId, projectPath: workspace },
    });
    const descendantPid = await fixture.readDescendantPid();

    expect(result).toMatchObject({ success: false, error: 'Command was terminated' });
    await expectTreeTerminated(fixture.cleanupMarker, descendantPid);
    const names = await readdir(
      path.join(getProjectStoragePath(workspace), '.foreground-processes'),
      { recursive: true }
    );
    expect(names.some((name) => name.endsWith('.json'))).toBe(false);
  }, 20_000);

  it('reaps a leaderless ACP local terminal process group', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'blade-acp-leaderless-'));
    tempRoots.push(workspace);
    const sessionId = `acp-leaderless-${Date.now()}`;
    const pidFile = path.join(workspace, 'acp-leaderless.pid');
    const script =
      `require('fs').writeFileSync(${JSON.stringify(pidFile)},` +
      `String(process.pid));process.on('SIGTERM',()=>{});` +
      `setInterval(()=>{},1000);`;
    const execution = getTerminalService().execute(
      `${shellQuote(process.execPath)} -e ${shellQuote(script)} </dev/null &`,
      {
        timeout: 30_000,
        durableOwnership: { sessionId, projectPath: workspace },
      }
    );
    const ready = await waitFor(async () => {
      try {
        return (await readFile(pidFile, 'utf8')).length > 0;
      } catch {
        return false;
      }
    });
    expect(ready).toBe(true);
    const descendantPid = Number.parseInt(await readFile(pidFile, 'utf8'), 10);
    descendantPids.add(descendantPid);
    const lease = await readForegroundLease(workspace);

    try {
      expect(await waitFor(() => processIsGone(lease.value.rootPid))).toBe(true);
      lease.value.ownerIdentity.fingerprint = '0'.repeat(64);
      await writeFile(lease.filePath, `${JSON.stringify(lease.value)}\n`, {
        mode: 0o600,
      });

      const result = await new ForegroundProcessLeaseStore(
        workspace,
        sessionId
      ).reapOrphans();

      expect(result).toMatchObject({ reaped: 1, stale: 0, protected: 0 });
      expect(await waitFor(() => processIsGone(descendantPid))).toBe(true);
      await execution;
      descendantPids.delete(descendantPid);
    } finally {
      try {
        process.kill(-lease.value.rootPid, 'SIGKILL');
      } catch {
        try {
          process.kill(descendantPid, 'SIGKILL');
        } catch {
          // The leaderless reaper already terminated the process group.
        }
      }
      await waitFor(() => processIsGone(descendantPid));
      descendantPids.delete(descendantPid);
    }
  }, 15_000);

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
