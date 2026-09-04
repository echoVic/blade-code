import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const MAX_EVIDENCE_CHARS = 24_000;
const MIN_COMPLETION_TIMEOUT_MS = 1_000;
const MAX_COMPLETION_TIMEOUT_MS = 300_000;
const RUNNER_SETTLE_TIMEOUT_MS = 250;

export interface TuiTaskAttentionPtyEvidence {
  success: true;
  baselinePersisted: true;
  firstMarkerAbsent: true;
  newMarkerSeen: true;
  exactSessionSelected: true;
  terminalContentSeen: true;
  markerCleared: true;
  faults: string[];
  leakedSecrets: string[];
  stageOutput: { baseline: string; resume: string; cleared: string };
  output: string;
}

export const TUI_TASK_ATTENTION_PTY_USES_PRODUCTION_DIST = true;

function resolveBunExecutable(): string {
  const candidates = [
    process.env.BUN_EXEC_PATH,
    process.env.BUN_INSTALL
      ? path.join(
          process.env.BUN_INSTALL,
          'bin',
          process.platform === 'win32' ? 'bun.exe' : 'bun'
        )
      : undefined,
    path.join(
      os.homedir(),
      '.bun',
      'bin',
      process.platform === 'win32' ? 'bun.exe' : 'bun'
    ),
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'bun', 'bin', 'bun.exe')
      : undefined,
    '/opt/homebrew/bin/bun',
    '/usr/local/bin/bun',
  ];
  const executable = candidates.find((candidate): candidate is string =>
    Boolean(candidate && existsSync(candidate))
  );
  if (!executable) {
    throw new Error('Bun executable is unavailable for the task attention PTY runner');
  }
  return executable;
}

function redact(value: string, secrets: readonly string[]): string {
  return secrets.reduce(
    (result, secret) => (secret ? result.replaceAll(secret, '[REDACTED]') : result),
    value
  );
}

export function sanitizeTuiTaskAttentionError(
  value: unknown,
  secrets: readonly string[],
  seen = new WeakSet<object>()
): Error {
  if (!(value instanceof Error)) {
    return new Error(redact(String(value), secrets));
  }
  if (seen.has(value)) return new Error('Circular task attention error');
  seen.add(value);
  const cause =
    value.cause === undefined
      ? undefined
      : sanitizeTuiTaskAttentionError(value.cause, secrets, seen);
  if (value instanceof AggregateError) {
    return new AggregateError(
      Array.from(value.errors, (error) =>
        sanitizeTuiTaskAttentionError(error, secrets, seen)
      ),
      redact(value.message, secrets),
      cause ? { cause } : undefined
    );
  }
  const sanitized = new Error(
    redact(value.message, secrets),
    cause ? { cause } : undefined
  );
  sanitized.name = redact(value.name, secrets);
  return sanitized;
}

