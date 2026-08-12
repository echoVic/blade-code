import { describe, expect, it } from 'vitest';
import {
  captureProcessIdentity,
  type ProcessIdentitySource,
  processIdentityMatches,
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
});
