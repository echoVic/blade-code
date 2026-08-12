import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  OwnedProcessTree,
  processGroupIsRunning,
  terminateProcessGroupByPid,
  terminateProcessTreeByPid,
} from '../../../../src/utils/process/OwnedProcessTree.js';

class FakeChild extends EventEmitter {
  readonly kill = vi.fn(() => true);

  constructor(readonly pid: number | undefined) {
    super();
  }
}

function asChild(child: FakeChild): ChildProcess {
  return child as unknown as ChildProcess;
}

describe('OwnedProcessTree', () => {
  it('probes a POSIX process group independently from its leader PID', () => {
    const present = vi.fn(() => true);
    const missing = vi.fn(() => {
      throw Object.assign(new Error('missing'), { code: 'ESRCH' });
    });

    expect(processGroupIsRunning(42_420, 'linux', present)).toBe(true);
    expect(processGroupIsRunning(42_421, 'darwin', missing)).toBe(false);
    expect(processGroupIsRunning(42_422, 'win32', present)).toBe(false);
    expect(present.mock.calls).toEqual([[-42_420, 0]]);
    expect(missing.mock.calls).toEqual([[-42_421, 0]]);
  });

  it('terminates a leaderless POSIX group without signaling the reused PID', async () => {
    const killProcess = vi.fn(() => true);

    await expect(
      terminateProcessGroupByPid(42_428, {
        platform: 'darwin',
        killProcess,
        wait: async () => undefined,
        validatePidOwnership: () => true,
      })
    ).resolves.toEqual({
      success: true,
      alreadyExited: false,
      forced: true,
    });
    expect(killProcess.mock.calls).toEqual([
      [-42_428, 'SIGTERM'],
      [-42_428, 'SIGKILL'],
    ]);
  });

  it('does not force a leaderless group after its root PID is reused', async () => {
    let rootPidAbsent = true;
    const killProcess = vi.fn(() => true);

    await expect(
      terminateProcessGroupByPid(42_429, {
        platform: 'linux',
        killProcess,
        wait: async () => {
          rootPidAbsent = false;
        },
        validatePidOwnership: () => rootPidAbsent,
      })
    ).resolves.toEqual({
      success: false,
      alreadyExited: false,
      forced: false,
    });
    expect(killProcess.mock.calls).toEqual([[-42_429, 'SIGTERM']]);
  });

  it('revalidates PID ownership before forcing an orphan tree', async () => {
    let ownsPid = true;
    const killProcess = vi.fn(() => true);
    const wait = vi.fn(async () => {
      ownsPid = false;
    });

    await expect(
      terminateProcessTreeByPid(42_423, {
        platform: 'linux',
        killProcess,
        wait,
        validatePidOwnership: () => ownsPid,
      })
    ).resolves.toEqual({
      success: true,
      alreadyExited: false,
      forced: false,
    });
    expect(killProcess.mock.calls).toEqual([[-42_423, 'SIGTERM']]);
  });

  it('does not signal an orphan tree whose initial PID identity changed', async () => {
    const killProcess = vi.fn(() => true);

    await expect(
      terminateProcessTreeByPid(42_422, {
        platform: 'linux',
        killProcess,
        validatePidOwnership: () => false,
      })
    ).resolves.toMatchObject({ success: false, forced: false });
    expect(killProcess).not.toHaveBeenCalled();
  });

  it('terminates an owned POSIX group gracefully before forcing survivors', async () => {
    const child = new FakeChild(42_424);
    const killProcess = vi.fn(() => true);
    const wait = vi.fn(async () => undefined);
    const tree = new OwnedProcessTree(asChild(child), {
      platform: 'darwin',
      gracePeriodMs: 500,
      killProcess,
      wait,
    });

    const first = await tree.terminate();
    const second = await tree.terminate();

    expect(killProcess.mock.calls).toEqual([
      [-42_424, 'SIGTERM'],
      [-42_424, 'SIGKILL'],
    ]);
    expect(wait).toHaveBeenCalledWith(500);
    expect(first).toMatchObject({ success: true, forced: true });
    expect(second).toEqual(first);
  });

  it('does not signal a process after natural ownership release', async () => {
    const child = new FakeChild(42_425);
    const killProcess = vi.fn(() => true);
    const tree = new OwnedProcessTree(asChild(child), {
      platform: 'linux',
      killProcess,
      wait: async () => undefined,
    });
    child.emit('close', 0, null);

    await expect(tree.terminate()).resolves.toMatchObject({
      success: true,
      alreadyExited: true,
      forced: false,
    });
    expect(killProcess).not.toHaveBeenCalled();
  });

  it('retains an owned group after its leader exits when configured', async () => {
    const child = new FakeChild(42_427);
    const killProcess = vi.fn(() => true);
    const tree = new OwnedProcessTree(asChild(child), {
      platform: 'linux',
      releaseOnExit: false,
      killProcess,
      wait: async () => undefined,
    });
    child.emit('close', 9, null);

    await expect(tree.terminate()).resolves.toMatchObject({
      success: true,
      alreadyExited: false,
      forced: true,
    });
    expect(killProcess.mock.calls).toEqual([
      [-42_427, 'SIGTERM'],
      [-42_427, 'SIGKILL'],
    ]);
  });

  it('refuses to broadcast to the caller process group', async () => {
    const child = new FakeChild(process.pid);
    const killProcess = vi.fn(() => true);
    const tree = new OwnedProcessTree(asChild(child), {
      platform: 'linux',
      killProcess,
      wait: async () => undefined,
    });

    await expect(tree.terminate()).resolves.toMatchObject({ success: true });
    expect(killProcess).not.toHaveBeenCalled();
    expect(child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
  });

  it('awaits Windows tree termination before forcing survivors', async () => {
    const child = new FakeChild(42_426);
    const taskkill = vi.fn(async () => true);
    const wait = vi.fn(async () => undefined);
    const tree = new OwnedProcessTree(asChild(child), {
      platform: 'win32',
      gracePeriodMs: 500,
      taskkill,
      wait,
    });

    await expect(tree.terminate()).resolves.toMatchObject({
      success: true,
      forced: true,
    });
    expect(taskkill.mock.calls).toEqual([
      [42_426, false],
      [42_426, true],
    ]);
    expect(wait).toHaveBeenCalledWith(500);
  });
});