export async function awaitTuiTaskAttentionSettlement(
  operation: Promise<unknown>,
  timeoutMs: number
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation.then(
        () => true,
        () => true
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface TuiTaskAttentionSecretScanner {
  observe(chunk: string | Buffer): void;
  leakedSecretLabels(): string[];
}

export interface TuiTaskAttentionStreamCapture {
  append(chunk: string | Buffer): void;
  output(): string;
  leakedSecretLabels(): string[];
}

export function createTuiTaskAttentionSecretScanner(
  secrets: readonly string[]
): TuiTaskAttentionSecretScanner {
  const candidates = secrets
    .map((secret, index) => ({ secret, label: `secret-${index + 1}` }))
    .filter(({ secret }) => secret.length > 0);
  const found = new Set<string>();
  let carry = '';
  const carryLength = Math.max(0, ...candidates.map(({ secret }) => secret.length - 1));
  return {
    observe(chunk) {
      const text = `${carry}${chunk.toString()}`;
      for (const candidate of candidates) {
        if (text.includes(candidate.secret)) found.add(candidate.label);
      }
      carry = carryLength > 0 ? text.slice(-carryLength) : '';
    },
    leakedSecretLabels: () => [...found],
  };
}

export function createTuiTaskAttentionStreamCapture(
  secrets: readonly string[],
  maximumCharacters: number
): TuiTaskAttentionStreamCapture {
  const scanner = createTuiTaskAttentionSecretScanner(secrets);
  let boundedOutput = '';
  return {
    append(chunk) {
      scanner.observe(chunk);
      boundedOutput = `${boundedOutput}${chunk.toString()}`.slice(-maximumCharacters);
    },
    output: () => boundedOutput,
    leakedSecretLabels: () => scanner.leakedSecretLabels(),
  };
}

const CREDENTIAL_ENV_NAME =
  /(?:^|_)(?:API_?KEY|PRIVATE_KEY|AUTH_TOKEN|ACCESS_TOKEN|TOKEN|SECRET|PASSWORD|CREDENTIALS?)(?:_|$)/i;

export function createTuiTaskAttentionRunnerEnvironment(
  sourceEnvironment: Readonly<NodeJS.ProcessEnv>,
  overrides: Readonly<NodeJS.ProcessEnv>
): Record<string, string> {
  return Object.fromEntries(
    Object.entries({ ...sourceEnvironment, ...overrides }).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === 'string' && !CREDENTIAL_ENV_NAME.test(entry[0])
    )
  );
}

export function assertTuiTaskAttentionRunnerOutputSafe(
  stdout: string,
  stderr: string,
  secrets: readonly string[]
): void {
  const scanner = createTuiTaskAttentionSecretScanner(secrets);
  scanner.observe(stdout);
  scanner.observe(stderr);
  if (scanner.leakedSecretLabels().length > 0) {
    throw new Error('Task attention PTY runner output contains credentials');
  }
}

interface RunnerResult {
  stdout: string;
  stderr: string;
}

interface TuiTaskAttentionStageOutput {
  baseline: string;
  resume: string;
  cleared: string;
}

function parseStageOutput(value: unknown): TuiTaskAttentionStageOutput | undefined {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('baseline' in value) ||
    typeof value.baseline !== 'string' ||
    !('resume' in value) ||
    typeof value.resume !== 'string' ||
    !('cleared' in value) ||
    typeof value.cleared !== 'string'
  ) {
    return undefined;
  }
  return {
    baseline: value.baseline,
    resume: value.resume,
    cleared: value.cleared,
  };
}

function runnerExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForRunnerExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (runnerExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(false);
    }, timeoutMs);
    child.once('exit', onExit);
  });
}

function signalRunner(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to the direct child when the process group is already gone.
    }
  }
  child.kill(signal);
}

async function stopRunner(child: ChildProcess): Promise<void> {
  if (runnerExited(child)) return;
  signalRunner(child, 'SIGTERM');
  if (await waitForRunnerExit(child, 2_000)) return;
  signalRunner(child, 'SIGKILL');
  if (!(await waitForRunnerExit(child, 2_000))) {
    throw new Error('Task attention PTY runner remained alive after SIGKILL');
  }
}

