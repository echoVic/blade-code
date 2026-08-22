import { createHash } from 'node:crypto';
import path from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import { BladeAgent } from '../../src/acp/BladeAgent.js';
import {
  assertValidSessionId,
  isValidSessionId,
} from '../../src/context/storage/pathUtils.js';
import { TOKEN_BUDGET_HANDOFF_MESSAGE_ID_PREFIX } from '../../src/context/TokenBudgetHandoff.js';
import { WorkspaceTrustService } from '../../src/security/WorkspaceTrustService.js';
import { ensureStoreInitialized } from '../../src/store/vanilla.js';
import { runWithCwdOverride } from '../../src/utils/cwd.js';
import { processIdentityMatches } from '../../src/utils/process/ProcessIdentity.js';
import { ChildBackedRecordingAcpClient } from './acp/ChildBackedRecordingAcpClient.js';

interface RunnerInput {
  mode: 'task' | 'load';
  workspace: string;
  home: string;
  storageRoot: string;
  sessionId?: string;
  prompt?: string;
  finalMarker: string;
  secrets: string[];
  timeoutMs: number;
  setupTimeoutMs?: number;
}

type ByteSizeBucket = 0 | '1_4096' | '4097_16384' | '16385_plus';
type RunnerFailureStage =
  | 'initialize'
  | 'new_session'
  | 'set_mode'
  | 'prompt'
  | 'load'
  | 'cleanup'
  | 'evidence';
type RunnerFailureFault =
  | 'runner_failed'
  | 'timeout'
  | 'final_missing'
  | 'cleanup_incomplete'
  | 'hidden_material';

interface SurfaceFacts {
  finalMarkerSeen: boolean;
  surfaceFinalPresent: boolean;
  surfaceFinalByteSizeBucket: ByteSizeBucket;
  surfaceFinalSha256Prefix: string | null;
}

interface RunnerConnection {
  initialize(params: acp.InitializeRequest): Promise<acp.InitializeResponse>;
  newSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse>;
  loadSession(params: acp.LoadSessionRequest): Promise<acp.LoadSessionResponse>;
  setSessionMode(
    params: acp.SetSessionModeRequest
  ): Promise<acp.SetSessionModeResponse>;
  prompt(params: acp.PromptRequest): Promise<acp.PromptResponse>;
  cancel(params: acp.CancelNotification): Promise<void>;
}

interface RunnerFailureEvidence {
  success: false;
  mode: RunnerInput['mode'];
  stage: RunnerFailureStage;
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
  faults: RunnerFailureFault[];
}

interface RunnerSuccessEvidence {
  success: true;
  mode: RunnerInput['mode'];
  sessionId: string;
  stopReason: 'end_turn' | null;
  finalMarkerSeen: boolean;
  surfaceFinalPresent: boolean;
  surfaceFinalByteSizeBucket: ByteSizeBucket;
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

type RunnerEvidence = RunnerFailureEvidence | RunnerSuccessEvidence;

class TimeoutError extends Error {
  constructor() {
    super('Token-budget ACP operation timed out');
    this.name = 'TimeoutError';
  }
}

function byteSizeBucket(text: string): ByteSizeBucket {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes === 0) return 0;
  if (bytes <= 4_096) return '1_4096';
  if (bytes <= 16_384) return '4097_16384';
  return '16385_plus';
}

class RecordingClient extends ChildBackedRecordingAcpClient {
  private terminalText = '';
  private hiddenTerminalTextSeen = false;

  constructor(private readonly forbidden: readonly string[]) {
    let tail = '';
    const maxNeedle = Math.max(1, ...forbidden.map((value) => value.length));
    super((chunk) => {
      const scan = `${tail}${chunk}`;
      this.hiddenTerminalTextSeen ||= forbidden.some(
        (value) => value && scan.includes(value)
      );
      tail = scan.slice(-(maxNeedle - 1));
    });
  }

  override async terminalOutput(
    params: acp.TerminalOutputRequest
  ): Promise<acp.TerminalOutputResponse> {
    const response = await super.terminalOutput(params);
    this.hiddenTerminalTextSeen ||= this.forbidden.some(
      (value) => value && response.output.includes(value)
    );
    this.terminalText = `${this.terminalText}${response.output}`.slice(-64_000);
    return response;
  }

