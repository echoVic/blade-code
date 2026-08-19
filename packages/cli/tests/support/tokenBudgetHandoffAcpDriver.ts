import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { isValidSessionId } from '../../src/context/storage/pathUtils.js';
import { TOKEN_BUDGET_HANDOFF_MESSAGE_ID_PREFIX } from '../../src/context/TokenBudgetHandoff.js';
import { assertNoSecrets } from '../integration/real-api/sessionForkTrajectoryHarness.js';
import type { TokenBudgetHandoffFixture } from '../integration/real-api/tokenBudgetHandoffFixture.js';
import type { TokenBudgetHandoffSurfaceEvidence } from '../integration/real-api/tokenBudgetHandoffHarness.js';

const execFileAsync = promisify(execFile);
const MAX_EVIDENCE_CHARS = 64_000;
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
  hiddenMarkerSeen: false;
  hiddenUserChunkSeen: false;
  terminalCreationCount: number;
  terminalReleaseCount: number;
  activeTerminalCount: 0;
  releasedProcessesGone: true;
  exited: true;
  faults: [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
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

function parseRunner(
  stdout: string,
  mode: AcpRunnerEvidence['mode'],
  expectedSessionId: string | undefined,
  secrets: readonly string[]
): AcpRunnerEvidence {
  if (stdout.length > MAX_EVIDENCE_CHARS) {
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
  assertSafe(parsed, secrets);
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
      'success',
      'terminalCreationCount',
      'terminalReleaseCount',
    ]) ||
    parsed.success !== true ||
    parsed.mode !== mode ||
    typeof parsed.sessionId !== 'string' ||
    !isValidSessionId(parsed.sessionId) ||
    (expectedSessionId !== undefined && parsed.sessionId !== expectedSessionId) ||
    (parsed.stopReason !== 'end_turn' && parsed.stopReason !== null) ||
    typeof parsed.finalMarkerSeen !== 'boolean' ||
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
    mode,
    sessionId: parsed.sessionId,
    stopReason: parsed.stopReason,
    finalMarkerSeen: parsed.finalMarkerSeen,
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
  timeoutMs: number;
}): Promise<AcpRunnerEvidence> {
  const runner = path.resolve(import.meta.dirname, 'tokenBudgetHandoffAcpRunner.ts');
  const encoded = Buffer.from(JSON.stringify(input), 'utf8').toString('base64');
  const env = Object.fromEntries(
    Object.entries({
      ...process.env,
      HOME: input.home,
      BLADE_STORAGE_ROOT: input.storageRoot,
      BLADE_AUTO_MEMORY: '0',
      BLADE_TELEMETRY_DISABLED: '1',
      TERM: 'xterm-256color',
      BLADE_TOKEN_BUDGET_ACP_INPUT: encoded,
    }).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  );
  try {
    const result = await execFileAsync('bun', [runner], {
      cwd: path.resolve(import.meta.dirname, '../..'),
      env,
      timeout: input.timeoutMs,
      maxBuffer: 1024 * 1024,
      killSignal: 'SIGKILL',
    });
    if (result.stderr !== '') throw new Error('runner stderr');
    return parseRunner(result.stdout, input.mode, input.sessionId, input.secrets);
  } catch {
    throw new Error('Token-budget ACP runner failed');
  }
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
  const secrets = input.secrets ?? [];
  const common = {
    workspace: path.resolve(input.fixture.workspace),
    home: path.resolve(input.home),
    storageRoot: path.resolve(input.storageRoot),
    finalMarker: input.fixture.finalMarker,
    secrets,
    timeoutMs,
  };
  const task = await runMode({
    ...common,
    mode: 'task',
    prompt: input.fixture.prompt,
  });
  if (task.stopReason !== 'end_turn' || !task.finalMarkerSeen) {
    throw new Error('Token-budget ACP task did not reach exact final response');
  }
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
  const load = await runMode({
    ...common,
    mode: 'load',
    sessionId: task.sessionId,
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
