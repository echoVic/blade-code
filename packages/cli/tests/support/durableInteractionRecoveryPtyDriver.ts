import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createSplitPtyMarkerInstruction } from './foregroundBoundedOutputPtyDriver.js';

const execFileAsync = promisify(execFile);
const MAX_SERIALIZED_EVIDENCE_BYTES = 32 * 1024;

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
    throw new Error(
      'Bun executable is unavailable for the durable interaction PTY runner'
    );
  }
  return executable;
}

export interface DurableInteractionRecoveryPtyEvidence {
  success: true;
  sessionId: string;
  questionVisible: true;
  canaryVisible: true;
  reviewVisible: true;
  finalMarkerSeen: true;
  secretSeen: false;
  interactionRequested: 1;
  interactionResponded: 1;
  interactionRecovered: 1;
  writeCalls: 1;
  writeResults: 1;
  inboxMissing: true;
  targetSha256: string;
  exitCode: 0;
  exitSignal: null;
  termFallbackUsed: false;
  killFallbackUsed: false;
  output: string;
}

export interface DurableInteractionRecoveryPtyInput {
  workspace: string;
  storageRoot: string;
  home: string;
  sessionId: string;
  requestId: string;
  target: string;
  expectedContent: string;
  finalMarker: string;
  secret: string;
  timeoutMs?: number;
}

export function createDurableInteractionRecoveryPtyFinalInstruction(
  finalMarker: string
): string {
  return createSplitPtyMarkerInstruction(finalMarker);
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function parseDurableInteractionRecoveryPtyEvidence(
  stdout: string,
  secret: string,
  expectedContent: string
): DurableInteractionRecoveryPtyEvidence {
  if (Buffer.byteLength(stdout, 'utf8') > MAX_SERIALIZED_EVIDENCE_BYTES) {
    throw new Error('Durable interaction PTY evidence exceeded its serialized budget');
  }
  const parsed = JSON.parse(stdout) as Record<string, unknown>;
  if (secret && stdout.includes(secret)) {
    throw new Error('Durable interaction PTY evidence contains provider credentials');
  }
  const expectedKeys = [
    'canaryVisible',
    'exitCode',
    'exitSignal',
    'finalMarkerSeen',
    'inboxMissing',
    'interactionRecovered',
    'interactionRequested',
    'interactionResponded',
    'killFallbackUsed',
    'output',
    'questionVisible',
    'reviewVisible',
    'secretSeen',
    'sessionId',
    'success',
    'targetSha256',
    'termFallbackUsed',
    'writeCalls',
    'writeResults',
  ];
  if (
    Object.keys(parsed).sort().join('\0') !== expectedKeys.join('\0') ||
    parsed.success !== true ||
    !isNonemptyString(parsed.sessionId) ||
    parsed.questionVisible !== true ||
    parsed.canaryVisible !== true ||
    parsed.reviewVisible !== true ||
    parsed.finalMarkerSeen !== true ||
    parsed.secretSeen !== false ||
    parsed.interactionRequested !== 1 ||
    parsed.interactionResponded !== 1 ||
    parsed.interactionRecovered !== 1 ||
    parsed.writeCalls !== 1 ||
    parsed.writeResults !== 1 ||
    parsed.inboxMissing !== true ||
    parsed.exitCode !== 0 ||
    parsed.exitSignal !== null ||
    parsed.termFallbackUsed !== false ||
    parsed.killFallbackUsed !== false ||
    !/^[a-f0-9]{64}$/.test(String(parsed.targetSha256 ?? '')) ||
    typeof parsed.output !== 'string'
  ) {
    throw new Error(
      `Durable interaction PTY evidence is incomplete: ${String(
        parsed.error ?? 'unknown'
      )}`
    );
  }
  const expectedSha256 = createHash('sha256').update(expectedContent).digest('hex');
  if (parsed.targetSha256 !== expectedSha256) {
    throw new Error('Durable interaction PTY target digest mismatch');
  }
  return parsed as unknown as DurableInteractionRecoveryPtyEvidence;
}

export async function runDurableInteractionRecoveryPtyDriver(
  input: DurableInteractionRecoveryPtyInput
): Promise<DurableInteractionRecoveryPtyEvidence> {
  if (!input.secret) {
    throw new Error('Durable interaction PTY qualification requires a provider secret');
  }
  const runner = path.resolve(
    import.meta.dirname,
    'durableInteractionRecoveryPtyRunner.ts'
  );
  const cliEntry = path.resolve(import.meta.dirname, '../../dist/blade.js');
  const { timeoutMs: _timeoutMs, ...runnerInput } = input;
  const outerTimeoutMs = input.timeoutMs ?? 300_000;
  const runnerTimeoutMs = Math.max(1_000, outerTimeoutMs - 15_000);
  const encodedInput = Buffer.from(
    JSON.stringify({ ...runnerInput, cliEntry, runnerTimeoutMs }),
    'utf8'
  ).toString('base64');
  const env = Object.fromEntries(
    Object.entries({
      ...process.env,
      HOME: input.home,
      BLADE_STORAGE_ROOT: input.storageRoot,
      BLADE_AUTO_MEMORY: '0',
      BLADE_TELEMETRY_DISABLED: '1',
      TERM: 'xterm-256color',
      BLADE_DURABLE_INTERACTION_PTY_INPUT: encodedInput,
    }).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  );

  let result: Awaited<ReturnType<typeof execFileAsync>>;
  try {
    result = await execFileAsync(resolveBunExecutable(), [runner], {
      cwd: path.resolve(import.meta.dirname, '../..'),
      env,
      timeout: outerTimeoutMs,
      maxBuffer: 64 * 1024,
      killSignal: 'SIGTERM',
    });
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string };
    const failureStdout = String(failure.stdout ?? '');
    if (failureStdout.includes(input.secret)) {
      throw new Error('Durable interaction PTY failure evidence contains credentials');
    }
    const safeFailure = parseSafeFailureEvidence(failureStdout);
    throw new Error(
      safeFailure
        ? `Durable interaction PTY failed at ${safeFailure.stage} (${safeFailure.code})`
        : 'Durable interaction PTY runner failed without safe evidence'
    );
  }

  const evidence = parseDurableInteractionRecoveryPtyEvidence(
    String(result.stdout),
    input.secret,
    input.expectedContent
  );
  if (evidence.sessionId !== input.sessionId) {
    throw new Error('Durable interaction PTY evidence belongs to another Session');
  }
  return evidence;
}