export async function runTuiTaskAttentionPtyDriver(input: {
  workspace: string;
  storageRoot: string;
  home: string;
  sessionId: string;
  title: string;
  terminalContent: string;
  completeTask(): Promise<void>;
  completionTimeoutMs?: number;
  secrets?: readonly string[];
  timeoutMs?: number;
  onRunnerSpawn?: (pid: number) => void;
}): Promise<TuiTaskAttentionPtyEvidence> {
  const completionTimeoutMs = input.completionTimeoutMs ?? 30_000;
  if (
    !Number.isSafeInteger(completionTimeoutMs) ||
    completionTimeoutMs < MIN_COMPLETION_TIMEOUT_MS ||
    completionTimeoutMs > MAX_COMPLETION_TIMEOUT_MS
  ) {
    throw new Error('Task attention completion timeout is invalid');
  }
  const runner = path.resolve(import.meta.dirname, 'tuiTaskAttentionPtyRunner.ts');
  const cliEntry = path.resolve(import.meta.dirname, '../../dist/blade.js');
  const completionFile = path.join(
    input.storageRoot,
    `tui-task-attention-complete-${process.pid}-${Date.now()}`
  );
  const env = createTuiTaskAttentionRunnerEnvironment(process.env, {
    HOME: input.home,
    BLADE_STORAGE_ROOT: input.storageRoot,
    BLADE_AUTO_MEMORY: '0',
    BLADE_TELEMETRY_DISABLED: '1',
    TERM: 'xterm-256color',
    BLADE_TUI_ATTENTION_INPUT: Buffer.from(
      JSON.stringify({
        cliEntry,
        nodeExecutable: process.execPath,
        workspace: input.workspace,
        sessionId: input.sessionId,
        title: input.title,
        terminalContent: input.terminalContent,
        completionFile,
        completionTimeoutMs,
      })
    ).toString('base64'),
  });
  let runnerChild: ChildProcess | undefined;
  const secretScanner = createTuiTaskAttentionSecretScanner(input.secrets ?? []);
  const runnerResult = new Promise<RunnerResult>((resolve, reject) => {
    runnerChild = spawn(resolveBunExecutable(), [runner], {
      cwd: path.resolve(import.meta.dirname, '../..'),
      env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const child = runnerChild;
    if (child.pid) input.onRunnerSpawn?.(child.pid);
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (!runnerExited(child)) signalRunner(child, 'SIGKILL');
      const failure = error as Error & Partial<RunnerResult>;
      failure.stdout = stdout;
      failure.stderr = stderr;
      reject(failure);
    };
    const append = (current: string, chunk: Buffer | string): string => {
      const next = current + chunk.toString();
      if (Buffer.byteLength(next) > 64 * 1024) {
        fail(new Error('Task attention PTY runner exceeded its output budget'));
      }
      return next.slice(-64 * 1024);
    };
    child.stdout?.on('data', (chunk: Buffer | string) => {
      secretScanner.observe(chunk);
      stdout = append(stdout, chunk);
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      secretScanner.observe(chunk);
      stderr = append(stderr, chunk);
    });
    timeout = setTimeout(
      () => fail(new Error('Task attention PTY runner exceeded its deadline')),
      input.timeoutMs ?? 100_000
    );
    child.once('error', fail);
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const error = new Error(`runner exited code=${code} signal=${signal}`) as Error &
        Partial<RunnerResult>;
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    });
  });
  void runnerResult.catch(() => undefined);

  let result: RunnerResult;
  try {
    const deadline = Date.now() + 45_000;
    while (!existsSync(completionFile)) {
      if (Date.now() >= deadline) {
        throw new Error('Raw PTY did not persist the running task baseline');
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const completion = Promise.resolve().then(() => input.completeTask());
    void completion.catch(() => undefined);
    let completionTimer: ReturnType<typeof setTimeout> | undefined;
    const completionResult = await Promise.race([
      completion.then(
        () => ({ kind: 'completed' as const }),
        (error: unknown) => ({ kind: 'completion_failed' as const, error })
      ),
      runnerResult.then(
        (earlyResult) => ({ kind: 'runner_exited' as const, earlyResult }),
        (error: unknown) => ({ kind: 'runner_failed' as const, error })
      ),
      new Promise<{ kind: 'timed_out' }>((resolve) => {
        completionTimer = setTimeout(
          () => resolve({ kind: 'timed_out' }),
          Math.max(MIN_COMPLETION_TIMEOUT_MS, completionTimeoutMs - 5_000)
        );
      }),
    ]);
    if (completionTimer) clearTimeout(completionTimer);
    if (completionResult.kind === 'completion_failed') throw completionResult.error;
    if (completionResult.kind === 'runner_failed') throw completionResult.error;
    if (completionResult.kind === 'runner_exited') {
      throw new Error(
        `Task attention PTY runner exited before task completion: ${completionResult.earlyResult.stderr}`
      );
    }
    if (completionResult.kind === 'timed_out') {
      throw new Error('Task attention completion callback exceeded its deadline');
    }
    await writeFile(`${completionFile}.done`, 'completed\n', { mode: 0o600 });
    result = await runnerResult;
  } catch (error) {
    let cleanupError: unknown;
    if (runnerChild) {
      try {
        await stopRunner(runnerChild);
      } catch (cleanupFailure) {
        cleanupError = cleanupFailure;
      }
    }
    if (!runnerChild || runnerExited(runnerChild)) {
      await runnerResult.catch(() => undefined);
    } else {
      await awaitTuiTaskAttentionSettlement(runnerResult, RUNNER_SETTLE_TIMEOUT_MS);
    }
    const safeError = sanitizeTuiTaskAttentionError(error, input.secrets ?? []);
    const diagnostic = safeError.message.slice(-8_000);
    const safeCleanupError = cleanupError
      ? sanitizeTuiTaskAttentionError(cleanupError, input.secrets ?? [])
      : undefined;
    if (safeCleanupError) {
      throw new AggregateError(
        [safeError, safeCleanupError],
        `Task attention PTY runner and cleanup failed: ${diagnostic}`
      );
    }
    throw new Error(`Task attention PTY runner failed: ${diagnostic}`, {
      cause: safeError,
    });
  }

  const leakedSecrets = secretScanner.leakedSecretLabels();
  if (leakedSecrets.length > 0) {
    throw new Error(
      `Task attention PTY runner output contains credentials: ${leakedSecrets.join(', ')}`
    );
  }
  assertTuiTaskAttentionRunnerOutputSafe(
    result.stdout,
    result.stderr,
    input.secrets ?? []
  );
  if (result.stdout.length + result.stderr.length > MAX_EVIDENCE_CHARS) {
    throw new Error('Task attention PTY evidence exceeded its serialized budget');
  }
  const parsed = JSON.parse(String(result.stdout)) as Record<string, unknown>;
  const flags = [
    'success',
    'baselinePersisted',
    'firstMarkerAbsent',
    'newMarkerSeen',
    'exactSessionSelected',
    'terminalContentSeen',
    'markerCleared',
  ] as const;
  const incomplete: string[] = flags.filter((flag) => parsed[flag] !== true);
  const output = typeof parsed.output === 'string' ? parsed.output : '';
  const stageOutput = parseStageOutput(parsed.stageOutput);
  if (!stageOutput) incomplete.push('stageOutput');
  const allOutput = [
    output,
    result.stderr,
    stageOutput ? JSON.stringify(stageOutput) : '',
  ].join('\n');
  const faults = allOutput
    .split(/\r?\n/)
    .filter((line) => /\b(uncaught|panic|fatal)\b/i.test(line))
    .slice(-20);
  if (incomplete.length > 0 || leakedSecrets.length > 0 || faults.length > 0) {
    throw new Error(
      `Task attention PTY evidence is incomplete: ${redact(
        JSON.stringify({
          incomplete,
          faults,
          leakedSecrets,
          error: parsed.error,
          stderr: result.stderr.slice(-2_000),
          output: output.slice(-8_000),
        }),
        input.secrets ?? []
      )}`
    );
  }
  if (!stageOutput) throw new Error('Task attention PTY stage evidence is missing');
  return {
    success: true,
    baselinePersisted: true,
    firstMarkerAbsent: true,
    newMarkerSeen: true,
    exactSessionSelected: true,
    terminalContentSeen: true,
    markerCleared: true,
    faults,
    leakedSecrets,
    stageOutput,
    output,
  };
}
