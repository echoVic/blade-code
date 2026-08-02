import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { OwnedProcessTree } from '../../../../src/utils/process/OwnedProcessTree.js';

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