  terminalEvidence(): string {
    return this.terminalText;
  }

  terminalExposedHiddenText(): boolean {
    return this.hiddenTerminalTextSeen;
  }
}

interface Harness {
  client: RecordingClient;
  connection: RunnerConnection;
  close(): Promise<void>;
}

type HarnessFactory = (forbidden: readonly string[]) => Harness;

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
    throw new Error('Token-budget ACP runner input encoding is invalid');
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) {
    throw new Error('Token-budget ACP runner input encoding is not canonical');
  }
  return decoded;
}

function loadInput(): RunnerInput {
  const encoded = process.env.BLADE_TOKEN_BUDGET_ACP_INPUT;
  if (!encoded) throw new Error('Token-budget ACP runner input is missing');
  let serialized: string;
  let parsed: unknown;
  try {
    serialized = canonicalBase64(encoded).toString('utf8');
    parsed = JSON.parse(serialized);
  } catch (error) {
    if (error instanceof Error && error.message.includes('Token-budget')) throw error;
    throw new Error('Token-budget ACP runner input is invalid');
  }
  if (JSON.stringify(parsed) !== serialized || !isRecord(parsed)) {
    throw new Error('Token-budget ACP runner input must use canonical JSON');
  }
  if (parsed.mode !== 'task' && parsed.mode !== 'load') {
    throw new Error('Token-budget ACP runner mode is invalid');
  }
  const keys =
    parsed.mode === 'task'
      ? [
          'finalMarker',
          'home',
          'mode',
          'prompt',
          'secrets',
          'storageRoot',
          'timeoutMs',
          'workspace',
        ]
      : [
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
    Object.keys(parsed).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(parsed, key)) ||
    typeof parsed.workspace !== 'string' ||
    typeof parsed.home !== 'string' ||
    typeof parsed.storageRoot !== 'string' ||
    typeof parsed.finalMarker !== 'string' ||
    !isStringArray(parsed.secrets) ||
    !isPositiveSafeInteger(parsed.timeoutMs) ||
    !path.isAbsolute(parsed.workspace) ||
    !path.isAbsolute(parsed.home) ||
    !path.isAbsolute(parsed.storageRoot) ||
    (parsed.mode === 'task' && typeof parsed.prompt !== 'string') ||
    (parsed.mode === 'load' && typeof parsed.sessionId !== 'string')
  ) {
    throw new Error('Token-budget ACP runner input shape is invalid');
  }
  const common = {
    workspace: path.resolve(parsed.workspace),
    home: path.resolve(parsed.home),
    storageRoot: path.resolve(parsed.storageRoot),
    finalMarker: parsed.finalMarker,
    secrets: parsed.secrets,
    timeoutMs: parsed.timeoutMs,
  };
  if (parsed.mode === 'task') {
    if (typeof parsed.prompt !== 'string') throw new Error('ACP prompt is invalid');
    return { ...common, mode: 'task', prompt: parsed.prompt };
  }
  if (typeof parsed.sessionId !== 'string') throw new Error('ACP session is invalid');
  assertValidSessionId(parsed.sessionId);
  return { ...common, mode: 'load', sessionId: parsed.sessionId };
}

function createHarness(forbidden: readonly string[]): Harness {
  const client = new RecordingClient(forbidden);
  const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
  const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
  let agent: BladeAgent | undefined;
  const connection = new acp.ClientSideConnection(
    () => client,
    acp.ndJsonStream(clientToAgent.writable, agentToClient.readable)
  );
  const agentConnection = new acp.AgentSideConnection(
    (productionConnection) => {
      agent = new BladeAgent(productionConnection);
      return agent;
    },
    acp.ndJsonStream(agentToClient.writable, clientToAgent.readable)
  );
  if (!agent) throw new Error('Token-budget ACP Agent was not created');
  const productionAgent = agent;
  let closePromise: Promise<void> | undefined;
  return {
    client,
    connection,
    close: () => {
      closePromise ??= (async () => {
        let failed = false;
        let firstError: unknown;
        await productionAgent.destroy().catch((error) => {
          failed = true;
          firstError = error;
        });
        await client.close().catch((error) => {
          if (!failed) firstError = error;
          failed = true;
        });
        try {
          const clientWriter = clientToAgent.writable.getWriter();
          const agentWriter = agentToClient.writable.getWriter();
          try {
            await Promise.all([clientWriter.close(), agentWriter.close()]);
          } finally {
            clientWriter.releaseLock();
            agentWriter.releaseLock();
          }
          await Promise.all([
            connection.closed.catch(() => undefined),
            agentConnection.closed.catch(() => undefined),
          ]);
        } catch (error) {
          if (!failed) firstError = error;
          failed = true;
        }
        if (failed) throw firstError;
      })();
      return closePromise;
    },
  };
}

