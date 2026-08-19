import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { isValidSessionId } from '../../src/context/storage/pathUtils.js';
import { TOKEN_BUDGET_HANDOFF_MESSAGE_ID_PREFIX } from '../../src/context/TokenBudgetHandoff.js';
import { assertNoSecrets } from '../integration/real-api/sessionForkTrajectoryHarness.js';
import type { TokenBudgetHandoffFixture } from '../integration/real-api/tokenBudgetHandoffFixture.js';
import type { TokenBudgetHandoffSurfaceEvidence } from '../integration/real-api/tokenBudgetHandoffHarness.js';

const execFileAsync = promisify(execFile);
const MAX_PTY_EVIDENCE_CHARS = 64_000;
const FINAL_MARKER_PATTERN = /^FINAL_OK_[A-Za-z0-9_]{16,64}$/;
const FORBIDDEN = [
  '<token-budget-handoff version="1">',
  'token_budget_handoff_recorded',
  TOKEN_BUDGET_HANDOFF_MESSAGE_ID_PREFIX,
  'Context rollover is approaching',
] as const;

export interface TokenBudgetHandoffPtyEvidence
  extends TokenBudgetHandoffSurfaceEvidence {
  success: true;
  composerReady: true;
  bracketedPasteAccepted: true;
  taskExited: true;
  resumeExited: true;
  processGone: true;
  resumeSubmittedInput: false;
  output: string;
}