interface SafeFailureEvidence {
  success: false;
  stage: string;
  code: string;
  timedOut: boolean;
  secretSeen: boolean;
  termFallbackUsed: boolean;
  killFallbackUsed: boolean;
}

const SAFE_FAILURE_STAGES = new Set([
  'input',
  'seed',
  'spawn',
  'question',
  'review',
  'completion',
  'shutdown',
]);
const SAFE_FAILURE_CODES = new Set([
  'invalid_input',
  'seed_invalid',
  'spawn_failed',
  'timeout',
  'qualification_failed',
  'shutdown_failed',
]);

function parseSafeFailureEvidence(stdout: string): SafeFailureEvidence | undefined {
  if (Buffer.byteLength(stdout, 'utf8') > MAX_SERIALIZED_EVIDENCE_BYTES)
    return undefined;
  try {
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    const keys = [
      'code',
      'killFallbackUsed',
      'secretSeen',
      'stage',
      'success',
      'termFallbackUsed',
      'timedOut',
    ];
    if (
      Object.keys(parsed).sort().join('\0') !== keys.join('\0') ||
      parsed.success !== false ||
      !isNonemptyString(parsed.stage) ||
      !SAFE_FAILURE_STAGES.has(parsed.stage) ||
      !isNonemptyString(parsed.code) ||
      !SAFE_FAILURE_CODES.has(parsed.code) ||
      typeof parsed.timedOut !== 'boolean' ||
      typeof parsed.secretSeen !== 'boolean' ||
      typeof parsed.termFallbackUsed !== 'boolean' ||
      typeof parsed.killFallbackUsed !== 'boolean'
    ) {
      return undefined;
    }
    return parsed as unknown as SafeFailureEvidence;
  } catch {
    return undefined;
  }
}
