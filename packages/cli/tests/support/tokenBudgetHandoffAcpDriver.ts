import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { isValidSessionId } from '../../src/context/storage/pathUtils.js';
import { TOKEN_BUDGET_HANDOFF_MESSAGE_ID_PREFIX } from '../../src/context/TokenBudgetHandoff.js';
import type { SessionEvent } from '../../src/context/types.js';
import {
  assertNoSecrets,
  findSessionTranscript,
  readSessionEvents,
} from '../integration/real-api/sessionForkTrajectoryHarness.js';
import type { TokenBudgetHandoffFixture } from '../integration/real-api/tokenBudgetHandoffFixture.js';
import {
  formatTokenBudgetTranscriptDiagnostic,
  type TokenBudgetHandoffSurfaceEvidence,
} from '../integration/real-api/tokenBudgetHandoffHarness.js';

const execFileAsync = promisify(execFile);
const MAX_EVIDENCE_CHARS = 64_000;
const ACP_TASK_TIMEOUT_MS = 270_000;
const ACP_LOAD_TIMEOUT_MS = 30_000;
const ACP_CLEANUP_RESERVE_MS = 10_000;
const ACP_CLEANUP_PROBE_SETUP_MS = 30_000;
const ACP_CLEANUP_PROBE_RESERVE_MS = 20_000;
const ACP_CLEANUP_PROBE_OPERATION_MS = 20_000;
const ACP_CLEANUP_PROBE_CLOSE_MS = 5_000;
const FINAL_MARKER_PATTERN = /^FINAL_OK_[A-Za-z0-9_]{16,64}$/;
const FORBIDDEN = [
  '<token-budget-handoff version="1">',
  'token_budget_handoff_recorded',
  TOKEN_BUDGET_HANDOFF_MESSAGE_ID_PREFIX,
  'Context rollover is approaching',
] as const;

export interface TokenBudgetHandoffAcpEvidence
  extends TokenBudgetHandoffSurfaceEvidence {
  success: true;
  stopReason: 'end_turn';
  hiddenUserChunkSeen: false;
  terminalCreationCount: number;
  terminalReleaseCount: number;
  activeTerminalCount: 0;
  releasedProcessesGone: true;
  taskRunnerExited: true;
  loadRunnerExited: true;
}

interface AcpRunnerEvidence {
  success: true;
  mode: 'task' | 'load';
  sessionId: string;
  stopReason: 'end_turn' | null;
  finalMarkerSeen: boolean;
  surfaceFinalPresent: boolean;
  surfaceFinalByteSizeBucket: 0 | '1_4096' | '4097_16384' | '16385_plus';
  surfaceFinalSha256Prefix: string | null;
  hiddenMarkerSeen: false;
  hiddenUserChunkSeen: false;
  terminalCreationCount: number;
  terminalReleaseCount: number;
  activeTerminalCount: 0;
  releasedProcessesGone: true;
  exited: true;
  faults: [];
}

const ACP_RUNNER_FAILURE_STAGES = [
  'initialize',
  'new_session',
  'set_mode',
  'prompt',
  'load',
  'cleanup',
  'evidence',
] as const;
const ACP_RUNNER_FAILURE_FAULTS = [
  'runner_failed',
  'timeout',
  'final_missing',
  'cleanup_incomplete',
  'hidden_material',
] as const;

type AcpRunnerFailureStage = (typeof ACP_RUNNER_FAILURE_STAGES)[number];
type AcpRunnerFailureFault = (typeof ACP_RUNNER_FAILURE_FAULTS)[number];
type ByteSizeBucket = 0 | '1_4096' | '4097_16384' | '16385_plus';

interface AcpRunnerExpectation {
  mode: 'task' | 'load';
  finalMarker: string;
  expectedSessionId?: string;
  secrets?: readonly string[];
}

export interface TokenBudgetAcpRunnerFailureEvidence {
  success: false;
  mode: 'task' | 'load';
  stage: AcpRunnerFailureStage;
  timedOut: boolean;
  promptAttempted: boolean;
  stopReason: 'end_turn' | null;
  finalMarkerSeen: boolean;
  hiddenMaterialSeen: boolean;
  surfaceFinalPresent: boolean;
  surfaceFinalByteSizeBucket: ByteSizeBucket;
  surfaceFinalSha256Prefix: string | null;
  terminalCreationCount: number;
  terminalReleaseCount: number;
  activeTerminalCount: number;
  releasedProcessesGone: boolean;
  cleanupComplete: boolean;
  exited: true;
  faults: AcpRunnerFailureFault[];
}

export interface TokenBudgetAcpCleanupProbeEvidence {
  timedOut: true;
  cancelled: true;
  closed: true;
  naturalExit: true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isByteSizeBucket(value: unknown): value is ByteSizeBucket {
  return [0, '1_4096', '4097_16384', '16385_plus'].includes(value as string | number);
}

function byteSizeBucket(text: string): ByteSizeBucket {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes === 0) return 0;
  if (bytes <= 4_096) return '1_4096';
  if (bytes <= 16_384) return '4097_16384';
  return '16385_plus';
}

function expectedFinalSurface(finalMarker: string): {
  bucket: ByteSizeBucket;
  sha256Prefix: string;
} {
  return {
    bucket: byteSizeBucket(finalMarker),
    sha256Prefix: createHash('sha256').update(finalMarker).digest('hex').slice(0, 12),
  };
}

