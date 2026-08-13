import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export interface ProcessIdentity {
  platform: NodeJS.Platform;
  fingerprint: string;
}

export interface ProcessIdentitySource {
  readFile(filePath: string): string;
  execFile(command: string, args: readonly string[]): string;
}

export type ProcessLivenessProbe = (pid: number) => boolean;

const PROCESS_IDENTITY_FINGERPRINT = /^[a-f0-9]{64}$/;

export function isProcessIdentity(value: unknown): value is ProcessIdentity {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ProcessIdentity>;
  return (
    (candidate.platform === 'linux' ||
      candidate.platform === 'darwin' ||
      candidate.platform === 'win32') &&
    typeof candidate.fingerprint === 'string' &&
    PROCESS_IDENTITY_FINGERPRINT.test(candidate.fingerprint)
  );
}

const defaultSource: ProcessIdentitySource = {
  readFile: (filePath) => readFileSync(filePath, 'utf8'),
  execFile: (command, args) =>
    execFileSync(command, args, {
      encoding: 'utf8',
      timeout: command === 'powershell.exe' ? 3_000 : 2_000,
      windowsHide: true,
    }),
};

const defaultLivenessProbe: ProcessLivenessProbe = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (
      error instanceof Error &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'EPERM'
    );
  }
};

function hashIdentity(platform: NodeJS.Platform, value: string): ProcessIdentity {
  return {
    platform,
    fingerprint: createHash('sha256').update(`${platform}\0${value}`).digest('hex'),
  };
}

function linuxStartTicks(pid: number, source: ProcessIdentitySource): string {
  const stat = source.readFile(`/proc/${pid}/stat`).trim();
  const commandEnd = stat.lastIndexOf(')');
  if (commandEnd < 0) throw new Error('Invalid /proc process stat');
  const fieldsAfterCommand = stat.slice(commandEnd + 2).split(/\s+/);
  const startTicks = fieldsAfterCommand[19];
  if (!startTicks || !/^\d+$/.test(startTicks)) {
    throw new Error('Missing process start ticks');
  }
  return startTicks;
}

export function captureProcessIdentity(
  pid: number,
  platform: NodeJS.Platform = process.platform,
  source: ProcessIdentitySource = defaultSource
): ProcessIdentity | undefined {
  if (!Number.isInteger(pid) || pid <= 1) return undefined;
  try {
    if (platform === 'linux') {
      return hashIdentity(platform, linuxStartTicks(pid, source));
    }
    if (platform === 'darwin') {
      const startedAt = source
        .execFile('ps', ['-o', 'lstart=', '-p', String(pid)])
        .trim();
      return startedAt ? hashIdentity(platform, startedAt) : undefined;
    }
    if (platform === 'win32') {
      const command =
        `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").` +
        "CreationDate.ToUniversalTime().ToString('O')";
      const startedAt = source
        .execFile('powershell.exe', [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          command,
        ])
        .trim();
      return startedAt ? hashIdentity(platform, startedAt) : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function processIdentityMatches(
  pid: number,
  expected: ProcessIdentity
): boolean {
  const current = captureProcessIdentity(pid, expected.platform);
  return current?.fingerprint === expected.fingerprint;
}

/**
 * Validates a PID-backed lease without confusing an exit between probes with
 * PID reuse. A concrete fingerprint mismatch always fails closed.
 */
export function processIdentityMatchesOrIsGone(
  pid: number,
  expected: ProcessIdentity,
  source: ProcessIdentitySource = defaultSource,
  isRunning: ProcessLivenessProbe = defaultLivenessProbe
): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  const current = captureProcessIdentity(pid, expected.platform, source);
  if (current) return current.fingerprint === expected.fingerprint;
  return !isRunning(pid);
}
