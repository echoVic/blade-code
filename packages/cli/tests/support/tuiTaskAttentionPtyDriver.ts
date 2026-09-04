import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const MAX_EVIDENCE_CHARS = 24_000;

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
  await waitForRunnerExit(child, 2_000);
}

export async function runTuiTaskAttentionPtyDriver(input: {
  workspace: string;
  storageRoot: string;
  home: string;
  sessionId: string;
  title: string;
  terminalContent: string;
  completeTask(): Promise<void>;
  secrets?: readonly string[];
  timeoutMs?: number;
}): Promise<TuiTaskAttentionPtyEvidence> {
  const runner = path.resolve(import.meta.dirname, 'tuiTaskAttentionPtyRunner.ts');
  const cliEntry = path.resolve(import.meta.dirname, '../../dist/blade.js');
  const completionFile = path.join(
    input.storageRoot,
    `tui-task-attention-complete-${process.pid}-${Date.now()}`
  );
  const env = Object.fromEntries(
    Object.entries({
      ...process.env,
      HOME: input.home,
      BLADE_STORAGE_ROOT: input.storageRoot,
      BLADE_AUTO_MEMORY: '0',
      BLADE_TELEMETRY_DISABLED: '1',
      TERM: 'xterm-256color',
      BLADE_TUI_ATTENTION_INPUT: Buffer.from(
        JSON.stringify({
          cliEntry,
          workspace: input.workspace,
          sessionId: input.sessionId,
          title: input.title,
          terminalContent: input.terminalContent,
          completionFile,
        })
      ).toString('base64'),
    }).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  );
  let runnerChild: ChildProcess | undefined;
  const runnerResult = new Promise<RunnerResult>((resolve, reject) => {
    runnerChild = spawn(resolveBunExecutable(), [runner], {
      cwd: path.resolve(import.meta.dirname, '../..'),
      env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const child = runnerChild;
    let stdout = '';
    let stderr = '';
    let failure: Error | undefined;
    const fail = (error: Error) => {
      failure ??= error;
      if (!runnerExited(child)) signalRunner(child, 'SIGKILL');
    };
    const append = (current: string, chunk: Buffer | string): string => {
      const next = current + chunk.toString();
      if (Buffer.byteLength(next) > 64 * 1024) {
        fail(new Error('Task attention PTY runner exceeded its output budget'));
      }
      return next.slice(-64 * 1024);
    };
    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout = append(stdout, chunk);
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr = append(stderr, chunk);
    });
    const timeout = setTimeout(
      () => fail(new Error('Task attention PTY runner exceeded its deadline')),
      input.timeoutMs ?? 100_000
    );
    child.once('error', fail);
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      if (!failure && code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const error = (failure ??
        new Error(`runner exited code=${code} signal=${signal}`)) as Error &
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
    await input.completeTask();
    await writeFile(`${completionFile}.done`, 'completed\n', { mode: 0o600 });
    result = await runnerResult;
  } catch (error) {
    if (runnerChild) await stopRunner(runnerChild);
    await runnerResult.catch(() => undefined);
    const failure = error as Error & { stdout?: string; stderr?: string };
    const diagnostic = redact(
      `${failure.stdout ?? ''}\n${failure.stderr ?? ''}\n${failure.message}`,
      input.secrets ?? []
    ).slice(-8_000);
    throw new Error(`Task attention PTY runner failed: ${diagnostic}`);
  }

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
  const leakedSecrets = (input.secrets ?? []).flatMap((secret, index) =>
    secret && allOutput.includes(secret) ? [`secret-${index + 1}`] : []
  );
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