export function finalAgentTextFromUpdates(
  updates: readonly acp.SessionNotification[]
): string {
  let finalText = '';
  for (const notification of updates) {
    const update = notification.update;
    if (update.sessionUpdate === 'tool_call') {
      finalText = '';
      continue;
    }
    if (
      update.sessionUpdate === 'agent_message_chunk' &&
      update.content.type === 'text'
    ) {
      finalText += update.content.text;
    }
  }
  return finalText;
}

type MessageTextChannel = 'agent_message_chunk' | 'user_message_chunk';

function hasUnexpectedMessageTextChunk(
  updates: readonly acp.SessionNotification[],
  forbidden: readonly string[],
  allowedChannels: ReadonlySet<MessageTextChannel>
): boolean {
  const needles = forbidden.filter(Boolean);
  const maxNeedle = Math.max(1, ...needles.map((value) => value.length));
  const tails = new Map<MessageTextChannel, string>();
  for (const notification of updates) {
    const update = notification.update;
    if (
      (update.sessionUpdate !== 'agent_message_chunk' &&
        update.sessionUpdate !== 'user_message_chunk') ||
      update.content.type !== 'text' ||
      !allowedChannels.has(update.sessionUpdate)
    ) {
      continue;
    }
    const scan = (tails.get(update.sessionUpdate) ?? '') + update.content.text;
    if (needles.some((value) => scan.includes(value))) return true;
    tails.set(update.sessionUpdate, scan.slice(-(maxNeedle - 1)));
  }
  return false;
}

export function hasUnexpectedSurfaceMessageChunk(
  updates: readonly acp.SessionNotification[],
  forbidden: readonly string[]
): boolean {
  return hasUnexpectedMessageTextChunk(
    updates,
    forbidden,
    new Set<MessageTextChannel>(['agent_message_chunk', 'user_message_chunk'])
  );
}

function emptySurfaceFacts(): SurfaceFacts {
  return {
    finalMarkerSeen: false,
    surfaceFinalPresent: false,
    surfaceFinalByteSizeBucket: 0,
    surfaceFinalSha256Prefix: null,
  };
}

function collectSurfaceFacts(
  updates: readonly acp.SessionNotification[],
  finalMarker: string
): SurfaceFacts {
  const finalText = finalAgentTextFromUpdates(updates);
  const surfaceFinalPresent = Boolean(finalText.trim());
  return {
    finalMarkerSeen: finalText === finalMarker,
    surfaceFinalPresent,
    surfaceFinalByteSizeBucket: byteSizeBucket(finalText),
    surfaceFinalSha256Prefix: surfaceFinalPresent
      ? createHash('sha256').update(finalText).digest('hex').slice(0, 12)
      : null,
  };
}

