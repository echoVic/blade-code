import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createTuiTaskAttentionSecretScanner } from './tuiTaskAttentionPtyDriver.js';

const MAX_RUNNER_OUTPUT_BYTES = 96 * 1024;
const CREDENTIAL_ENV_NAME =
  /(?:^|_)(?:API_?KEY|PRIVATE_KEY|AUTH_TOKEN|ACCESS_TOKEN|TOKEN|SECRET|PASSWORD|CREDENTIALS?)(?:_|$)/i;

export const FOLLOW_UP_QUEUE_PTY_USES_PRODUCTION_DIST = true;

export interface FollowUpQueuePtyEvidence {
  success: true;
  panelOpened: true;
  reordered: true;
  deleted: true;
  resized: true;
  reopened: true;
  finalMarkerSeen: true;
  cleanupComplete: true;
  leakedSecrets: string[];
  output: string;
}

interface RunnerResult {
  stdout: string;
  stderr: string;
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
  if (!executable) throw new Error('Bun is unavailable for the follow-up PTY runner');
  return executable;
}

function waitForPath(filePath: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (existsSync(filePath)) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - startedAt >= timeoutMs) {
        clearInterval(timer);
        reject(
          new Error(`Timed out waiting for PTY control file ${path.basename(filePath)}`)
        );
      }
    }, 25);
  });
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
      // Fall back to the direct child when the process group has already exited.
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
    throw new Error('Follow-up PTY runner remained alive after SIGKILL');
  }
}

function parseEvidence(
  stdout: string,
  stderr: string,
  secrets: readonly string[]
): FollowUpQueuePtyEvidence {
  const leakedSecrets = secrets.flatMap((secret, index) =>
    secret && `${stdout}\n${stderr}`.includes(secret) ? [`secret-${index + 1}`] : []
  );
  if (leakedSecrets.length > 0) {
    throw new Error('Follow-up PTY runner output contained a credential');
  }
  const parsed = JSON.parse(stdout) as Record<string, unknown>;
  const required = [
    'success',
    'panelOpened',
    'reordered',
    'deleted',
    'resized',
    'reopened',
    'finalMarkerSeen',
    'cleanupComplete',
  ] as const;
  const missing = required.filter((field) => parsed[field] !== true);
  if (missing.length > 0 || typeof parsed.output !== 'string') {
    throw new Error(
      `Follow-up PTY evidence is incomplete (${missing.join(', ')}): ${String(
        parsed.error ?? stderr
      ).slice(0, 2_000)}`
    );
  }
  return {
    success: true,
    panelOpened: true,
    reordered: true,
    deleted: true,
    resized: true,
    reopened: true,
    finalMarkerSeen: true,
    cleanupComplete: true,
    leakedSecrets: [],
    output: parsed.output,
  };
}

