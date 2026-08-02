import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getTerminalService } from '../../src/acp/AcpServiceContext.js';
import { PermissionMode } from '../../src/config/types.js';
import { SecureProcessExecutor } from '../../src/hooks/SecureProcessExecutor.js';
import { HookEvent } from '../../src/hooks/types/HookTypes.js';
import { bashTool } from '../../src/tools/builtin/shell/bash.js';
import { BackgroundShellManager } from '../../src/tools/builtin/shell/BackgroundShellManager.js';

const tempRoots: string[] = [];
const descendantPids = new Set<number>();

beforeAll(async () => {
  const childProcess =
    await vi.importActual<typeof import('node:child_process')>('node:child_process');
  vi.mocked(spawn).mockImplementation(childProcess.spawn);
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
  it('kills a TERM-ignoring grandchild after a foreground Bash timeout', async () => {
    const fixture = await createProcessTreeFixture('foreground');

    const result = await bashTool.execute({
      command: fixture.command,
      timeout: 1_000,
      env: {},
      run_in_background: false,
    });
    const descendantPid = await fixture.readDescendantPid();

    expect(result.success).toBe(false);
    expect(result.error?.type).toBe('timeout_error');
    await expectTreeTerminated(fixture.cleanupMarker, descendantPid);
  }, 15_000);

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
    const shell = manager.startBackgroundProcess({
      command: fixture.command,
      sessionId: 'process-tree-test',
    });
    const descendantPid = await fixture.readDescendantPid();

    const result = await manager.kill(shell.id);

    expect(result).toMatchObject({ success: true, alreadyExited: false });
    await expectTreeTerminated(fixture.cleanupMarker, descendantPid);
  }, 15_000);

  it('kills the full tree when the ACP local terminal fallback times out', async () => {
    const fixture = await createProcessTreeFixture('acp-fallback');

    const result = await getTerminalService().execute(fixture.command, {
      timeout: 1_000,
    });
    const descendantPid = await fixture.readDescendantPid();

    expect(result).toMatchObject({ success: false, error: 'Command was terminated' });
    await expectTreeTerminated(fixture.cleanupMarker, descendantPid);
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
      1_000
    );
    const descendantPid = await fixture.readDescendantPid();

    expect(result).toMatchObject({ exitCode: 124, timedOut: true });
    await expectTreeTerminated(fixture.cleanupMarker, descendantPid);
  }, 15_000);

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