interface PtyRunnerEvidence {
  success: true;
  mode: 'task' | 'resume';
  sessionId: string;
  finalMarkerSeen: true;
  hiddenMarkerSeen: false;
  composerReady: true;
  bracketedPasteAccepted: boolean;
  submittedInput: boolean;
  exited: true;
  processGone: true;
  output: string;
  faults: [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[]
): boolean {
  return (
    Object.keys(value).length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}

function parseRunnerEvidence(
  stdout: string,
  expectedMode: PtyRunnerEvidence['mode'],
  expectedSessionId: string,
  secrets: readonly string[]
): PtyRunnerEvidence {
  if (stdout.length > MAX_PTY_EVIDENCE_CHARS) {
    throw new Error('Token-budget PTY runner evidence exceeded its budget');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error('Token-budget PTY runner evidence must be valid JSON');
  }
  if (JSON.stringify(parsed) !== stdout) {
    throw new Error('Token-budget PTY runner evidence must use canonical JSON');
  }
  try {
    assertNoSecrets(parsed, secrets);
  } catch (error) {
    throw new Error('Token-budget PTY evidence contains secret material', {
      cause: error,
    });
  }
  try {
    assertNoSecrets(parsed, FORBIDDEN);
  } catch (error) {
    throw new Error('Token-budget PTY evidence contains a hidden marker', {
      cause: error,
    });
  }
  if (
    !isRecord(parsed) ||
    !hasExactKeys(parsed, [
      'bracketedPasteAccepted',
      'composerReady',
      'exited',
      'faults',
      'finalMarkerSeen',
      'hiddenMarkerSeen',
      'mode',
      'output',
      'processGone',
      'sessionId',
      'submittedInput',
      'success',
    ]) ||
    parsed.success !== true ||
    parsed.mode !== expectedMode ||
    typeof parsed.sessionId !== 'string' ||
    !isValidSessionId(parsed.sessionId) ||
    parsed.sessionId !== expectedSessionId ||
    parsed.finalMarkerSeen !== true ||
    parsed.hiddenMarkerSeen !== false ||
    parsed.composerReady !== true ||
    typeof parsed.bracketedPasteAccepted !== 'boolean' ||
    typeof parsed.submittedInput !== 'boolean' ||
    parsed.exited !== true ||
    parsed.processGone !== true ||
    typeof parsed.output !== 'string' ||
    parsed.output.length > 12_000 ||
    !Array.isArray(parsed.faults) ||
    parsed.faults.length !== 0
  ) {
    throw new Error('Token-budget PTY runner evidence is incomplete');
  }
  return {
    success: true,
    mode: expectedMode,
    sessionId: parsed.sessionId,
    finalMarkerSeen: true,
    hiddenMarkerSeen: false,
    composerReady: true,
    bracketedPasteAccepted: parsed.bracketedPasteAccepted,
    submittedInput: parsed.submittedInput,
    exited: true,
    processGone: true,
    output: parsed.output,
    faults: [],
  };
}

export function parseTokenBudgetHandoffPtyEvidence(
  stdout: string,
  secrets: readonly string[] = []
): TokenBudgetHandoffPtyEvidence {
  if (stdout.length > MAX_PTY_EVIDENCE_CHARS) {
    throw new Error('Token-budget PTY evidence exceeded its serialized budget');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error('Token-budget PTY evidence must be valid JSON');
  }
  if (JSON.stringify(parsed) !== stdout) {
    throw new Error('Token-budget PTY evidence must use canonical JSON');
  }
  try {
    assertNoSecrets(parsed, secrets);
  } catch (error) {
    throw new Error('Token-budget PTY evidence contains secret material', {
      cause: error,
    });
  }
  try {
    assertNoSecrets(parsed, FORBIDDEN);
  } catch (error) {
    throw new Error('Token-budget PTY evidence contains a hidden marker', {
      cause: error,
    });
  }
  const recovery = isRecord(parsed) && isRecord(parsed.recovery) ? parsed.recovery : {};
  if (
    !isRecord(parsed) ||
    !hasExactKeys(parsed, [
      'bracketedPasteAccepted',
      'composerReady',
      'faults',
      'finalMarkerSeen',
      'hiddenMarkerSeen',
      'output',
      'processGone',
      'recovery',
      'resumeExited',
      'resumeSubmittedInput',
      'sessionId',
      'success',
      'surface',
      'taskExited',
    ]) ||
    !hasExactKeys(recovery, [
      'completed',
      'kind',
      'providerRequestsAfter',
      'providerRequestsBefore',
    ]) ||
    parsed.success !== true ||
    parsed.surface !== 'pty' ||
    typeof parsed.sessionId !== 'string' ||
    !isValidSessionId(parsed.sessionId) ||
    parsed.finalMarkerSeen !== true ||
    parsed.hiddenMarkerSeen !== false ||
    parsed.composerReady !== true ||
    parsed.bracketedPasteAccepted !== true ||
    parsed.taskExited !== true ||
    parsed.resumeExited !== true ||
    parsed.processGone !== true ||
    parsed.resumeSubmittedInput !== false ||
    typeof parsed.output !== 'string' ||
    parsed.output.length > 12_000 ||
    !Array.isArray(parsed.faults) ||
    parsed.faults.length !== 0 ||
    recovery.kind !== 'pty_resume' ||
    recovery.completed !== true ||
    !isNonNegativeSafeInteger(recovery.providerRequestsBefore) ||
    !isNonNegativeSafeInteger(recovery.providerRequestsAfter) ||
    recovery.providerRequestsBefore !== recovery.providerRequestsAfter
  ) {
    throw new Error('Token-budget PTY evidence is incomplete');
  }
  return {
    success: true,
    surface: 'pty',
    sessionId: parsed.sessionId,
    finalMarkerSeen: true,
    hiddenMarkerSeen: false,
    recovery: {
      kind: 'pty_resume',
      completed: true,
      providerRequestsBefore: recovery.providerRequestsBefore,
      providerRequestsAfter: recovery.providerRequestsAfter,
    },
    faults: [],
    composerReady: true,
    bracketedPasteAccepted: true,
    taskExited: true,
    resumeExited: true,
    processGone: true,
    resumeSubmittedInput: false,
    output: parsed.output,
  };
}

async function runMode(input: {
  mode: 'task' | 'resume';
  cliEntry: string;
  workspace: string;
  home: string;
  storageRoot: string;
  sessionId: string;
  prompt?: string;
  finalMarker: string;
  secrets: readonly string[];
  timeoutMs: number;
}): Promise<PtyRunnerEvidence> {
  const runner = path.resolve(import.meta.dirname, 'tokenBudgetHandoffPtyRunner.ts');
  const encoded = Buffer.from(JSON.stringify(input), 'utf8').toString('base64');
  const env = Object.fromEntries(
    Object.entries({
      ...process.env,
      HOME: input.home,
      BLADE_STORAGE_ROOT: input.storageRoot,
      BLADE_AUTO_MEMORY: '0',
      BLADE_TELEMETRY_DISABLED: '1',
      TERM: 'xterm-256color',
      BLADE_TOKEN_BUDGET_PTY_INPUT: encoded,
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
    if (result.stderr !== '') throw new Error('Token-budget PTY runner wrote stderr');
    return parseRunnerEvidence(
      result.stdout,
      input.mode,
      input.sessionId,
      input.secrets
    );
  } catch {
    throw new Error('Token-budget PTY runner failed');
  }
}

export async function runTokenBudgetHandoffPtyDriver(input: {
  fixture: TokenBudgetHandoffFixture;
  sessionId: string;
  home: string;
  storageRoot: string;
  providerRequestCount: () => number;
  secrets?: readonly string[];
  timeoutMs?: number;
}): Promise<TokenBudgetHandoffPtyEvidence> {
  const paths = [input.fixture.workspace, input.home, input.storageRoot];
  if (paths.some((value) => !path.isAbsolute(value))) {
    throw new Error('Token-budget PTY isolation paths must be absolute');
  }
  if (
    !isValidSessionId(input.sessionId) ||
    !FINAL_MARKER_PATTERN.test(input.fixture.finalMarker) ||
    input.fixture.prompt.includes(input.fixture.finalMarker)
  ) {
    throw new Error('Token-budget PTY session or final marker contract is invalid');
  }
  const timeoutMs = input.timeoutMs ?? 270_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('Token-budget PTY timeout must be positive');
  }
  const secrets = input.secrets ?? [];
  const cliEntry = path.resolve(import.meta.dirname, '../../dist/blade.js');
  const common = {
    cliEntry,
    workspace: path.resolve(input.fixture.workspace),
    home: path.resolve(input.home),
    storageRoot: path.resolve(input.storageRoot),
    sessionId: input.sessionId,
    finalMarker: input.fixture.finalMarker,
    secrets,
    timeoutMs,
  };
  const task = await runMode({
    ...common,
    mode: 'task',
    prompt: input.fixture.prompt,
  });
  if (!task.bracketedPasteAccepted || !task.submittedInput) {
    throw new Error('Token-budget PTY task did not submit bracketed input');
  }
  const providerRequestCount = (): number => {
    try {
      const count = input.providerRequestCount();
      if (!isNonNegativeSafeInteger(count)) {
        throw new Error('invalid count');
      }
      return count;
    } catch {
      throw new Error('Token-budget PTY Provider request count failed');
    }
  };
  const before = providerRequestCount();
  const resume = await runMode({ ...common, mode: 'resume' });
  const after = providerRequestCount();
  if (resume.bracketedPasteAccepted || resume.submittedInput || before !== after) {
    throw new Error('Token-budget PTY resume issued input or a Provider request');
  }
  return parseTokenBudgetHandoffPtyEvidence(
    JSON.stringify({
      success: true,
      surface: 'pty',
      sessionId: input.sessionId,
      finalMarkerSeen: true,
      hiddenMarkerSeen: false,
      recovery: {
        kind: 'pty_resume',
        completed: true,
        providerRequestsBefore: before,
        providerRequestsAfter: after,
      },
      faults: [],
      composerReady: task.composerReady && resume.composerReady,
      bracketedPasteAccepted: task.bracketedPasteAccepted,
      taskExited: task.exited,
      resumeExited: resume.exited,
      processGone: task.processGone && resume.processGone,
      resumeSubmittedInput: resume.submittedInput,
      output: task.output,
    }),
    secrets
  );
}