function buildRunnerFailureEvidence(input: {
  mode: RunnerInput['mode'];
  stage: RunnerFailureStage;
  timedOut: boolean;
  promptAttempted: boolean;
  stopReason: 'end_turn' | null;
  surface: SurfaceFacts;
  terminalCreationCount: number;
  terminalReleaseCount: number;
  activeTerminalCount: number;
  releasedProcessesGone: boolean;
  cleanupComplete: boolean;
  hiddenMaterialSeen: boolean;
}): RunnerFailureEvidence {
  const faults: RunnerFailureFault[] = ['runner_failed'];
  if (input.timedOut) faults.push('timeout');
  if (
    input.mode === 'task' &&
    input.promptAttempted &&
    !input.surface.finalMarkerSeen
  ) {
    faults.push('final_missing');
  }
  if (!input.cleanupComplete) faults.push('cleanup_incomplete');
  if (input.hiddenMaterialSeen) faults.push('hidden_material');
  return {
    success: false as const,
    mode: input.mode,
    stage: input.stage,
    timedOut: input.timedOut,
    promptAttempted: input.promptAttempted,
    stopReason: input.stopReason,
    finalMarkerSeen: input.surface.finalMarkerSeen,
    hiddenMaterialSeen: input.hiddenMaterialSeen,
    surfaceFinalPresent: input.surface.surfaceFinalPresent,
    surfaceFinalByteSizeBucket: input.surface.surfaceFinalByteSizeBucket,
    surfaceFinalSha256Prefix: input.surface.surfaceFinalSha256Prefix,
    terminalCreationCount: input.terminalCreationCount,
    terminalReleaseCount: input.terminalReleaseCount,
    activeTerminalCount: input.activeTerminalCount,
    releasedProcessesGone: input.releasedProcessesGone,
    cleanupComplete: input.cleanupComplete,
    exited: true as const,
    faults,
  };
}

export function hasUnexpectedLoadUserChunk(
  mode: 'task' | 'load',
  updates: readonly acp.SessionNotification[],
  forbidden: readonly string[]
): boolean {
  return (
    mode === 'load' &&
    hasUnexpectedMessageTextChunk(
      updates,
      forbidden,
      new Set<MessageTextChannel>(['user_message_chunk'])
    )
  );
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError()), timeoutMs);
  });
  return await Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function remainingOperationMs(deadlineAt: number): number {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) throw new TimeoutError();
  return remaining;
}

async function withDeadline<T>(
  operation: () => Promise<T>,
  deadlineAt: number
): Promise<T> {
  const timeoutMs = remainingOperationMs(deadlineAt);
  return await withTimeout(operation(), timeoutMs);
}

async function settleTimedOutPrompt<T>(input: {
  prompt: () => Promise<T>;
  deadlineAt: number;
  onStart: () => void;
  cancel: () => Promise<void>;
  close: () => Promise<void>;
}): Promise<T> {
  let started = false;
  try {
    return await withDeadline(() => {
      started = true;
      input.onStart();
      return input.prompt();
    }, input.deadlineAt);
  } catch (error) {
    if (started) await input.cancel().catch(() => undefined);
    await input.close().catch(() => undefined);
    throw error;
  }
}

async function runTimeoutCleanupProbe(
  setupTimeoutText: string | undefined,
  promptTimeoutText: string | undefined,
  workspaceText: string | undefined
): Promise<void> {
  const setupTimeoutMs = Number(setupTimeoutText);
  const promptTimeoutMs = Number(promptTimeoutText);
  if (
    !isPositiveSafeInteger(setupTimeoutMs) ||
    !isPositiveSafeInteger(promptTimeoutMs) ||
    typeof workspaceText !== 'string' ||
    !path.isAbsolute(workspaceText)
  ) {
    process.stdout.write(
      JSON.stringify({
        stage: 'initialize',
        promptAttempted: false,
        timedOut: false,
        cancelled: false,
        closed: false,
        naturalExit: false,
      })
    );
    process.exitCode = 1;
    return;
  }
  const workspace = path.resolve(workspaceText);
  let cancelled = false;
  let closed = false;
  const createProbeHarness: HarnessFactory = (forbidden) => {
    const production = createHarness(forbidden);
    const connection: RunnerConnection = {
      initialize: (params) => production.connection.initialize(params),
      newSession: (params) => production.connection.newSession(params),
      loadSession: (params) => production.connection.loadSession(params),
      setSessionMode: (params) => production.connection.setSessionMode(params),
      prompt: async (params) => {
        await production.client.createTerminal({
          sessionId: params.sessionId,
          command: 'sleep 60',
          cwd: workspace,
        });
        return await production.connection.prompt(params);
      },
      cancel: async (params) => {
        await production.connection.cancel(params);
        cancelled = true;
      },
    };
    return {
      client: production.client,
      connection,
      close: () =>
        production.close().finally(() => {
          closed = true;
        }),
    };
  };
  const evidence = await main(
    {
      mode: 'task',
      workspace,
      home: process.env.HOME ?? workspace,
      storageRoot: process.env.BLADE_STORAGE_ROOT ?? workspace,
      prompt: 'probe',
      finalMarker: 'FINAL_OK_PROBE',
      secrets: [],
      timeoutMs: promptTimeoutMs,
      setupTimeoutMs,
    },
    createProbeHarness
  );
  const timedOut = !evidence.success && evidence.timedOut;
  const stage = evidence.success ? 'evidence' : evidence.stage;
  const promptAttempted = !evidence.success && evidence.promptAttempted;
  const naturalExit =
    !evidence.success &&
    evidence.stage === 'prompt' &&
    evidence.cleanupComplete &&
    evidence.terminalCreationCount === 1 &&
    evidence.terminalReleaseCount === 1 &&
    evidence.activeTerminalCount === 0 &&
    evidence.releasedProcessesGone &&
    timedOut &&
    cancelled &&
    closed;
  process.stdout.write(
    JSON.stringify({
      stage,
      promptAttempted,
      timedOut,
      cancelled,
      closed,
      naturalExit,
    })
  );
  if (!naturalExit) {
    process.exitCode = 1;
  }
}