export async function runFollowUpQueuePtyDriver(input: {
  workspace: string;
  storageRoot: string;
  home: string;
  sessionId: string;
  primaryPrompt: string;
  firstMarker: string;
  deletedMarker: string;
  movedMarker: string;
  expectedOutput: string;
  providerApiKey: string;
  waitForProviderHold(): Promise<void>;
  releaseProvider(): void;
  secrets?: readonly string[];
  timeoutMs?: number;
}): Promise<FollowUpQueuePtyEvidence> {
  const controlRoot = path.join(
    input.storageRoot,
    `follow-up-pty-${process.pid}-${randomUUID()}`
  );
  const activeFile = path.join(controlRoot, 'active');
  const mutatedFile = path.join(controlRoot, 'mutated');
  const releasedFile = path.join(controlRoot, 'released');
  await mkdir(controlRoot, { recursive: true, mode: 0o700 });
  const runnerInput = {
    cliEntry: path.resolve(import.meta.dirname, '../../dist/blade.js'),
    workspace: input.workspace,
    sessionId: input.sessionId,
    primaryPrompt: input.primaryPrompt,
    firstMarker: input.firstMarker,
    deletedMarker: input.deletedMarker,
    movedMarker: input.movedMarker,
    expectedOutput: input.expectedOutput,
    activeFile,
    mutatedFile,
    releasedFile,
  };
  const env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] =>
          typeof entry[1] === 'string' && !CREDENTIAL_ENV_NAME.test(entry[0])
      )
    ),
    HOME: input.home,
    BLADE_STORAGE_ROOT: input.storageRoot,
    BLADE_AUTO_MEMORY: '0',
    BLADE_TELEMETRY_DISABLED: '1',
    BLADE_ALLOW_ROOT: '1',
    BLADE_API_KEY: input.providerApiKey,
    TERM: 'xterm-256color',
    BLADE_FOLLOW_UP_PTY_INPUT: Buffer.from(
      JSON.stringify(runnerInput),
      'utf8'
    ).toString('base64'),
  };
  const runner = path.resolve(import.meta.dirname, 'followUpQueuePtyRunner.ts');
  const child = spawn(resolveBunExecutable(), [runner], {
    cwd: path.resolve(import.meta.dirname, '../..'),
    env,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  const scanner = createTuiTaskAttentionSecretScanner([
    input.providerApiKey,
    ...(input.secrets ?? []),
  ]);
  const result = new Promise<RunnerResult>((resolve, reject) => {
    const append = (current: string, chunk: Buffer | string) => {
      const next = current + chunk.toString();
      if (Buffer.byteLength(next) > MAX_RUNNER_OUTPUT_BYTES) {
        reject(new Error('Follow-up PTY runner exceeded its output budget'));
      }
      return next.slice(-MAX_RUNNER_OUTPUT_BYTES);
    };
    child.stdout?.on('data', (chunk: Buffer | string) => {
      scanner.observe(chunk);
      stdout = append(stdout, chunk);
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      scanner.observe(chunk);
      stderr = append(stderr, chunk);
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`runner exited code=${code} signal=${signal}`));
    });
  });
  void result.catch(() => undefined);

  const timeoutMs = input.timeoutMs ?? 120_000;
  let released = false;
  try {
    await Promise.race([
      input.waitForProviderHold(),
      result.then(() => {
        throw new Error('Follow-up PTY runner exited before Provider hold');
      }),
    ]);
    await writeFile(activeFile, 'active\n', { mode: 0o600 });
    await Promise.race([
      waitForPath(mutatedFile, Math.min(timeoutMs, 60_000)),
      result.then(() => {
        throw new Error('Follow-up PTY runner exited before queue mutation');
      }),
    ]);
    input.releaseProvider();
    released = true;
    await writeFile(releasedFile, 'released\n', { mode: 0o600 });
    const completed = await Promise.race([
      result,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Follow-up PTY runner timed out')), timeoutMs)
      ),
    ]);
    if (scanner.leakedSecretLabels().length > 0) {
      throw new Error('Follow-up PTY runner output contained a credential');
    }
    return parseEvidence(completed.stdout, completed.stderr, [
      input.providerApiKey,
      ...(input.secrets ?? []),
    ]);
  } catch (error) {
    const detail = `${stdout}\n${stderr}`;
    const redacted = [input.providerApiKey, ...(input.secrets ?? [])].reduce(
      (value, secret) => (secret ? value.replaceAll(secret, '[REDACTED]') : value),
      detail
    );
    let runnerSummary = '';
    try {
      const parsed = JSON.parse(stdout) as { error?: unknown; queuedTexts?: unknown };
      runnerSummary = `; runner=${JSON.stringify({
        error: parsed.error,
        queuedTexts: parsed.queuedTexts,
      })}`;
    } catch {
      runnerSummary = '';
    }
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}${runnerSummary}\n${redacted.slice(
        -8_000
      )}`
    );
  } finally {
    if (!released) input.releaseProvider();
    await stopRunner(child).catch(() => undefined);
    await rm(controlRoot, { recursive: true, force: true });
  }
}
