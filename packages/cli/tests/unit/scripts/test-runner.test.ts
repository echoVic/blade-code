import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { testTypes } from '../../../scripts/test-config.js';
import { runOwnedCommand } from '../../../scripts/test-runner.js';

vi.unmock('node:child_process');

const tempRoots: string[] = [];
const descendantPids = new Set<number>();

async function processIsGone(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
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

afterEach(async () => {
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

describe.skipIf(process.platform === 'win32')('test runner process ownership', () => {
  it('allows the complete serial real API matrix to run for one hour', () => {
    expect(testTypes.realApi.timeout).toBe(60 * 60 * 1000);
  });

  it('keeps the process-heavy integration suite above fixture command budgets', () => {
    expect(testTypes.integration.timeout).toBe(180_000);
  });

  it('returns a normal exit without reporting timeout or abort', async () => {
    const result = await runOwnedCommand({
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
      cwd: os.tmpdir(),
      timeoutMs: 5_000,
      stdio: 'ignore',
    });

    expect(result).toEqual({
      exitCode: 0,
      signal: null,
      timedOut: false,
      aborted: false,
    });
  });

  it('kills a TERM-ignoring descendant when the command times out', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'blade-test-runner-'));
    tempRoots.push(root);
    const script = path.join(root, 'parent.mjs');
    const descendantPidFile = path.join(root, 'descendant.pid');

    await writeFile(
      script,
      [
        "import { spawn } from 'node:child_process';",
        "import { writeFileSync } from 'node:fs';",
        'const descendant = spawn(process.execPath, [',
        "  '-e',",
        '  "process.on(\'SIGTERM\', () => {}); setInterval(() => {}, 1000);",',
        "], { stdio: 'ignore' });",
        'writeFileSync(process.argv[2], String(descendant.pid));',
        "process.on('SIGTERM', () => {});",
        'setInterval(() => {}, 1000);',
        '',
      ].join('\n')
    );

    const result = await runOwnedCommand({
      command: process.execPath,
      args: [script, descendantPidFile],
      cwd: root,
      timeoutMs: 1_500,
      gracePeriodMs: 100,
      stdio: 'ignore',
    });
    const descendantPid = Number.parseInt(
      await readFile(descendantPidFile, 'utf8'),
      10
    );
    descendantPids.add(descendantPid);

    expect(result).toMatchObject({ timedOut: true, exitCode: null });
    expect(await waitFor(() => processIsGone(descendantPid))).toBe(true);
    descendantPids.delete(descendantPid);
  }, 10_000);
});
