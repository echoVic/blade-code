import { describe, expect, it, vi } from 'vitest';
import {
  captureProcessIdentity,
  isProcessIdentity,
  type ProcessIdentitySource,
  processIdentityMatches,
  processIdentityMatchesOrIsGone,
} from '../../../../src/utils/process/ProcessIdentity.js';

describe('process identity', () => {
  it('captures a stable fixed-length identity for the current process', () => {
    const first = captureProcessIdentity(process.pid);
    const second = captureProcessIdentity(process.pid);

    expect(first).toEqual(second);
    expect(first?.platform).toBe(process.platform);
    expect(first?.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects PID reuse represented by a different fingerprint', () => {
    expect(
      processIdentityMatches(process.pid, {
        platform: process.platform,
        fingerprint: '0'.repeat(64),
      })
    ).toBe(false);
  });

  it('rejects unsafe process identifiers', () => {
    expect(captureProcessIdentity(0)).toBeUndefined();
    expect(captureProcessIdentity(-1)).toBeUndefined();
  });

  it('validates only supported fixed-length process identities', () => {
    expect(
      isProcessIdentity({
        platform: 'linux',
        fingerprint: 'a'.repeat(64),
      })
    ).toBe(true);
    expect(
      isProcessIdentity({
        platform: 'freebsd',
        fingerprint: 'a'.repeat(64),
      })
    ).toBe(false);
    expect(
      isProcessIdentity({
        platform: 'linux',
        fingerprint: 'not-a-fingerprint',
      })
    ).toBe(false);
  });

  it('parses Linux start ticks after a command containing parentheses', () => {
    const source: ProcessIdentitySource = {
      readFile: () =>
        `42 (worker (nested)) ${['S', ...Array(18).fill('1'), '4242'].join(' ')}`,
      execFile: () => {
        throw new Error('unexpected exec');
      },
    };

    const first = captureProcessIdentity(42, 'linux', source);
    const second = captureProcessIdentity(42, 'linux', source);

    expect(first).toEqual(second);
    expect(first?.platform).toBe('linux');
  });

  it('uses bounded platform commands for macOS and Windows creation time', () => {
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const source: ProcessIdentitySource = {
      readFile: () => {
        throw new Error('unexpected read');
      },
      execFile: (command, args) => {
        calls.push({ command, args });
        return 'Mon Aug 12 10:00:00 2026\n';
      },
    };

    expect(captureProcessIdentity(77, 'darwin', source)?.platform).toBe('darwin');
    expect(captureProcessIdentity(88, 'win32', source)?.platform).toBe('win32');
    expect(calls[0]).toEqual({
      command: 'ps',
      args: ['-o', 'lstart=', '-p', '77'],
    });
    expect(calls[1]?.command).toBe('powershell.exe');
    expect(calls[1]?.args.join(' ')).toContain('ProcessId = 88');
  });

  it('fails closed when identity acquisition fails or is unsupported', () => {
    const source: ProcessIdentitySource = {
      readFile: () => {
        throw new Error('denied');
      },
      execFile: () => {
        throw new Error('denied');
      },
    };

    expect(captureProcessIdentity(42, 'linux', source)).toBeUndefined();
    expect(captureProcessIdentity(42, 'freebsd', source)).toBeUndefined();
  });

  it('accepts a leased PID that exits while its identity is sampled', () => {
    const source: ProcessIdentitySource = {
      readFile: () => {
        throw new Error('process exited');
      },
      execFile: () => {
        throw new Error('process exited');
      },
    };
    const isRunning = vi.fn(() => false);

    expect(
      processIdentityMatchesOrIsGone(
        42,
        { platform: 'darwin', fingerprint: 'a'.repeat(64) },
        source,
        isRunning
      )
    ).toBe(true);
    expect(isRunning).toHaveBeenCalledWith(42);
  });

  it('fails closed after observing a concrete reused PID identity', () => {
    const expectedSource: ProcessIdentitySource = {
      readFile: () => {
        throw new Error('unexpected read');
      },
      execFile: () => 'Mon Aug 12 10:00:00 2026\n',
    };
    const reusedSource: ProcessIdentitySource = {
      readFile: () => {
        throw new Error('unexpected read');
      },
      execFile: () => 'Mon Aug 12 10:00:01 2026\n',
    };
    const expected = captureProcessIdentity(42, 'darwin', expectedSource);
    const isRunning = vi.fn(() => false);

    expect(expected).toBeDefined();
    expect(processIdentityMatchesOrIsGone(42, expected!, reusedSource, isRunning)).toBe(
      false
    );
    expect(isRunning).not.toHaveBeenCalled();
  });
});
