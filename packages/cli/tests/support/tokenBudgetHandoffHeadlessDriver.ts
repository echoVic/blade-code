import { execFile } from 'node:child_process';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { promisify } from 'node:util';
import { runHeadless } from '../../src/commands/headless.js';
import { PermissionMode } from '../../src/config/types.js';
import {
  TOKEN_BUDGET_HANDOFF_MESSAGE_ID_PREFIX,
  TOKEN_BUDGET_HANDOFF_TAG,
} from '../../src/context/TokenBudgetHandoff.js';
import { runWithCwdOverride } from '../../src/utils/cwd.js';
import type { TokenBudgetHandoffFixture } from '../integration/real-api/tokenBudgetHandoffFixture.js';
import { assertNoSecrets } from '../integration/real-api/sessionForkTrajectoryHarness.js';
import {
  assertAndProjectSurfaceEvidence,
  BoundedStringSink,
  type TokenBudgetHandoffSurfaceEvidence,
} from '../integration/real-api/tokenBudgetHandoffHarness.js';

const execFileAsync = promisify(execFile);
const MAX_PROJECTION_STDOUT_CHARS = 64_000;
const FORBIDDEN_HANDOFF_TEXT = [
  TOKEN_BUDGET_HANDOFF_TAG,
  'token_budget_handoff_recorded',
  TOKEN_BUDGET_HANDOFF_MESSAGE_ID_PREFIX,
  'Context rollover is approaching',
] as const;

export const TOKEN_BUDGET_PROJECTION_EVIDENCE_PREFIX =
  '__BLADE_TOKEN_BUDGET_PROJECTION__';

export interface TokenBudgetHandoffProjectionEvidence {
  modelHasMarker: false;
  publicHasMarker: false;
  modelMessageCount: number;
  publicMessageCount: number;
}

export class TokenBudgetHandoffOutputSink extends BoundedStringSink {
  readonly #decoder = new StringDecoder('utf8');
  readonly #forbidden: readonly string[];
  readonly #tailLength: number;
  #scanTail = '';
  #forbiddenSeen = false;
  #closed = false;

  constructor(maxChars: number, forbidden: readonly string[]) {
    super(maxChars);
    this.#forbidden = forbidden.filter(Boolean);
    this.#tailLength = Math.max(0, ...this.#forbidden.map((value) => value.length - 1));
  }

  override write(chunk: string | Buffer): boolean {
    if (this.#closed) return false;
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    this.#scan(this.#decoder.write(bytes));
    return super.write(chunk);
  }

  override close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#scan(this.#decoder.end());
    super.close();
  }

  forbiddenSeen(): boolean {
    return this.#forbiddenSeen;
  }

  #scan(text: string): void {
    const scan = `${this.#scanTail}${text}`;
    this.#forbiddenSeen ||= this.#forbidden.some((value) => scan.includes(value));
    this.#scanTail = this.#tailLength > 0 ? scan.slice(-this.#tailLength) : '';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function projectionPayload(stdout: string): string {
  if (
    !stdout.startsWith(TOKEN_BUDGET_PROJECTION_EVIDENCE_PREFIX) ||
    !stdout.endsWith('\n') ||
    stdout.slice(0, -1).includes('\n') ||
    stdout.includes('\r')
  ) {
    throw new Error(
      'Token-budget projection evidence must contain one fixed-prefix line'
    );
  }
  return stdout.slice(TOKEN_BUDGET_PROJECTION_EVIDENCE_PREFIX.length, -1);
}

