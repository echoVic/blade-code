import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface WeightedProviderAdmissionPtyEvidence {
  success: true;
  childFailureVisible: true;
  sidecarPendingByteFailure: true;
  output: string;
}

export async function runWeightedProviderAdmissionPtyDriver(input: {
  workspace: string;
  storageRoot: string;
  home: string;
  sessionId: string;
  childMarker: string;
  secret: string;
  timeoutMs?: number;
}): Promise<WeightedProviderAdmissionPtyEvidence> {
  const runner = path.resolve(
    import.meta.dirname,
    'weightedProviderAdmissionPtyRunner.ts'
  );
  const cliEntry = path.resolve(import.meta.dirname, '../../dist/blade.js');
  const env = Object.fromEntries(
    Object.entries({
      ...process.env,
      HOME: input.home,
      BLADE_STORAGE_ROOT: input.storageRoot,
      BLADE_AUTO_MEMORY: '0',
      BLADE_TELEMETRY_DISABLED: '1',
      TERM: 'xterm-256color',
      BLADE_WEIGHTED_ADMISSION_PTY_CLI_ENTRY: cliEntry,
      BLADE_WEIGHTED_ADMISSION_PTY_WORKSPACE: input.workspace,
      BLADE_WEIGHTED_ADMISSION_PTY_STORAGE_ROOT: input.storageRoot,
      BLADE_WEIGHTED_ADMISSION_PTY_SESSION_ID: input.sessionId,
      BLADE_WEIGHTED_ADMISSION_PTY_CHILD_MARKER: input.childMarker,
      BLADE_WEIGHTED_ADMISSION_PTY_SECRET: input.secret,
    }).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  );
  const result = await execFileAsync('bun', [runner], {
    cwd: path.resolve(import.meta.dirname, '../..'),
    env,
    timeout: input.timeoutMs ?? 240_000,
    maxBuffer: 64 * 1024,
    killSignal: 'SIGKILL',
  });
  const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
  if (
    parsed.success !== true ||
    parsed.childFailureVisible !== true ||
    parsed.sidecarPendingByteFailure !== true ||
    typeof parsed.output !== 'string'
  ) {
    throw new Error(
      `Weighted Provider admission PTY evidence is incomplete: ${String(
        parsed.error ?? parsed.output ?? 'unknown'
      )}`
    );
  }
  if (parsed.output.includes(input.secret)) {
    throw new Error('Weighted Provider admission PTY evidence contains credentials');
  }
  return parsed as unknown as WeightedProviderAdmissionPtyEvidence;
}
