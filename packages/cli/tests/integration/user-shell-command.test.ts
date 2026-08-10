import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createLocalUserShellExecutor,
  executeUserShellCommand,
} from '../../src/services/UserShellCommandService.js';

vi.unmock('child_process');
vi.unmock('node:child_process');

const roots: string[] = [];

function stringEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string'
    )
  );
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe('user shell command integration', () => {
  it('runs in the exact workspace with the supplied Session environment', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'blade-user-shell-'));
    roots.push(root);
    const canonicalRoot = await realpath(root);
    const marker = path.join(root, 'marker.txt');
    const result = await executeUserShellCommand(
      `printf '%s:%s' \"$PWD\" \"$SESSION_MARKER\" > marker.txt && cat marker.txt`,
      {
        executionId: 'integration-shell',
        cwd: root,
        env: {
          ...stringEnvironment(),
          SESSION_MARKER: 'frozen-env',
        },
        signal: new AbortController().signal,
        executor: createLocalUserShellExecutor(),
      }
    );

    expect(result).toMatchObject({
      status: 'completed',
      exitCode: 0,
      stdout: `${canonicalRoot}:frozen-env`,
    });
    expect(await readFile(marker, 'utf8')).toBe(`${canonicalRoot}:frozen-env`);
  });

  it('kills the complete process tree when the owning signal aborts', async () => {
    if (process.platform === 'win32') return;
    const root = await mkdtemp(path.join(os.tmpdir(), 'blade-user-shell-abort-'));
    roots.push(root);
    const pidFile = path.join(root, 'child.pid');
    const controller = new AbortController();
    const execution = executeUserShellCommand(
      `sleep 30 & echo $! > '${pidFile}'; wait`,
      {
        executionId: 'abort-shell',
        cwd: root,
        env: stringEnvironment(),
        signal: controller.signal,
        executor: createLocalUserShellExecutor(),
      }
    );
    let childPid = 0;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        childPid = Number((await readFile(pidFile, 'utf8')).trim());
        if (childPid > 0) break;
      } catch {
        // Wait for the script to publish its descendant PID.
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(childPid).toBeGreaterThan(1);

    controller.abort('test-cancel');
    const result = await execution;

    expect(result.status).toBe('aborted');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(() => process.kill(childPid, 0)).toThrow();
  });
});