export function resolveTokenBudgetAcpRunTimeouts(input: {
  stage: 'task' | 'load';
  deadlineAt: number;
  now?: number;
  cleanupReserveMs?: number;
}): { operationTimeoutMs: number; processTimeoutMs: number } {
  const now = input.now ?? Date.now();
  const cleanupReserveMs = input.cleanupReserveMs ?? ACP_CLEANUP_RESERVE_MS;
  if (
    !Number.isSafeInteger(input.deadlineAt) ||
    !Number.isSafeInteger(now) ||
    !Number.isSafeInteger(cleanupReserveMs) ||
    cleanupReserveMs <= 0
  ) {
    throw new Error('Token-budget ACP deadline is invalid');
  }
  const remainingMs = input.deadlineAt - now;
  const laterStageReserveMs = input.stage === 'task' ? ACP_LOAD_TIMEOUT_MS : 0;
  const operationTimeoutMs = Math.min(
    remainingMs - laterStageReserveMs - cleanupReserveMs,
    input.stage === 'task' ? ACP_TASK_TIMEOUT_MS : ACP_LOAD_TIMEOUT_MS
  );
  if (operationTimeoutMs <= 0) {
    return { operationTimeoutMs: 0, processTimeoutMs: 0 };
  }
  return {
    operationTimeoutMs,
    processTimeoutMs: Math.min(
      operationTimeoutMs + cleanupReserveMs,
      remainingMs - laterStageReserveMs
    ),
  };
}

export function resolveTokenBudgetAcpCleanupProbeTimeouts(): {
  setupTimeoutMs: number;
  promptTimeoutMs: number;
  processTimeoutMs: number;
} {
  return {
    setupTimeoutMs: ACP_CLEANUP_PROBE_SETUP_MS,
    promptTimeoutMs: ACP_CLEANUP_PROBE_OPERATION_MS,
    processTimeoutMs:
      ACP_CLEANUP_PROBE_SETUP_MS +
      ACP_CLEANUP_PROBE_OPERATION_MS +
      ACP_CLEANUP_PROBE_RESERVE_MS,
  };
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function parseCleanupProbe(stdout: string): TokenBudgetAcpCleanupProbeEvidence {
  if (stdout.length > 1_024) {
    throw new Error('Token-budget ACP cleanup probe evidence exceeded its budget');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error('Token-budget ACP cleanup probe evidence must be valid JSON');
  }
  if (
    JSON.stringify(parsed) !== stdout ||
    !isRecord(parsed) ||
    !exactKeys(parsed, [
      'cancelled',
      'closed',
      'naturalExit',
      'promptAttempted',
      'stage',
      'timedOut',
    ]) ||
    parsed.stage !== 'prompt' ||
    parsed.promptAttempted !== true ||
    parsed.timedOut !== true ||
    parsed.cancelled !== true ||
    parsed.closed !== true ||
    parsed.naturalExit !== true
  ) {
    throw new Error('Token-budget ACP cleanup probe evidence is incomplete');
  }
  return {
    timedOut: true,
    cancelled: true,
    closed: true,
    naturalExit: true,
  };
}

function buildAcpRunnerExecOptions(input: {
  env: Record<string, string>;
  processTimeoutMs: number;
}) {
  return {
    cwd: path.resolve(import.meta.dirname, '../..'),
    env: input.env,
    timeout: input.processTimeoutMs,
    maxBuffer: 1024 * 1024,
    killSignal: 'SIGKILL' as const,
  };
}

const ACP_RUNNER_KEY_ENV_PREFIXES = [
  'BLADE_MODEL_API_KEY_',
  'BLADE_REAL_API_PROVIDER_KEY_',
] as const;

export function buildTokenBudgetAcpRunnerEnvironment(input: {
  source: Readonly<Record<string, string | undefined>>;
  home: string;
  storageRoot: string;
  encodedInput: string;
  secrets: readonly string[];
}): Record<string, string> {
  const secrets = new Set(input.secrets.filter(Boolean));
  const projected: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.source)) {
    if (typeof value !== 'string') continue;
    const isHashedModelKey = ACP_RUNNER_KEY_ENV_PREFIXES.some((prefix) =>
      name.startsWith(prefix)
    );
    if (isHashedModelKey) {
      if (secrets.has(value)) projected[name] = value;
      continue;
    }
    if (name.endsWith('_API_KEY') || secrets.has(value)) {
      continue;
    }
    projected[name] = value;
  }
  return {
    ...projected,
    HOME: input.home,
    BLADE_STORAGE_ROOT: input.storageRoot,
    BLADE_AUTO_MEMORY: '0',
    BLADE_TELEMETRY_DISABLED: '1',
    TERM: 'xterm-256color',
    BLADE_TOKEN_BUDGET_ACP_INPUT: input.encodedInput,
  };
}