function createFailureEvidenceProbeHarness(probe: string): HarnessFactory {
  return (forbidden) => {
    const client = new RecordingClient(forbidden);
    let promptInvoked = false;
    let closed = false;
    const connection: RunnerConnection = {
      initialize: async () => {
        if (probe === 'pre-prompt-failure') {
          throw new Error('Synthetic pre-prompt failure');
        }
        return { protocolVersion: acp.PROTOCOL_VERSION };
      },
      newSession: async () => ({ sessionId: 'failure-evidence-probe' }),
      loadSession: async () => {
        if (probe === 'falsy-load-rejection') {
          return await Promise.reject(undefined);
        }
        return {};
      },
      setSessionMode: async () => {
        if (probe === 'set-mode-timeout') {
          return await new Promise<never>(() => undefined);
        }
        return {};
      },
      prompt: async () => {
        promptInvoked = true;
        await client.sessionUpdate({
          sessionId: 'failure-evidence-probe',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'VISIBLE_PARTIAL_' },
          },
        });
        if (probe === 'visible-timeout') {
          return await new Promise<never>(() => undefined);
        }
        throw new Error('Synthetic prompt rejection');
      },
      cancel: async () => undefined,
    };
    return {
      client,
      connection,
      close: async () => {
        if (closed) return;
        closed = true;
        if (promptInvoked) {
          await client.sessionUpdate({
            sessionId: 'failure-evidence-probe',
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'FINAL' },
            },
          });
        }
        if (probe === 'falsy-cleanup-rejection') {
          return await Promise.reject(undefined);
        }
        await client.close();
      },
    };
  };
}

async function runFailureEvidenceProbe(probe: string | undefined): Promise<void> {
  if (
    probe !== 'visible-rejection' &&
    probe !== 'visible-timeout' &&
    probe !== 'pre-prompt-failure' &&
    probe !== 'set-mode-timeout' &&
    probe !== 'falsy-load-rejection' &&
    probe !== 'falsy-cleanup-rejection'
  ) {
    process.exitCode = 1;
    return;
  }
  const load = probe === 'falsy-load-rejection' || probe === 'falsy-cleanup-rejection';
  const input: RunnerInput = load
    ? {
        mode: 'load',
        workspace: process.cwd(),
        home: process.cwd(),
        storageRoot: process.cwd(),
        sessionId: 'failure-evidence-probe',
        finalMarker: 'FINAL_OK_PROBE',
        secrets: [],
        timeoutMs: 10,
      }
    : {
        mode: 'task',
        workspace: process.cwd(),
        home: process.cwd(),
        storageRoot: process.cwd(),
        prompt: 'probe',
        finalMarker:
          probe === 'visible-timeout' ? 'VISIBLE_PARTIAL_FINAL' : 'FINAL_OK_PROBE',
        secrets: [],
        timeoutMs: 250,
      };
  const evidence = await main(input, createFailureEvidenceProbeHarness(probe));
  process.stdout.write(JSON.stringify(evidence));
}