export function parseTokenBudgetHandoffProjectionEvidence(
  stdout: string,
  secrets: readonly string[] = [],
  stderr = ''
): TokenBudgetHandoffProjectionEvidence {
  if (stdout.length > MAX_PROJECTION_STDOUT_CHARS) {
    throw new Error('Token-budget projection evidence exceeded its serialized budget');
  }
  if (stderr.length > 16_000) {
    throw new Error('Token-budget projection stderr exceeded its serialized budget');
  }
  try {
    assertNoSecrets(stderr, secrets);
  } catch (error) {
    throw new Error('Token-budget projection stderr contains secret material', {
      cause: error,
    });
  }
  try {
    assertNoSecrets(stderr, FORBIDDEN_HANDOFF_TEXT);
  } catch (error) {
    throw new Error('Token-budget projection stderr contains a hidden marker', {
      cause: error,
    });
  }
  if (stderr !== '') {
    throw new Error('Token-budget projection stderr must be exactly empty');
  }
  try {
    assertNoSecrets(stdout, secrets);
  } catch (error) {
    throw new Error('Token-budget projection evidence contains secret material', {
      cause: error,
    });
  }
  try {
    assertNoSecrets(stdout, FORBIDDEN_HANDOFF_TEXT);
  } catch (error) {
    throw new Error('Token-budget projection evidence contains a hidden marker', {
      cause: error,
    });
  }
  const payload = projectionPayload(stdout);
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new Error('Token-budget projection evidence must be valid JSON');
  }
  if (JSON.stringify(parsed) !== payload) {
    throw new Error('Token-budget projection evidence must use canonical JSON');
  }
  try {
    assertNoSecrets(parsed, secrets);
  } catch (error) {
    throw new Error('Token-budget projection evidence contains secret material', {
      cause: error,
    });
  }
  try {
    assertNoSecrets(parsed, FORBIDDEN_HANDOFF_TEXT);
  } catch (error) {
    throw new Error('Token-budget projection evidence contains a hidden marker', {
      cause: error,
    });
  }
  if (!isRecord(parsed)) {
    throw new Error('Token-budget projection evidence must be an object');
  }
  const expectedKeys = [
    'modelHasMarker',
    'modelMessageCount',
    'publicHasMarker',
    'publicMessageCount',
  ];
  if (
    Object.keys(parsed).length !== expectedKeys.length ||
    !expectedKeys.every((key) => Object.hasOwn(parsed, key))
  ) {
    throw new Error('Token-budget projection evidence keys are invalid');
  }
  if (
    parsed.modelHasMarker !== false ||
    parsed.publicHasMarker !== false ||
    !isNonNegativeSafeInteger(parsed.modelMessageCount) ||
    !isNonNegativeSafeInteger(parsed.publicMessageCount)
  ) {
    throw new Error('Token-budget projection marker or completion evidence is invalid');
  }
  return {
    modelHasMarker: false,
    publicHasMarker: false,
    modelMessageCount: parsed.modelMessageCount,
    publicMessageCount: parsed.publicMessageCount,
  };
}

export async function runTokenBudgetHandoffProjectionRunner(input: {
  sessionId: string;
  workspace: string;
  home: string;
  storageRoot: string;
  secrets?: readonly string[];
  timeoutMs?: number;
}): Promise<TokenBudgetHandoffProjectionEvidence> {
  if (
    !path.isAbsolute(input.workspace) ||
    !path.isAbsolute(input.home) ||
    !path.isAbsolute(input.storageRoot)
  ) {
    throw new Error('Token-budget projection isolation paths must be absolute');
  }
  const timeoutMs = input.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('Token-budget projection timeout must be a positive integer');
  }
  const workspace = path.resolve(input.workspace);
  const home = path.resolve(input.home);
  const storageRoot = path.resolve(input.storageRoot);
  const runner = path.resolve(
    import.meta.dirname,
    'tokenBudgetHandoffProjectionRunner.ts'
  );
  const encoded = Buffer.from(
    JSON.stringify({ sessionId: input.sessionId, workspace }),
    'utf8'
  ).toString('base64');
  const env = Object.fromEntries(
    Object.entries({
      ...process.env,
      HOME: home,
      BLADE_STORAGE_ROOT: storageRoot,
      BLADE_AUTO_MEMORY: '0',
      BLADE_TELEMETRY_DISABLED: '1',
    }).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  );
  const secrets = input.secrets ?? [];
  try {
    const result = await execFileAsync('bun', [runner, encoded], {
      cwd: path.resolve(import.meta.dirname, '../..'),
      env,
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      killSignal: 'SIGKILL',
    });
    return parseTokenBudgetHandoffProjectionEvidence(
      result.stdout,
      secrets,
      result.stderr
    );
  } catch (error) {
    void error;
    throw new Error('Token-budget projection runner failed');
  }
}

