import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function resolveBunExecutable(): string {
  const candidates = [
    process.env.BUN_EXEC_PATH,
    process.env.BUN_INSTALL
      ? path.join(process.env.BUN_INSTALL, 'bin', 'bun')
      : undefined,
    path.join(os.homedir(), '.bun', 'bin', 'bun'),
    '/opt/homebrew/bin/bun',
    '/usr/local/bin/bun',
  ];
  const executable = candidates.find((candidate): candidate is string =>
    Boolean(candidate && existsSync(candidate))
  );
  if (!executable) {
    throw new Error('Bun executable is unavailable for the root-turn PTY runner');
  }
  return executable;
}

export interface RootTurnAutoResumePtyEvidence {
  success: true;
  sawAttention: true;
  sawExpected: true;
  output: string;
}

export async function runRootTurnAutoResumePtyDriver(input: {
  workspace: string;
  storageRoot: string;
  home: string;
  sessionId: string;
  inputMessageId: string;
  expected: string;
  secret: string;
  timeoutMs?: number;
}): Promise<RootTurnAutoResumePtyEvidence> {
  const runner = path.resolve(import.meta.dirname, 'rootTurnAutoResumePtyRunner.ts');
  const cliEntry = path.resolve(import.meta.dirname, '../../dist/blade.js');
  const env = Object.fromEntries(
    Object.entries({
      ...process.env,
      HOME: input.home,
      BLADE_STORAGE_ROOT: input.storageRoot,
      BLADE_AUTO_MEMORY: '0',
      BLADE_TELEMETRY_DISABLED: '1',
      TERM: 'xterm-256color',
      BLADE_ROOT_RESUME_PTY_CLI_ENTRY: cliEntry,
      BLADE_ROOT_RESUME_PTY_WORKSPACE: input.workspace,
      BLADE_ROOT_RESUME_PTY_SESSION_ID: input.sessionId,
      BLADE_ROOT_RESUME_PTY_INPUT_MESSAGE_ID: input.inputMessageId,
      BLADE_ROOT_RESUME_PTY_EXPECTED: input.expected,
      BLADE_ROOT_RESUME_PTY_SECRET: input.secret,
    }).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  );
  let result: Awaited<ReturnType<typeof execFileAsync>>;
  try {
    result = await execFileAsync(resolveBunExecutable(), [runner], {
      cwd: path.resolve(import.meta.dirname, '../..'),
      env,
      timeout: input.timeoutMs ?? 210_000,
      maxBuffer: 64 * 1024,
      killSignal: 'SIGKILL',
    });
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string };
    const details = `${String(failure.stdout ?? '')}\n${String(failure.stderr ?? '')}`
      .replaceAll(input.secret, '[REDACTED]')
      .trim();
    throw new Error(details || failure.message);
  }
  const parsed = JSON.parse(String(result.stdout)) as Record<string, unknown>;
  if (
    parsed.success !== true ||
    parsed.sawAttention !== true ||
    parsed.sawExpected !== true ||
    typeof parsed.output !== 'string'
  ) {
    throw new Error(
      `Root-turn PTY evidence is incomplete: ${String(
        parsed.error ?? parsed.output ?? 'unknown'
      )}`
    );
  }
  if (parsed.output.includes(input.secret)) {
    throw new Error('Root-turn PTY evidence contains provider credentials');
  }
  return parsed as unknown as RootTurnAutoResumePtyEvidence;
}
