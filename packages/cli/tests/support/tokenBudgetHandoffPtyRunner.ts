import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { spawn } from 'bun-pty';
import {
  assertValidSessionId,
  getSessionFilePath,
} from '../../src/context/storage/pathUtils.js';
import { TOKEN_BUDGET_HANDOFF_MESSAGE_ID_PREFIX } from '../../src/context/TokenBudgetHandoff.js';
import {
  captureProcessIdentity,
  type ProcessIdentity,
  processIdentityMatches,
} from '../../src/utils/process/ProcessIdentity.js';
import {
  finalAssistantText,
  readSessionEvents,
} from '../integration/real-api/sessionForkTrajectoryHarness.js';
import { createTuiPtyComposerReadyHandshake, writeBracketedPaste } from './ptyInput.js';
import { classifyTokenBudgetPtyFinal } from './tokenBudgetHandoffPtyDriver.js';

const MAX_PROJECTED_OUTPUT_CHARS = 12_000;
const PTY_FAILURE_STAGES = [
  'identity',
  'composer',
  'paste',
  'marker',
  'durable_completion',
  'privacy',
  'cleanup',
] as const;

type PtyFailureStage = (typeof PTY_FAILURE_STAGES)[number];

interface RunnerInput {
  mode: 'task' | 'resume';
  cliEntry: string;
  workspace: string;
  home: string;
  storageRoot: string;
  sessionId: string;
  prompt?: string;
  finalMarker: string;
  secrets: string[];
  timeoutMs: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function canonicalBase64(value: string): Buffer {
  if (
    !value ||
    value.length > 256_000 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw new Error('Token-budget PTY runner input encoding is invalid');
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) {
    throw new Error('Token-budget PTY runner input encoding is not canonical');
  }
  return decoded;
}

function loadInput(): RunnerInput {
  const encoded = process.env.BLADE_TOKEN_BUDGET_PTY_INPUT;
  if (!encoded) throw new Error('Token-budget PTY runner input is missing');
  let parsed: unknown;
  let decodedText: string;
  try {
    decodedText = canonicalBase64(encoded).toString('utf8');
    parsed = JSON.parse(decodedText);
  } catch (error) {
    if (error instanceof Error && error.message.includes('Token-budget')) throw error;
    throw new Error('Token-budget PTY runner input is invalid');
  }
  if (JSON.stringify(parsed) !== decodedText) {
    throw new Error('Token-budget PTY runner input must use canonical JSON');
  }
  if (!isRecord(parsed) || (parsed.mode !== 'task' && parsed.mode !== 'resume')) {
    throw new Error('Token-budget PTY runner input shape is invalid');
  }
  const expectedKeys =
    parsed.mode === 'task'
      ? [
          'cliEntry',
          'finalMarker',
          'home',
          'mode',
          'prompt',
          'secrets',
          'sessionId',
          'storageRoot',
          'timeoutMs',
          'workspace',
        ]
      : [
          'cliEntry',
          'finalMarker',
          'home',
          'mode',
          'secrets',
          'sessionId',
          'storageRoot',
          'timeoutMs',
          'workspace',
        ];
  if (
    Object.keys(parsed).length !== expectedKeys.length ||
    !expectedKeys.every((key) => Object.hasOwn(parsed, key)) ||
    typeof parsed.cliEntry !== 'string' ||
    typeof parsed.workspace !== 'string' ||
    typeof parsed.home !== 'string' ||
    typeof parsed.storageRoot !== 'string' ||
    typeof parsed.sessionId !== 'string' ||
    typeof parsed.finalMarker !== 'string' ||
    !isStringArray(parsed.secrets) ||
    !isPositiveSafeInteger(parsed.timeoutMs) ||
    (parsed.mode === 'task' && typeof parsed.prompt !== 'string') ||
    (parsed.mode === 'resume' && parsed.prompt !== undefined) ||
    !path.isAbsolute(parsed.cliEntry) ||
    !path.isAbsolute(parsed.workspace) ||
    !path.isAbsolute(parsed.home) ||
    !path.isAbsolute(parsed.storageRoot)
  ) {
    throw new Error('Token-budget PTY runner input shape is invalid');
  }
  assertValidSessionId(parsed.sessionId);
  const common = {
    cliEntry: path.resolve(parsed.cliEntry),
    workspace: path.resolve(parsed.workspace),
    home: path.resolve(parsed.home),
    storageRoot: path.resolve(parsed.storageRoot),
    sessionId: parsed.sessionId,
    finalMarker: parsed.finalMarker,
    secrets: parsed.secrets,
    timeoutMs: parsed.timeoutMs,
  };
  if (parsed.mode === 'task') {
    if (typeof parsed.prompt !== 'string') {
      throw new Error('Token-budget PTY runner prompt is invalid');
    }
    return { ...common, mode: 'task', prompt: parsed.prompt };
  }
  return { ...common, mode: 'resume' };
}

async function waitFor(
  predicate: () => boolean,
  exited: () => boolean,
  message: string,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    if (exited()) throw new Error(`${message}: PTY exited early`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

function remainingStageBudget(deadline: number, maximumMs: number): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new Error('Token-budget PTY surface deadline exhausted');
  }
  return Math.max(1, Math.min(remaining, maximumMs));
}

async function captureIdentity(pid: number): Promise<ProcessIdentity> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const identity = captureProcessIdentity(pid);
    if (identity) return identity;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Token-budget PTY process identity was unavailable');
}