async function startCleanupProbeProvider(): Promise<{
  baseUrl: string;
  requestCount(): number;
  close(): Promise<void>;
}> {
  let requestCount = 0;
  const server = createServer((request, response) => {
    requestCount++;
    request.resume();
    response.on('error', () => undefined);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: 'http://127.0.0.1:' + String(address.port) + '/v1',
    requestCount: () => requestCount,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

function assertSafe(value: unknown, secrets: readonly string[]): void {
  try {
    assertNoSecrets(value, secrets);
  } catch (error) {
    throw new Error('Token-budget ACP evidence contains secret material', {
      cause: error,
    });
  }
  try {
    assertNoSecrets(value, FORBIDDEN);
  } catch (error) {
    throw new Error('Token-budget ACP evidence contains a hidden marker', {
      cause: error,
    });
  }
}

export function parseTokenBudgetAcpRunnerSuccess(
  stdout: string,
  expected: AcpRunnerExpectation
): AcpRunnerEvidence {
  if (Buffer.byteLength(stdout, 'utf8') > MAX_EVIDENCE_CHARS) {
    throw new Error('Token-budget ACP runner evidence exceeded its budget');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error('Token-budget ACP runner evidence must be valid JSON');
  }
  if (JSON.stringify(parsed) !== stdout) {
    throw new Error('Token-budget ACP runner evidence must use canonical JSON');
  }
  assertSafe(parsed, expected.secrets ?? []);
  const expectedSurface = expectedFinalSurface(expected.finalMarker);
  const surfaceMatchesExpectedFinal =
    isRecord(parsed) &&
    parsed.surfaceFinalPresent === true &&
    parsed.surfaceFinalByteSizeBucket === expectedSurface.bucket &&
    parsed.surfaceFinalSha256Prefix === expectedSurface.sha256Prefix;
  if (
    !isRecord(parsed) ||
    !exactKeys(parsed, [
      'activeTerminalCount',
      'exited',
      'faults',
      'finalMarkerSeen',
      'hiddenMarkerSeen',
      'hiddenUserChunkSeen',
      'mode',
      'releasedProcessesGone',
      'sessionId',
      'stopReason',
      'surfaceFinalByteSizeBucket',
      'surfaceFinalPresent',
      'surfaceFinalSha256Prefix',
      'success',
      'terminalCreationCount',
      'terminalReleaseCount',
    ]) ||
    parsed.success !== true ||
    parsed.mode !== expected.mode ||
    typeof parsed.sessionId !== 'string' ||
    !isValidSessionId(parsed.sessionId) ||
    (expected.expectedSessionId !== undefined &&
      parsed.sessionId !== expected.expectedSessionId) ||
    (parsed.stopReason !== 'end_turn' && parsed.stopReason !== null) ||
    typeof parsed.finalMarkerSeen !== 'boolean' ||
    typeof parsed.surfaceFinalPresent !== 'boolean' ||
    !isByteSizeBucket(parsed.surfaceFinalByteSizeBucket) ||
    (parsed.surfaceFinalPresent && parsed.surfaceFinalByteSizeBucket === 0) ||
    (parsed.surfaceFinalSha256Prefix !== null &&
      (typeof parsed.surfaceFinalSha256Prefix !== 'string' ||
        !/^[a-f0-9]{12}$/.test(parsed.surfaceFinalSha256Prefix))) ||
    (parsed.surfaceFinalPresent
      ? parsed.surfaceFinalSha256Prefix === null
      : parsed.surfaceFinalSha256Prefix !== null) ||
    parsed.finalMarkerSeen !==
      (parsed.mode === 'task' && surfaceMatchesExpectedFinal) ||
    (parsed.mode === 'load' &&
      (parsed.stopReason !== null ||
        parsed.finalMarkerSeen ||
        parsed.surfaceFinalPresent ||
        parsed.surfaceFinalByteSizeBucket !== 0 ||
        parsed.surfaceFinalSha256Prefix !== null)) ||
    parsed.hiddenMarkerSeen !== false ||
    parsed.hiddenUserChunkSeen !== false ||
    !isNonNegativeSafeInteger(parsed.terminalCreationCount) ||
    !isNonNegativeSafeInteger(parsed.terminalReleaseCount) ||
    parsed.terminalCreationCount !== parsed.terminalReleaseCount ||
    parsed.activeTerminalCount !== 0 ||
    parsed.releasedProcessesGone !== true ||
    parsed.exited !== true ||
    !Array.isArray(parsed.faults) ||
    parsed.faults.length !== 0
  ) {
    throw new Error('Token-budget ACP runner evidence is incomplete');
  }
  return {
    success: true,
    mode: expected.mode,
    sessionId: parsed.sessionId,
    stopReason: parsed.stopReason,
    finalMarkerSeen: parsed.finalMarkerSeen,
    surfaceFinalPresent: parsed.surfaceFinalPresent,
    surfaceFinalByteSizeBucket: parsed.surfaceFinalByteSizeBucket as
      | 0
      | '1_4096'
      | '4097_16384'
      | '16385_plus',
    surfaceFinalSha256Prefix: parsed.surfaceFinalSha256Prefix as string | null,
    hiddenMarkerSeen: false,
    hiddenUserChunkSeen: false,
    terminalCreationCount: parsed.terminalCreationCount,
    terminalReleaseCount: parsed.terminalReleaseCount,
    activeTerminalCount: 0,
    releasedProcessesGone: true,
    exited: true,
    faults: [],
  };
}

export function parseTokenBudgetAcpRunnerFailure(
  stdout: string,
  expected: AcpRunnerExpectation
): TokenBudgetAcpRunnerFailureEvidence {
  if (Buffer.byteLength(stdout, 'utf8') > MAX_EVIDENCE_CHARS) {
    throw new Error('Token-budget ACP runner failure evidence exceeded its budget');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error('Token-budget ACP runner failure evidence must be valid JSON');
  }
  if (JSON.stringify(parsed) !== stdout) {
    throw new Error('Token-budget ACP runner failure evidence must use canonical JSON');
  }
  assertSafe(parsed, expected.secrets ?? []);
  if (!isRecord(parsed)) {
    throw new Error('Token-budget ACP runner failure evidence is incomplete');
  }
  const faults = parsed.faults;
  const expectedSurface = expectedFinalSurface(expected.finalMarker);
  const surfaceMatchesExpectedFinal =
    parsed.surfaceFinalPresent === true &&
    parsed.surfaceFinalByteSizeBucket === expectedSurface.bucket &&
    parsed.surfaceFinalSha256Prefix === expectedSurface.sha256Prefix;
  const faultIndexes = Array.isArray(faults)
    ? faults.map((fault) =>
        ACP_RUNNER_FAILURE_FAULTS.indexOf(fault as AcpRunnerFailureFault)
      )
    : [];
  const structurallyClean =
    parsed.terminalCreationCount === parsed.terminalReleaseCount &&
    parsed.activeTerminalCount === 0 &&
    parsed.releasedProcessesGone === true;
  const promptAttemptedMatchesStage =
    expected.mode === 'load'
      ? parsed.promptAttempted === false
      : ['initialize', 'new_session', 'set_mode'].includes(parsed.stage as string)
        ? parsed.promptAttempted === false
        : ['evidence', 'cleanup'].includes(parsed.stage as string)
          ? parsed.promptAttempted === true
          : parsed.stage === 'prompt' &&
            (parsed.promptAttempted === true || parsed.timedOut === true);
  const stageMatchesMode =
    expected.mode === 'task'
      ? parsed.stage !== 'load'
      : !['new_session', 'set_mode', 'prompt'].includes(parsed.stage as string);
  if (
    !exactKeys(parsed, [
      'activeTerminalCount',
      'cleanupComplete',
      'exited',
      'faults',
      'finalMarkerSeen',
      'hiddenMaterialSeen',
      'mode',
      'promptAttempted',
      'releasedProcessesGone',
      'stage',
      'stopReason',
      'success',
      'surfaceFinalByteSizeBucket',
      'surfaceFinalPresent',
      'surfaceFinalSha256Prefix',
      'terminalCreationCount',
      'terminalReleaseCount',
      'timedOut',
    ]) ||
    parsed.success !== false ||
    parsed.mode !== expected.mode ||
    !ACP_RUNNER_FAILURE_STAGES.includes(parsed.stage as AcpRunnerFailureStage) ||
    !stageMatchesMode ||
    typeof parsed.timedOut !== 'boolean' ||
    typeof parsed.promptAttempted !== 'boolean' ||
    !promptAttemptedMatchesStage ||
    (parsed.stopReason !== 'end_turn' && parsed.stopReason !== null) ||
    typeof parsed.finalMarkerSeen !== 'boolean' ||
    typeof parsed.hiddenMaterialSeen !== 'boolean' ||
    typeof parsed.surfaceFinalPresent !== 'boolean' ||
    !isByteSizeBucket(parsed.surfaceFinalByteSizeBucket) ||
    (parsed.surfaceFinalPresent && parsed.surfaceFinalByteSizeBucket === 0) ||
    (parsed.surfaceFinalSha256Prefix !== null &&
      (typeof parsed.surfaceFinalSha256Prefix !== 'string' ||
        !/^[a-f0-9]{12}$/.test(parsed.surfaceFinalSha256Prefix))) ||
    (parsed.surfaceFinalPresent
      ? parsed.surfaceFinalSha256Prefix === null
      : parsed.surfaceFinalSha256Prefix !== null) ||
    parsed.finalMarkerSeen !==
      (parsed.promptAttempted && surfaceMatchesExpectedFinal) ||
    (!parsed.promptAttempted &&
      (parsed.stopReason !== null ||
        parsed.finalMarkerSeen ||
        parsed.surfaceFinalPresent ||
        parsed.surfaceFinalByteSizeBucket !== 0 ||
        parsed.surfaceFinalSha256Prefix !== null)) ||
    (parsed.stage === 'prompt' && parsed.stopReason !== null) ||
    (parsed.stopReason === 'end_turn' &&
      (expected.mode !== 'task' ||
        !['evidence', 'cleanup'].includes(parsed.stage as string))) ||
    !isNonNegativeSafeInteger(parsed.terminalCreationCount) ||
    !isNonNegativeSafeInteger(parsed.terminalReleaseCount) ||
    !isNonNegativeSafeInteger(parsed.activeTerminalCount) ||
    typeof parsed.releasedProcessesGone !== 'boolean' ||
    typeof parsed.cleanupComplete !== 'boolean' ||
    (parsed.cleanupComplete && !structurallyClean) ||
    parsed.exited !== true ||
    !Array.isArray(faults) ||
    faults.length === 0 ||
    faults.length > ACP_RUNNER_FAILURE_FAULTS.length ||
    faults[0] !== 'runner_failed' ||
    faultIndexes.some(
      (index, position) =>
        index < 0 || (position > 0 && index <= faultIndexes[position - 1])
    ) ||
    parsed.timedOut !== faults.includes('timeout') ||
    (parsed.timedOut && ['cleanup', 'evidence'].includes(parsed.stage as string)) ||
    faults.includes('final_missing') !==
      (expected.mode === 'task' && parsed.promptAttempted && !parsed.finalMarkerSeen) ||
    faults.includes('cleanup_incomplete') === parsed.cleanupComplete ||
    faults.includes('hidden_material') !== parsed.hiddenMaterialSeen ||
    (parsed.stage === 'cleanup' && parsed.cleanupComplete)
  ) {
    throw new Error('Token-budget ACP runner failure evidence is incomplete');
  }
  return {
    success: false,
    mode: expected.mode,
    stage: parsed.stage as AcpRunnerFailureStage,
    timedOut: parsed.timedOut,
    promptAttempted: parsed.promptAttempted,
    stopReason: parsed.stopReason,
    finalMarkerSeen: parsed.finalMarkerSeen,
    hiddenMaterialSeen: parsed.hiddenMaterialSeen,
    surfaceFinalPresent: parsed.surfaceFinalPresent,
    surfaceFinalByteSizeBucket: parsed.surfaceFinalByteSizeBucket,
    surfaceFinalSha256Prefix: parsed.surfaceFinalSha256Prefix,
    terminalCreationCount: parsed.terminalCreationCount,
    terminalReleaseCount: parsed.terminalReleaseCount,
    activeTerminalCount: parsed.activeTerminalCount,
    releasedProcessesGone: parsed.releasedProcessesGone,
    cleanupComplete: parsed.cleanupComplete,
    exited: true,
    faults: faults as AcpRunnerFailureFault[],
  };
}

function errorField(error: unknown, key: string): unknown {
  if ((typeof error !== 'object' && typeof error !== 'function') || error === null) {
    return undefined;
  }
  try {
    return Reflect.get(error, key);
  } catch {
    return undefined;
  }
}

function cleanupProbeEvidence(error: unknown): {
  stage: AcpRunnerFailureStage;
  promptAttempted: boolean;
  timedOut: boolean;
  cancelled: boolean;
  closed: boolean;
  naturalExit: boolean;
} | null {
  const stdout = errorField(error, 'stdout');
  if (typeof stdout !== 'string' || Buffer.byteLength(stdout, 'utf8') > 1_024) {
    return null;
  }
  try {
    const parsed = JSON.parse(stdout);
    if (
      JSON.stringify(parsed) !== stdout ||
      !isRecord(parsed) ||
      !exactKeys(parsed, [
        'cancelled',
        'closed',
        'naturalExit',
        'promptAttempted',
        'stage',
        'timedOut',
      ]) ||
      !ACP_RUNNER_FAILURE_STAGES.includes(parsed.stage as AcpRunnerFailureStage) ||
      typeof parsed.promptAttempted !== 'boolean' ||
      typeof parsed.timedOut !== 'boolean' ||
      typeof parsed.cancelled !== 'boolean' ||
      typeof parsed.closed !== 'boolean' ||
      typeof parsed.naturalExit !== 'boolean'
    ) {
      return null;
    }
    return {
      stage: parsed.stage as AcpRunnerFailureStage,
      promptAttempted: parsed.promptAttempted,
      timedOut: parsed.timedOut,
      cancelled: parsed.cancelled,
      closed: parsed.closed,
      naturalExit: parsed.naturalExit,
    };
  } catch {
    return null;
  }
}

export function describeTokenBudgetAcpCleanupProbeFailure(
  error: unknown,
  requestCount: number
): string {
  const prefix = 'Token-budget ACP cleanup probe failed; diagnostic=';
  const safeRequestCount =
    Number.isSafeInteger(requestCount) && requestCount >= 0 && requestCount <= 9
      ? String(requestCount)
      : 'other';
  const evidence = cleanupProbeEvidence(error);
  if (evidence) {
    return (
      prefix +
      JSON.stringify({ stage: 'runner', requestCount: safeRequestCount, evidence })
    );
  }
  const code = errorField(error, 'code');
  const killed = errorField(error, 'killed');
  const signal = errorField(error, 'signal');
  const exitKind =
    code === 'ETIMEDOUT' || killed === true
      ? 'timeout'
      : typeof signal === 'string' && signal.length > 0
        ? 'signal'
        : typeof code === 'number' && Number.isSafeInteger(code) && code !== 0
          ? 'nonzero'
          : 'unknown';
  return (
    prefix +
    JSON.stringify({
      stage: 'process',
      requestCount: safeRequestCount,
      exitKind,
    })
  );
}

export function describeTokenBudgetAcpCleanupProbeTeardownFailure(input: {
  providerCloseFailed: boolean;
  rootCleanupFailed: boolean;
}): string {
  return (
    'Token-budget ACP cleanup probe teardown failed; diagnostic=' +
    JSON.stringify(input)
  );
}

export function describeTokenBudgetAcpRunnerFailure(
  error: unknown,
  expected: AcpRunnerExpectation
): string {
  const prefix = 'Token-budget ACP runner failed; diagnostic=';
  const stdout = errorField(error, 'stdout');
  if (
    typeof stdout === 'string' &&
    Buffer.byteLength(stdout, 'utf8') <= MAX_EVIDENCE_CHARS
  ) {
    try {
      return (
        prefix + JSON.stringify(parseTokenBudgetAcpRunnerFailure(stdout, expected))
      );
    } catch {
      // Fall through to a fixed process-only diagnostic.
    }
  }
  const code = errorField(error, 'code');
  const killed = errorField(error, 'killed');
  const signal = errorField(error, 'signal');
  const exitKind =
    code === 'ETIMEDOUT' || killed === true
      ? 'timeout'
      : typeof signal === 'string' && signal.length > 0
        ? 'signal'
        : typeof code === 'number' && Number.isSafeInteger(code) && code !== 0
          ? 'nonzero'
          : 'unknown';
  return prefix + JSON.stringify({ stage: 'process', exitKind });
}

export function formatTokenBudgetAcpTaskFailureDiagnostic(input: {
  stopReason: 'end_turn' | null;
  surfaceFinalSeen: boolean;
  surfaceFinalPresent: boolean;
  surfaceFinalByteSizeBucket: 0 | '1_4096' | '4097_16384' | '16385_plus';
  surfaceFinalSha256Prefix: string | null;
  providerRequests: number;
  terminalCreationCount: number;
  terminalReleaseCount: number;
  activeTerminalCount: number;
  releasedProcessesGone: boolean;
  events: readonly SessionEvent[];
  transcriptAvailable?: boolean;
  expectedFinal: string;
}): string {
  const requestCount =
    Number.isSafeInteger(input.providerRequests) && input.providerRequests >= 0
      ? input.providerRequests <= 99
        ? String(input.providerRequests)
        : 'overflow'
      : 'invalid';
  const surfaceHash =
    input.surfaceFinalSha256Prefix &&
    /^[a-f0-9]{12}$/.test(input.surfaceFinalSha256Prefix)
      ? input.surfaceFinalSha256Prefix
      : 'none';
  const transcript = formatTokenBudgetTranscriptDiagnostic({
    events: input.events,
    expectedFinal: input.expectedFinal,
    surfaceFinalSeen: input.surfaceFinalSeen,
  });
  return (
    `stop_${input.stopReason ?? 'missing'}:` +
    `surface_final_${input.surfaceFinalSeen ? 1 : 0}:` +
    `surface_present_${input.surfaceFinalPresent ? 1 : 0}:` +
    `surface_bytes_${input.surfaceFinalByteSizeBucket}:` +
    `surface_sha_${surfaceHash}:` +
    `requests_${requestCount}:` +
    `terminals_${input.terminalCreationCount}_${input.terminalReleaseCount}_` +
    `${input.activeTerminalCount}:gone_${input.releasedProcessesGone ? 1 : 0}:` +
    `transcript_${input.transcriptAvailable === false ? 'unavailable' : 'read'}=` +
    transcript
  );
}

export function parseTokenBudgetHandoffAcpEvidence(
  stdout: string,
  secrets: readonly string[] = []
): TokenBudgetHandoffAcpEvidence {
  if (stdout.length > MAX_EVIDENCE_CHARS) {
    throw new Error('Token-budget ACP evidence exceeded its serialized budget');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error('Token-budget ACP evidence must be valid JSON');
  }
  if (JSON.stringify(parsed) !== stdout) {
    throw new Error('Token-budget ACP evidence must use canonical JSON');
  }
  assertSafe(parsed, secrets);
  const recovery = isRecord(parsed) && isRecord(parsed.recovery) ? parsed.recovery : {};
  if (
    !isRecord(parsed) ||
    !exactKeys(parsed, [
      'activeTerminalCount',
      'faults',
      'finalMarkerSeen',
      'hiddenMarkerSeen',
      'hiddenUserChunkSeen',
      'loadRunnerExited',
      'recovery',
      'releasedProcessesGone',
      'sessionId',
      'stopReason',
      'success',
      'surface',
      'taskRunnerExited',
      'terminalCreationCount',
      'terminalReleaseCount',
    ]) ||
    !exactKeys(recovery, [
      'completed',
      'kind',
      'providerRequestsAfter',
      'providerRequestsBefore',
    ]) ||
    parsed.success !== true ||
    parsed.surface !== 'acp' ||
    typeof parsed.sessionId !== 'string' ||
    !isValidSessionId(parsed.sessionId) ||
    parsed.finalMarkerSeen !== true ||
    parsed.hiddenMarkerSeen !== false ||
    parsed.stopReason !== 'end_turn' ||
    parsed.hiddenUserChunkSeen !== false ||
    !isNonNegativeSafeInteger(parsed.terminalCreationCount) ||
    parsed.terminalReleaseCount !== parsed.terminalCreationCount ||
    parsed.activeTerminalCount !== 0 ||
    parsed.releasedProcessesGone !== true ||
    parsed.taskRunnerExited !== true ||
    parsed.loadRunnerExited !== true ||
    !Array.isArray(parsed.faults) ||
    parsed.faults.length !== 0 ||
    recovery.kind !== 'acp_load' ||
    recovery.completed !== true ||
    !isNonNegativeSafeInteger(recovery.providerRequestsBefore) ||
    !isNonNegativeSafeInteger(recovery.providerRequestsAfter) ||
    recovery.providerRequestsBefore !== recovery.providerRequestsAfter
  ) {
    throw new Error('Token-budget ACP evidence is incomplete');
  }
  return {
    success: true,
    surface: 'acp',
    sessionId: parsed.sessionId,
    finalMarkerSeen: true,
    hiddenMarkerSeen: false,
    recovery: {
      kind: 'acp_load',
      completed: true,
      providerRequestsBefore: recovery.providerRequestsBefore,
      providerRequestsAfter: recovery.providerRequestsAfter,
    },
    faults: [],
    stopReason: 'end_turn',
    hiddenUserChunkSeen: false,
    terminalCreationCount: parsed.terminalCreationCount,
    terminalReleaseCount: parsed.terminalCreationCount,
    activeTerminalCount: 0,
    releasedProcessesGone: true,
    taskRunnerExited: true,
    loadRunnerExited: true,
  };
}

async function runMode(input: {
  mode: 'task' | 'load';
  workspace: string;
  home: string;
  storageRoot: string;
  sessionId?: string;
  prompt?: string;
  finalMarker: string;
  secrets: readonly string[];
  operationTimeoutMs: number;
  processTimeoutMs: number;
}): Promise<AcpRunnerEvidence> {
  const runner = path.resolve(import.meta.dirname, 'tokenBudgetHandoffAcpRunner.ts');
  const { operationTimeoutMs, processTimeoutMs, ...runnerInput } = input;
  const encoded = Buffer.from(
    JSON.stringify({ ...runnerInput, timeoutMs: operationTimeoutMs }),
    'utf8'
  ).toString('base64');
  const env = buildTokenBudgetAcpRunnerEnvironment({
    source: process.env,
    home: input.home,
    storageRoot: input.storageRoot,
    encodedInput: encoded,
    secrets: input.secrets,
  });
  try {
    const result = await execFileAsync(
      'bun',
      [runner],
      buildAcpRunnerExecOptions({ env, processTimeoutMs })
    );
    if (result.stderr !== '') throw new Error('runner stderr');
    return parseTokenBudgetAcpRunnerSuccess(result.stdout, {
      mode: input.mode,
      finalMarker: input.finalMarker,
      expectedSessionId: input.sessionId,
      secrets: input.secrets,
    });
  } catch (error) {
    throw new Error(
      describeTokenBudgetAcpRunnerFailure(error, {
        mode: input.mode,
        finalMarker: input.finalMarker,
        secrets: input.secrets,
      })
    );
  }
}

export async function runTokenBudgetAcpCleanupProbe(): Promise<TokenBudgetAcpCleanupProbeEvidence> {
  const timeouts = resolveTokenBudgetAcpCleanupProbeTimeouts();
  if (
    timeouts.setupTimeoutMs !== ACP_CLEANUP_PROBE_SETUP_MS ||
    timeouts.promptTimeoutMs !== ACP_CLEANUP_PROBE_OPERATION_MS ||
    timeouts.processTimeoutMs <=
      timeouts.setupTimeoutMs + timeouts.promptTimeoutMs + ACP_CLEANUP_PROBE_CLOSE_MS
  ) {
    throw new Error('Token-budget ACP cleanup probe timeout contract is invalid');
  }
  const runner = path.resolve(import.meta.dirname, 'tokenBudgetHandoffAcpRunner.ts');
  const probeRoot = await mkdtemp(path.join(os.tmpdir(), 'blade-acp-cleanup-probe-'));
  let provider: Awaited<ReturnType<typeof startCleanupProbeProvider>> | undefined;
  let evidence: TokenBudgetAcpCleanupProbeEvidence | undefined;
  let probeFailure: string | undefined;
  let providerCloseFailed = false;
  let rootCleanupFailed = false;
  try {
    provider = await startCleanupProbeProvider();
    const home = path.join(probeRoot, 'home');
    const storageRoot = path.join(probeRoot, 'storage');
    const workspace = path.join(probeRoot, 'workspace');
    await Promise.all([
      mkdir(path.join(home, '.blade'), { recursive: true }),
      mkdir(storageRoot, { recursive: true }),
      mkdir(workspace, { recursive: true }),
    ]);
    const probeConfig = {
      currentModelId: 'cleanup-probe-model',
      models: [
        {
          id: 'cleanup-probe-model',
          displayName: 'Cleanup Probe',
          provider: 'cleanup-probe-provider',
          model: 'cleanup-probe-model',
        },
      ],
      modelProviders: {
        'cleanup-probe-provider': {
          name: 'Cleanup Probe',
          baseUrl: provider.baseUrl,
          wireApi: 'openai-completions',
          apiKeyEnv: 'BLADE_CLEANUP_PROBE_API_KEY',
        },
      },
      permissionMode: 'yolo',
      hooks: { enabled: false },
      disableAllHooks: true,
      mcpServers: {},
    };
    await writeFile(
      path.join(home, '.blade', 'config.json'),
      JSON.stringify(probeConfig) + '\n',
      { mode: 0o600 }
    );
    const env = Object.fromEntries(
      Object.entries({
        PATH: process.env.PATH,
        TMPDIR: process.env.TMPDIR,
        LANG: process.env.LANG,
        LC_ALL: process.env.LC_ALL,
        TERM: 'xterm-256color',
        NODE_ENV: 'test',
        HOME: home,
        BLADE_STORAGE_ROOT: storageRoot,
        BLADE_AUTO_MEMORY: '0',
        BLADE_TELEMETRY_DISABLED: '1',
        BLADE_CLEANUP_PROBE_API_KEY: 'cleanup-probe-placeholder',
      }).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    );
    const result = await execFileAsync(
      'bun',
      [
        runner,
        '--timeout-cleanup-probe',
        String(timeouts.setupTimeoutMs),
        String(timeouts.promptTimeoutMs),
        workspace,
      ],
      buildAcpRunnerExecOptions({
        env,
        processTimeoutMs: timeouts.processTimeoutMs,
      })
    );
    if (Buffer.byteLength(result.stderr, 'utf8') > 64_000) {
      throw new Error('probe stderr budget');
    }
    if (provider.requestCount() !== 1) {
      throw new Error('probe request count');
    }
    evidence = parseCleanupProbe(result.stdout);
  } catch (error) {
    probeFailure = describeTokenBudgetAcpCleanupProbeFailure(
      error,
      provider?.requestCount() ?? 0
    );
  } finally {
    await provider?.close().catch(() => {
      providerCloseFailed = true;
    });
    await rm(probeRoot, { recursive: true, force: true }).catch(() => {
      rootCleanupFailed = true;
    });
  }
  if (providerCloseFailed || rootCleanupFailed) {
    throw new Error(
      describeTokenBudgetAcpCleanupProbeTeardownFailure({
        providerCloseFailed,
        rootCleanupFailed,
      })
    );
  }
  if (probeFailure || !evidence) {
    throw new Error(
      probeFailure ??
        describeTokenBudgetAcpCleanupProbeFailure(
          undefined,
          provider?.requestCount() ?? 0
        )
    );
  }
  return evidence;
}

export async function runTokenBudgetHandoffAcpDriver(input: {
  fixture: TokenBudgetHandoffFixture;
  sessionId?: string;
  home: string;
  storageRoot: string;
  providerRequestCount: () => number;
  secrets?: readonly string[];
  timeoutMs?: number;
}): Promise<TokenBudgetHandoffAcpEvidence> {
  if (
    !path.isAbsolute(input.fixture.workspace) ||
    !path.isAbsolute(input.home) ||
    !path.isAbsolute(input.storageRoot) ||
    !FINAL_MARKER_PATTERN.test(input.fixture.finalMarker) ||
    input.fixture.prompt.includes(input.fixture.finalMarker)
  ) {
    throw new Error('Token-budget ACP input contract is invalid');
  }
  const timeoutMs = input.timeoutMs ?? 270_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('Token-budget ACP timeout must be positive');
  }
  const deadlineAt = Date.now() + timeoutMs;
  if (!Number.isSafeInteger(deadlineAt)) {
    throw new Error('Token-budget ACP deadline is invalid');
  }
  const secrets = input.secrets ?? [];
  const common = {
    workspace: path.resolve(input.fixture.workspace),
    home: path.resolve(input.home),
    storageRoot: path.resolve(input.storageRoot),
    finalMarker: input.fixture.finalMarker,
    secrets,
  };
  const taskTimeouts = resolveTokenBudgetAcpRunTimeouts({
    stage: 'task',
    deadlineAt,
  });
  if (taskTimeouts.operationTimeoutMs === 0) {
    throw new Error('Token-budget ACP deadline exhausted before task runner');
  }
  const task = await runMode({
    ...common,
    mode: 'task',
    prompt: input.fixture.prompt,
    ...taskTimeouts,
  });
  const count = (): number => {
    try {
      const value = input.providerRequestCount();
      if (!isNonNegativeSafeInteger(value)) throw new Error('invalid');
      return value;
    } catch {
      throw new Error('Token-budget ACP Provider request count failed');
    }
  };
  const before = count();
  if (task.stopReason !== 'end_turn' || !task.finalMarkerSeen) {
    let events: SessionEvent[] = [];
    let transcriptAvailable = false;
    try {
      events = readSessionEvents(
        findSessionTranscript(input.storageRoot, task.sessionId)
      );
      transcriptAvailable = true;
    } catch {
      transcriptAvailable = false;
    }
    const diagnostic = formatTokenBudgetAcpTaskFailureDiagnostic({
      stopReason: task.stopReason,
      surfaceFinalSeen: task.finalMarkerSeen,
      surfaceFinalPresent: task.surfaceFinalPresent,
      surfaceFinalByteSizeBucket: task.surfaceFinalByteSizeBucket,
      surfaceFinalSha256Prefix: task.surfaceFinalSha256Prefix,
      providerRequests: before,
      terminalCreationCount: task.terminalCreationCount,
      terminalReleaseCount: task.terminalReleaseCount,
      activeTerminalCount: task.activeTerminalCount,
      releasedProcessesGone: task.releasedProcessesGone,
      events,
      transcriptAvailable,
      expectedFinal: input.fixture.finalMarker,
    });
    throw new Error(
      'Token-budget ACP task did not reach exact final response; diagnostic=' +
        diagnostic
    );
  }
  const loadTimeouts = resolveTokenBudgetAcpRunTimeouts({
    stage: 'load',
    deadlineAt,
  });
  if (loadTimeouts.operationTimeoutMs === 0) {
    throw new Error('Token-budget ACP deadline exhausted before load runner');
  }
  const load = await runMode({
    ...common,
    mode: 'load',
    sessionId: task.sessionId,
    ...loadTimeouts,
  });
  const after = count();
  if (load.stopReason !== null || before !== after) {
    throw new Error('Token-budget ACP load issued work or a Provider request');
  }
  return parseTokenBudgetHandoffAcpEvidence(
    JSON.stringify({
      success: true,
      surface: 'acp',
      sessionId: task.sessionId,
      finalMarkerSeen: true,
      hiddenMarkerSeen: false,
      recovery: {
        kind: 'acp_load',
        completed: true,
        providerRequestsBefore: before,
        providerRequestsAfter: after,
      },
      faults: [],
      stopReason: 'end_turn',
      hiddenUserChunkSeen: false,
      terminalCreationCount: task.terminalCreationCount + load.terminalCreationCount,
      terminalReleaseCount: task.terminalReleaseCount + load.terminalReleaseCount,
      activeTerminalCount: 0,
      releasedProcessesGone: true,
      taskRunnerExited: task.exited,
      loadRunnerExited: load.exited,
    }),
    secrets
  );
}