export async function runTokenBudgetHandoffHeadlessDriver(input: {
  fixture: TokenBudgetHandoffFixture;
  sessionId: string;
  home: string;
  storageRoot: string;
  providerRequestCount: () => number;
  secrets?: readonly string[];
  timeoutMs?: number;
}): Promise<TokenBudgetHandoffSurfaceEvidence> {
  if (
    !path.isAbsolute(input.fixture.workspace) ||
    !path.isAbsolute(input.home) ||
    !path.isAbsolute(input.storageRoot)
  ) {
    throw new Error('Token-budget Headless isolation paths must be absolute');
  }
  const timeoutMs = input.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('Token-budget Headless recovery timeout must be positive');
  }
  const forbidden = [
    ...FORBIDDEN_HANDOFF_TEXT,
    ...(input.secrets ?? []).filter(Boolean),
  ];
  const stdout = new TokenBudgetHandoffOutputSink(64_000, forbidden);
  const stderr = new TokenBudgetHandoffOutputSink(16_000, forbidden);
  try {
    const exitCode = await runWithCwdOverride(input.fixture.workspace, () =>
      runHeadless(
        {
          headless: true,
          message: input.fixture.prompt,
          sessionId: input.sessionId,
          permissionMode: PermissionMode.YOLO,
          verificationAgent: false,
          maxTurns: 8,
        },
        { stdout, stderr }
      )
    );
    const danglingListeners =
      stdout.listenerCount('drain') +
      stdout.listenerCount('error') +
      stderr.listenerCount('drain') +
      stderr.listenerCount('error');
    if (danglingListeners !== 0) {
      throw new Error('Token-budget Headless output retained listeners');
    }
    stdout.close();
    stderr.close();
    if (stdout.eventNames().length !== 0 || stderr.eventNames().length !== 0) {
      throw new Error('Token-budget Headless sinks retained listeners after close');
    }
    if (stdout.forbiddenSeen() || stderr.forbiddenSeen()) {
      throw new Error('Token-budget Headless output exposed hidden or secret material');
    }
    if (/(?:^|\n)Error:/m.test(stderr.value())) {
      throw new Error('Token-budget Headless stderr reported an execution error');
    }
    const providerRequestCount = (): number => {
      try {
        const count = input.providerRequestCount();
        if (!isNonNegativeSafeInteger(count)) throw new Error('invalid');
        return count;
      } catch {
        throw new Error('Token-budget Headless Provider request count failed');
      }
    };
    const before = providerRequestCount();
    await runTokenBudgetHandoffProjectionRunner({
      sessionId: input.sessionId,
      workspace: path.resolve(input.fixture.workspace),
      home: path.resolve(input.home),
      storageRoot: path.resolve(input.storageRoot),
      secrets: input.secrets,
      timeoutMs,
    });
    const after = providerRequestCount();
    return assertAndProjectSurfaceEvidence({
      surface: 'headless',
      sessionId: input.sessionId,
      exitCode,
      output: stdout.value(),
      // Production Headless emits normal tool/compaction progress on stderr. The
      // full stream is validated above, while the common projection stays raw-free.
      stderr: '',
      expected: input.fixture.finalMarker,
      forbidden,
      recovery: {
        kind: 'cold_projection',
        completed: true,
        providerRequestsBefore: before,
        providerRequestsAfter: after,
      },
    });
  } finally {
    stdout.close();
    stderr.close();
  }
}
