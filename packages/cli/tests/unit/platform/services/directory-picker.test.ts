import { describe, expect, it, vi } from 'vitest';
import { NativeDirectoryPicker } from '../../../../src/services/DirectoryPicker.js';

describe('NativeDirectoryPicker', () => {
  it('uses the macOS folder chooser and returns its absolute path', async () => {
    const runCommand = vi.fn(async () => ({
      stdout: '/Users/example/project/\n',
      stderr: '',
      exitCode: 0,
    }));
    const picker = new NativeDirectoryPicker({ platform: 'darwin', runCommand });

    await expect(picker.pick()).resolves.toEqual({
      cancelled: false,
      path: '/Users/example/project/',
    });
    expect(runCommand).toHaveBeenCalledWith(
      'osascript',
      expect.arrayContaining(['-e', expect.stringContaining('choose folder')])
    );
  });

  it('treats native cancellation as a normal result', async () => {
    const picker = new NativeDirectoryPicker({
      platform: 'darwin',
      runCommand: async () => ({
        stdout: '__BLADE_DIRECTORY_PICKER_CANCELLED__',
        stderr: '',
        exitCode: 0,
      }),
    });

    await expect(picker.pick()).resolves.toEqual({ cancelled: true });
  });

  it('falls back from zenity to kdialog on Linux', async () => {
    const runCommand = vi
      .fn()
      .mockResolvedValueOnce({
        stdout: '',
        stderr: '',
        exitCode: 1,
        errorCode: 'ENOENT',
      })
      .mockResolvedValueOnce({
        stdout: '/home/example/project\n',
        stderr: '',
        exitCode: 0,
      });
    const picker = new NativeDirectoryPicker({ platform: 'linux', runCommand });

    await expect(picker.pick()).resolves.toEqual({
      cancelled: false,
      path: '/home/example/project',
    });
    expect(runCommand.mock.calls.map(([command]) => command)).toEqual([
      'zenity',
      'kdialog',
    ]);
  });

  it('coalesces concurrent requests into one native dialog', async () => {
    let resolveCommand:
      | ((result: { stdout: string; stderr: string; exitCode: number }) => void)
      | undefined;
    const runCommand = vi.fn(
      () =>
        new Promise<{ stdout: string; stderr: string; exitCode: number }>(
          (resolve) => {
            resolveCommand = resolve;
          }
        )
    );
    const picker = new NativeDirectoryPicker({ platform: 'darwin', runCommand });

    const first = picker.pick();
    const second = picker.pick();
    expect(first).toBe(second);
    resolveCommand?.({
      stdout: '/Users/example/shared',
      stderr: '',
      exitCode: 0,
    });

    await expect(first).resolves.toMatchObject({ cancelled: false });
    expect(runCommand).toHaveBeenCalledOnce();
  });
});
