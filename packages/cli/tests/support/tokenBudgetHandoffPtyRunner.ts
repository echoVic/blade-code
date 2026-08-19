import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { readFile } from 'node:fs/promises';
import { spawn } from 'bun-pty';
import {
  assertValidSessionId,
  getSessionFilePath,
} from '../../src/context/storage/pathUtils.js';
import { parseSessionJSONL } from '../../src/context/storage/JSONLStore.js';
import { TOKEN_BUDGET_HANDOFF_MESSAGE_ID_PREFIX } from '../../src/context/TokenBudgetHandoff.js';
import {
  captureProcessIdentity,
  processIdentityMatches,
  type ProcessIdentity,
} from '../../src/utils/process/ProcessIdentity.js';

const MAX_PROJECTED_OUTPUT_CHARS = 12_000;

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

async function captureIdentity(pid: number): Promise<ProcessIdentity> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const identity = captureProcessIdentity(pid);
    if (identity) return identity;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Token-budget PTY process identity was unavailable');
}

async function waitForDurableCompletion(input: RunnerInput): Promise<void> {
  const transcriptPath = getSessionFilePath(input.workspace, input.sessionId);
  const deadline = Date.now() + input.timeoutMs;
  while (Date.now() < deadline) {
    const raw = await readFile(transcriptPath, 'utf8');
    const events = parseSessionJSONL(raw, transcriptPath);
    if (
      events.some((event) => event.type === 'turn_completed') &&
      JSON.stringify(events).includes(input.finalMarker)
    ) {
      return;
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
  if (
    !/^FINAL_OK_[A-Za-z0-9_]{16,64}$/.test(input.finalMarker) ||
    input.prompt?.includes(input.finalMarker)
  ) {
    throw new Error('Token-budget PTY runner final marker contract is invalid');
  }
  const { BLADE_TOKEN_BUDGET_PTY_INPUT: _runnerInput, ...baseEnvironment } =
    process.env;
  void _runnerInput;
  const env = Object.fromEntries(
    Object.entries({
      ...baseEnvironment,
      HOME: input.home,
      BLADE_STORAGE_ROOT: input.storageRoot,
      BLADE_AUTO_MEMORY: '0',
      BLADE_TELEMETRY_DISABLED: '1',
      TERM: 'xterm-256color',
    }).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  );
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
    env,
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
  const forbidden = [
    '<token-budget-handoff version="1">',
    'token_budget_handoff_recorded',
    TOKEN_BUDGET_HANDOFF_MESSAGE_ID_PREFIX,
    'Context rollover is approaching',
    ...input.secrets.filter(Boolean),
  ];
  const maxNeedle = Math.max(
    1,
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
    finalMarkerSeen ||= scan.includes(input.finalMarker);
    hiddenMarkerSeen ||= forbidden.some((value) => value && scan.includes(value));
    composerReady ||= scan.includes('请输入您的问题');
    bracketedPasteAccepted ||= scan.includes('PASTE:');
    scanTail = scan.slice(-(maxNeedle - 1));
  });

  let failure: unknown;
  try {
    identity = await captureIdentity(terminal.pid);
    await waitFor(
      () => composerReady,
      () => exited,
      'Timed out waiting for token-budget PTY composer',
      Math.min(input.timeoutMs, 60_000)
    );
    if (input.mode === 'task') {
      terminal.write(`\u001B[200~${input.prompt ?? ''}\u001B[201~`);
      await waitFor(
        () => bracketedPasteAccepted,
        () => exited,
        'Token-budget PTY bracketed paste was not accepted',
        10_000
      );
      finalMarkerSeen = false;
      terminal.write('\r');
      submittedInput = true;
    }
    await waitFor(
      () => finalMarkerSeen,
      () => exited,
      'Timed out waiting for token-budget PTY final marker',
      input.timeoutMs
    );
    if (input.mode === 'task') {
      await waitForDurableCompletion(input);
    }
    if (hiddenMarkerSeen) {
      throw new Error('Token-budget PTY exposed hidden marker or secret material');
    }
  } catch (error) {
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
    failure ??= new Error('Token-budget PTY process cleanup did not complete');
  }

  if (failure) {
    process.stdout.write(JSON.stringify({ success: false, faults: ['runner_failed'] }));
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