async function main(
  input: RunnerInput,
  createHarnessForRun: HarnessFactory = createHarness
): Promise<RunnerEvidence> {
  const forbidden = [
    '<token-budget-handoff version="1">',
    'token_budget_handoff_recorded',
    TOKEN_BUDGET_HANDOFF_MESSAGE_ID_PREFIX,
    'Context rollover is approaching',
    ...input.secrets.filter(Boolean),
  ];
  const harness = createHarnessForRun(forbidden);
  let sessionId = input.sessionId ?? '';
  let stopReason: 'end_turn' | null = null;
  let surface = emptySurfaceFacts();
  let hiddenUserChunkSeen = false;
  let hiddenMarkerSeen = false;
  let promptAttempted = false;
  let failed = false;
  let operationFailed = false;
  let operationFailure: unknown;
  let failureStage: RunnerFailureStage = 'initialize';
  let operationDeadlineAt = Date.now() + (input.setupTimeoutMs ?? input.timeoutMs);
  try {
    await runWithCwdOverride(input.workspace, async () => {
      await withDeadline(
        () =>
          harness.connection.initialize({
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: { terminal: true },
          }),
        operationDeadlineAt
      );
      if (input.mode === 'task') {
        failureStage = 'new_session';
        const created = await withDeadline(
          () =>
            harness.connection.newSession({
              cwd: input.workspace,
              mcpServers: [],
            }),
          operationDeadlineAt
        );
        sessionId = created.sessionId;
        failureStage = 'set_mode';
        await withDeadline(
          () => harness.connection.setSessionMode({ sessionId, modeId: 'yolo' }),
          operationDeadlineAt
        );
        failureStage = 'prompt';
        if (input.setupTimeoutMs !== undefined) {
          operationDeadlineAt = Date.now() + input.timeoutMs;
        }
        const result = await settleTimedOutPrompt({
          prompt: () =>
            harness.connection.prompt({
              sessionId,
              prompt: [{ type: 'text', text: input.prompt ?? '' }],
            }),
          deadlineAt: operationDeadlineAt,
          onStart: () => {
            promptAttempted = true;
          },
          cancel: () => harness.connection.cancel({ sessionId }),
          close: harness.close,
        });
        stopReason = result.stopReason === 'end_turn' ? 'end_turn' : null;
      } else {
        failureStage = 'load';
        await withDeadline(
          () =>
            harness.connection.loadSession({
              sessionId,
              cwd: input.workspace,
              mcpServers: [],
            }),
          operationDeadlineAt
        );
      }
    });
    failureStage = 'evidence';
    const serialized = JSON.stringify({
      updates: harness.client.sessionUpdates,
      createRequests: harness.client.createRequests,
      terminalText: harness.client.terminalEvidence(),
    });
    hiddenMarkerSeen =
      harness.client.terminalExposedHiddenText() ||
      hasUnexpectedSurfaceMessageChunk(harness.client.sessionUpdates, forbidden) ||
      forbidden.some((value) => serialized.includes(value));
    hiddenUserChunkSeen = hasUnexpectedLoadUserChunk(
      input.mode,
      harness.client.sessionUpdates,
      forbidden
    );
    if (hiddenMarkerSeen || hiddenUserChunkSeen) {
      throw new Error('Token-budget ACP surface exposed hidden material');
    }
  } catch (error) {
    failed = true;
    operationFailed = true;
    operationFailure = error;
  }

  let cleanupFailed = false;
  if (!failed) failureStage = 'cleanup';
  await harness.close().catch(() => {
    cleanupFailed = true;
    if (!failed) failureStage = 'cleanup';
    failed = true;
  });
  if (promptAttempted) {
    surface = collectSurfaceFacts(harness.client.sessionUpdates, input.finalMarker);
  }
  try {
    const finalSerialized = JSON.stringify({
      updates: harness.client.sessionUpdates,
      createRequests: harness.client.createRequests,
      terminalText: harness.client.terminalEvidence(),
    });
    hiddenMarkerSeen ||=
      harness.client.terminalExposedHiddenText() ||
      hasUnexpectedSurfaceMessageChunk(harness.client.sessionUpdates, forbidden) ||
      forbidden.some((value) => value && finalSerialized.includes(value));
    hiddenUserChunkSeen ||= hasUnexpectedLoadUserChunk(
      input.mode,
      harness.client.sessionUpdates,
      forbidden
    );
  } catch {
    if (!failed) failureStage = 'evidence';
    failed = true;
  }
  if (hiddenMarkerSeen || hiddenUserChunkSeen) {
    if (!failed) failureStage = 'evidence';
    failed = true;
  }
  let terminalCreationCount = 0;
  let terminalReleaseCount = 0;
  let activeTerminalCount = 0;
  let releasedProcessesGone = false;
  try {
    terminalCreationCount = harness.client.createRequests.length;
    terminalReleaseCount = [...harness.client.releaseCounts.values()].reduce(
      (total, count) => total + count,
      0
    );
    activeTerminalCount = harness.client.activeTerminalCount();
    releasedProcessesGone =
      harness.client.releasedProcesses.length === terminalCreationCount &&
      harness.client.releasedProcesses.every(
        ({ pid, identity }) => !processIdentityMatches(pid, identity)
      );
  } catch {
    cleanupFailed = true;
    if (!failed) failureStage = 'cleanup';
    failed = true;
  }
  if (
    cleanupFailed ||
    terminalCreationCount !== terminalReleaseCount ||
    harness.client.releasedProcesses.length !== terminalCreationCount ||
    activeTerminalCount !== 0 ||
    !releasedProcessesGone
  ) {
    if (!failed) failureStage = 'cleanup';
    failed = true;
  }
  if (failed || !isValidSessionId(sessionId)) {
    if (!failed) failureStage = 'evidence';
    const timedOut = operationFailed && operationFailure instanceof TimeoutError;
    const cleanupComplete =
      !cleanupFailed &&
      terminalCreationCount === terminalReleaseCount &&
      harness.client.releasedProcesses.length === terminalCreationCount &&
      activeTerminalCount === 0 &&
      releasedProcessesGone;
    return buildRunnerFailureEvidence({
      mode: input.mode,
      stage: failureStage,
      timedOut,
      promptAttempted,
      stopReason,
      surface,
      terminalCreationCount,
      terminalReleaseCount,
      activeTerminalCount,
      releasedProcessesGone,
      cleanupComplete,
      hiddenMaterialSeen: hiddenMarkerSeen || hiddenUserChunkSeen,
    });
  }
  return {
    success: true,
    mode: input.mode,
    sessionId,
    stopReason,
    finalMarkerSeen: surface.finalMarkerSeen,
    surfaceFinalPresent: surface.surfaceFinalPresent,
    surfaceFinalByteSizeBucket: surface.surfaceFinalByteSizeBucket,
    surfaceFinalSha256Prefix: surface.surfaceFinalSha256Prefix,
    hiddenMarkerSeen: false,
    hiddenUserChunkSeen: false,
    terminalCreationCount,
    terminalReleaseCount,
    activeTerminalCount: 0,
    releasedProcessesGone: true,
    exited: true,
    faults: [],
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args[0] === '--timeout-cleanup-probe') {
    await ensureStoreInitialized();
    WorkspaceTrustService.resetInstance();
    const workspace = args.length === 4 ? args[3] : undefined;
    if (!workspace || !path.isAbsolute(workspace)) {
      throw new Error('Cleanup probe workspace is invalid');
    }
    await WorkspaceTrustService.getInstance().trust(workspace);
    try {
      await runTimeoutCleanupProbe(args[1], args[2], workspace);
    } finally {
      WorkspaceTrustService.resetInstance();
    }
  } else if (args[0] === '--failure-evidence-probe') {
    await runFailureEvidenceProbe(args.length === 2 ? args[1] : undefined);
  } else {
    const input = loadInput();
    delete process.env.BLADE_TOKEN_BUDGET_ACP_INPUT;
    await ensureStoreInitialized();
    WorkspaceTrustService.resetInstance();
    await WorkspaceTrustService.getInstance().trust(input.workspace);
    try {
      const evidence = await main(input);
      process.stdout.write(JSON.stringify(evidence));
      if (!evidence.success) process.exitCode = 1;
    } finally {
      WorkspaceTrustService.resetInstance();
    }
  }
}
