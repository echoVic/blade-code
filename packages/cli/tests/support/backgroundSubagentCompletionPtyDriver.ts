import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_SERIALIZED_EVIDENCE_CHARS = 30_000;
const MAX_FAILURE_DIAGNOSTIC_CHARS = 8_000;

export interface BackgroundSubagentCompletionPtyEvidence {
  success: true;
  sawProviderAdmission: true;
  sawChildMarker: true;
  sawParentFinal: true;
  output: string;
}

function redactSecrets(value: string, secrets: readonly string[]): string {
  let redacted = value;
  for (const secret of secrets) {
    if (secret) redacted = redacted.replaceAll(secret, '[REDACTED]');
  }
  return redacted;
}

export function parseBackgroundSubagentCompletionPtyEvidence(
  stdout: string,
  secrets: readonly string[] = []
): BackgroundSubagentCompletionPtyEvidence {
  if (stdout.length > MAX_SERIALIZED_EVIDENCE_CHARS) {
    throw new Error(
      'Background completion PTY evidence exceeded its serialized budget'
    );
  }
  const parsed = JSON.parse(stdout) as Record<string, unknown>;
  const requiredFlags = [
    'success',
    'sawProviderAdmission',
    'sawChildMarker',
    'sawParentFinal',
  ] as const;
  const incomplete: string[] = requiredFlags.filter((field) => parsed[field] !== true);
  const projectedOutput = parsed.output;
  if (typeof projectedOutput !== 'string') incomplete.push('output');
  const output = typeof projectedOutput === 'string' ? projectedOutput : '';
  if (incomplete.length > 0) {
    const runnerError =
      typeof parsed.error === 'string'
        ? redactSecrets(parsed.error, secrets).slice(0, 300)
        : undefined;
    const diagnosticOutput = redactSecrets(output, secrets).slice(
      -MAX_FAILURE_DIAGNOSTIC_CHARS
    );
    throw new Error(
      `Background completion PTY evidence is incomplete: ${JSON.stringify({
        incomplete,
        ...(runnerError ? { runnerError } : {}),
        ...(diagnosticOutput ? { output: diagnosticOutput } : {}),
      })}`
    );
  }
  for (const secret of secrets) {
    if (secret && output.includes(secret)) {
      throw new Error('Background completion PTY evidence contains credentials');
    }
  }
  return {
    ...parsed,
    output,
  } as unknown as BackgroundSubagentCompletionPtyEvidence;
}

function runnerFailureDiagnostic(error: unknown, secrets: readonly string[]): string {
  const result = error as {
    message?: unknown;
    stdout?: unknown;
    stderr?: unknown;
  };
  return redactSecrets(
    [result.stdout, result.stderr, result.message]
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
      .join('\n'),
    secrets
  ).slice(-MAX_FAILURE_DIAGNOSTIC_CHARS);
}

export async function runBackgroundSubagentCompletionPtyDriver(input: {
  workspace: string;
  storageRoot: string;
  home: string;
  sessionId: string;
  childMarker: string;
  secret: string;
  timeoutMs?: number;
}): Promise<BackgroundSubagentCompletionPtyEvidence> {
  const runner = path.resolve(
    import.meta.dirname,
    'backgroundSubagentCompletionPtyRunner.ts'
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
      BLADE_BACKGROUND_COMPLETION_PTY_CLI_ENTRY: cliEntry,
      BLADE_BACKGROUND_COMPLETION_PTY_WORKSPACE: input.workspace,
      BLADE_BACKGROUND_COMPLETION_PTY_SESSION_ID: input.sessionId,
      BLADE_BACKGROUND_COMPLETION_PTY_CHILD_MARKER: input.childMarker,
      BLADE_BACKGROUND_COMPLETION_PTY_SECRET: input.secret,
    }).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  );
  let stdout: string;
  try {
    const result = await execFileAsync('bun', [runner], {
      cwd: path.resolve(import.meta.dirname, '../..'),
      env,
      timeout: input.timeoutMs ?? 240_000,
      maxBuffer: 64 * 1024,
      killSignal: 'SIGKILL',
    });
    stdout = result.stdout;
  } catch (error) {
    const failedStdout = (error as { stdout?: unknown }).stdout;
    if (typeof failedStdout === 'string' && failedStdout.length > 0) {
      parseBackgroundSubagentCompletionPtyEvidence(failedStdout, [input.secret]);
    }
    throw new Error(
      `Background completion PTY runner failed: ${
        runnerFailureDiagnostic(error, [input.secret]) || 'no diagnostic output'
      }`
    );
  }
  return parseBackgroundSubagentCompletionPtyEvidence(stdout, [input.secret]);
}