async function waitForDurableCompletion(
  input: RunnerInput,
  timeoutMs: number
): Promise<void> {
  const transcriptPath = getSessionFilePath(input.workspace, input.sessionId);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const events = readSessionEvents(transcriptPath);
    const finalText = finalAssistantText(events);
    const state = classifyTokenBudgetPtyFinal(finalText, input.finalMarker);
    if (state === 'matched') return;
    if (state === 'mismatched') {
      throw new Error('Token-budget PTY durable final did not match');
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Token-budget PTY completion was not durable');
}

function signalTree(pid: number, signal: NodeJS.Signals, fallback: () => void): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      fallback();
    } catch {
      // The PTY already exited.
    }
  }
}

function projectOutput(output: string): string {
  const plain = [...stripVTControlCharacters(output)]
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127);
    })
    .join('');
  return plain.slice(-MAX_PROJECTED_OUTPUT_CHARS);
}

async function main(): Promise<void> {
  const input = loadInput();
  const deadline = Date.now() + input.timeoutMs - 10_000;
  if (
    !/^FINAL_OK_[A-Za-z0-9_]{16,64}$/.test(input.finalMarker) ||
    input.prompt?.includes(input.finalMarker)
  ) {
    throw new Error('Token-budget PTY runner final marker contract is invalid');
  }
  const handshake = createTuiPtyComposerReadyHandshake({
    HOME: input.home,
    BLADE_STORAGE_ROOT: input.storageRoot,
    BLADE_AUTO_MEMORY: '0',
    BLADE_TELEMETRY_DISABLED: '1',
    BLADE_TOKEN_BUDGET_PTY_INPUT: undefined,
    TERM: 'xterm-256color',
  });
  const args = [
    'node',
    input.cliEntry,
    '--trust-workspace',
    '--permission-mode',
    'yolo',
    '--max-turns',
    '8',
    input.mode === 'task' ? '--session-id' : '--resume',
    input.sessionId,
    '--no-verification-agent',
  ];
  const terminal = spawn('/usr/bin/env', args, {
    name: 'xterm-256color',
    cwd: input.workspace,
    cols: 140,
    rows: 48,
    env: handshake.env,
  });
  let identity: ProcessIdentity | undefined;
  let output = '';
  let scanTail = '';
  let finalMarkerSeen = false;
  let hiddenMarkerSeen = false;
  let composerReady = false;
  let bracketedPasteAccepted = false;
  let submittedInput = false;
  let exited = false;
  let setupWizardSeen = false;
  let initializationErrorSeen = false;
  let failureStage: PtyFailureStage = 'identity';
  let failureCode = 'stage_failed';
  const forbidden = [
    '<token-budget-handoff version="1">',
    'token_budget_handoff_recorded',
    TOKEN_BUDGET_HANDOFF_MESSAGE_ID_PREFIX,
    'Context rollover is approaching',
    ...input.secrets.filter(Boolean),
  ];
  const maxNeedle = Math.max(
    1,
    handshake.marker.length,
    input.finalMarker.length,
    ...forbidden.map((v) => v.length)
  );
  const exitPromise = new Promise<void>((resolve) => {
    terminal.onExit(() => {
      exited = true;
      resolve();
    });
  });
  terminal.onData((chunk) => {
    output = `${output}${chunk}`.slice(-128_000);
    const scan = `${scanTail}${chunk}`;
    const plainScan = stripVTControlCharacters(scan);
    finalMarkerSeen ||= scan.includes(input.finalMarker);
    hiddenMarkerSeen ||= forbidden.some((value) => value && scan.includes(value));
    composerReady ||= scan.includes(handshake.marker);
    setupWizardSeen ||= plainScan.includes('Step 1: 选择 API 提供商');
    initializationErrorSeen ||= plainScan.includes('初始化失败');
    bracketedPasteAccepted ||= plainScan.includes('PASTE:');
    scanTail = scan.slice(-(maxNeedle - 1));
  });

  let failure: unknown;
  try {
    identity = await captureIdentity(terminal.pid);
    failureStage = 'composer';
    await waitFor(
      () => composerReady,
      () => exited,
      'Timed out waiting for token-budget PTY composer',
      remainingStageBudget(deadline, 60_000)
    );
    if (input.mode === 'task') {
      failureStage = 'paste';
      await writeBracketedPaste(terminal, input.prompt ?? '');
      await waitFor(
        () => bracketedPasteAccepted,
        () => exited,
        'Timed out waiting for token-budget PTY paste acknowledgement',
        remainingStageBudget(deadline, 10_000)
      );
      finalMarkerSeen = false;
      terminal.write('\r');
      submittedInput = true;
    }
    failureStage = 'marker';
    await waitFor(
      () => finalMarkerSeen,
      () => exited,
      'Timed out waiting for token-budget PTY final marker',
      remainingStageBudget(deadline, input.timeoutMs)
    );
    if (input.mode === 'task') {
      failureStage = 'durable_completion';
      await waitForDurableCompletion(
        input,
        remainingStageBudget(deadline, input.timeoutMs)
      );
    }
    failureStage = 'privacy';
    if (hiddenMarkerSeen) {
      throw new Error('Token-budget PTY exposed hidden marker or secret material');
    }
  } catch (error) {
    if (failureStage === 'composer') {
      const composerFailureCode =
        `ready_${composerReady ? 1 : 0}:` +
        `setup_${setupWizardSeen ? 1 : 0}:` +
        `init_error_${initializationErrorSeen ? 1 : 0}`;
      failureCode = composerFailureCode;
    }
    failure = error;
  }

  try {
    terminal.write('\u0004');
  } catch {
    // The PTY already exited.
  }
  await Promise.race([
    exitPromise,
    new Promise<void>((resolve) => setTimeout(resolve, 500)),
  ]);
  if (!exited) {
    signalTree(terminal.pid, 'SIGTERM', () => terminal.kill('SIGTERM'));
    await Promise.race([
      exitPromise,
      new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
    ]);
  }
  if (!exited) {
    signalTree(terminal.pid, 'SIGKILL', () => terminal.kill('SIGKILL'));
    await Promise.race([
      exitPromise,
      new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
    ]);
  }
  const processGone =
    identity !== undefined && !processIdentityMatches(terminal.pid, identity);
  if (!exited || !processGone || hiddenMarkerSeen) {
    if (!failure) {
      failureStage = 'cleanup';
      failureCode = 'cleanup_incomplete';
    }
    failure ??= new Error('Token-budget PTY process cleanup did not complete');
  }

  if (failure) {
    process.stdout.write(
      JSON.stringify({
        success: false,
        failureStage,
        failureCode,
        faults: ['runner_failed'],
      })
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    JSON.stringify({
      success: true,
      mode: input.mode,
      sessionId: input.sessionId,
      finalMarkerSeen: true,
      hiddenMarkerSeen: false,
      composerReady: true,
      bracketedPasteAccepted,
      submittedInput,
      exited: true,
      processGone: true,
      output: projectOutput(output),
      faults: [],
    })
  );
}

if (import.meta.main) {
  await main();
}
