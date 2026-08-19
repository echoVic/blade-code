import path from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import { BladeAgent } from '../../src/acp/BladeAgent.js';
import { TOKEN_BUDGET_HANDOFF_MESSAGE_ID_PREFIX } from '../../src/context/TokenBudgetHandoff.js';
import {
  assertValidSessionId,
  isValidSessionId,
} from '../../src/context/storage/pathUtils.js';
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
  connection: acp.ClientSideConnection;
  close(): Promise<void>;
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
        let firstError: unknown;
        await productionAgent.destroy().catch((error) => {
          firstError = error;
        });
        await client.close().catch((error) => {
          firstError ??= error;
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
          firstError ??= error;
        }
        if (firstError !== undefined) throw firstError;
      })();
      return closePromise;
    },
  };
}

function agentText(updates: readonly acp.SessionNotification[]): string {
  return updates
    .flatMap((notification) =>
      notification.update.sessionUpdate === 'agent_message_chunk' &&
      notification.update.content.type === 'text'
        ? [notification.update.content.text]
        : []
    )
    .join('');
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error('Token-budget ACP timed out')),
      timeoutMs
    );
  });
  return await Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function main(input: RunnerInput): Promise<void> {
  const forbidden = [
    '<token-budget-handoff version="1">',
    'token_budget_handoff_recorded',
    TOKEN_BUDGET_HANDOFF_MESSAGE_ID_PREFIX,
    'Context rollover is approaching',
    ...input.secrets.filter(Boolean),
  ];
  const harness = createHarness(forbidden);
  let sessionId = input.sessionId ?? '';
  let stopReason: 'end_turn' | null = null;
  let finalMarkerSeen = false;
  let hiddenUserChunkSeen = false;
  let hiddenMarkerSeen = false;
  let failure: unknown;
  try {
    await runWithCwdOverride(input.workspace, async () => {
      await harness.connection.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { terminal: true },
      });
      if (input.mode === 'task') {
        const created = await harness.connection.newSession({
          cwd: input.workspace,
          mcpServers: [],
        });
        sessionId = created.sessionId;
        await harness.connection.setSessionMode({ sessionId, modeId: 'yolo' });
        const prompt = harness.connection.prompt({
          sessionId,
          prompt: [{ type: 'text', text: input.prompt ?? '' }],
        });
        let result: Awaited<typeof prompt>;
        try {
          result = await withTimeout(prompt, input.timeoutMs);
        } catch (error) {
          await harness.connection.cancel({ sessionId }).catch(() => undefined);
          throw error;
        }
        stopReason = result.stopReason === 'end_turn' ? 'end_turn' : null;
        finalMarkerSeen =
          agentText(harness.client.sessionUpdates) === input.finalMarker;
      } else {
        await withTimeout(
          harness.connection.loadSession({
            sessionId,
            cwd: input.workspace,
            mcpServers: [],
          }),
          input.timeoutMs
        );
      }
    });
    const serialized = JSON.stringify({
      updates: harness.client.sessionUpdates,
      createRequests: harness.client.createRequests,
      terminalText: harness.client.terminalEvidence(),
    });
    hiddenMarkerSeen =
      harness.client.terminalExposedHiddenText() ||
      forbidden.some((value) => serialized.includes(value));
    hiddenUserChunkSeen =
      input.mode === 'load' &&
      harness.client.sessionUpdates.some((notification) => {
        const update = notification.update;
        if (
          update.sessionUpdate !== 'user_message_chunk' ||
          update.content.type !== 'text'
        ) {
          return false;
        }
        const text = update.content.text;
        return forbidden.some((value) => value && text.includes(value));
      });
    if (hiddenMarkerSeen || hiddenUserChunkSeen) {
      throw new Error('Token-budget ACP surface exposed hidden material');
    }
  } catch (error) {
    failure = error;
  }

  await harness.close().catch((error) => {
    failure ??= error;
  });
  const finalSerialized = JSON.stringify({
    updates: harness.client.sessionUpdates,
    createRequests: harness.client.createRequests,
    terminalText: harness.client.terminalEvidence(),
  });
  hiddenMarkerSeen ||=
    harness.client.terminalExposedHiddenText() ||
    forbidden.some((value) => value && finalSerialized.includes(value));
  hiddenUserChunkSeen ||=
    input.mode === 'load' &&
    harness.client.sessionUpdates.some((notification) => {
      const update = notification.update;
      if (
        update.sessionUpdate !== 'user_message_chunk' ||
        update.content.type !== 'text'
      ) {
        return false;
      }
      const text = update.content.text;
      return forbidden.some((value) => value && text.includes(value));
    });
  if (hiddenMarkerSeen || hiddenUserChunkSeen) {
    failure ??= new Error('Token-budget ACP teardown exposed hidden material');
  }
  const terminalCreationCount = harness.client.createRequests.length;
  const terminalReleaseCount = [...harness.client.releaseCounts.values()].reduce(
    (total, count) => total + count,
    0
  );
  const activeTerminalCount = harness.client.activeTerminalCount();
  const releasedProcessesGone = harness.client.releasedProcesses.every(
    ({ pid, identity }) => !processIdentityMatches(pid, identity)
  );
  if (
    terminalCreationCount !== terminalReleaseCount ||
    harness.client.releasedProcesses.length !== terminalCreationCount ||
    activeTerminalCount !== 0 ||
    !releasedProcessesGone
  ) {
    failure ??= new Error('Token-budget ACP terminal cleanup did not complete');
  }
  if (failure || !isValidSessionId(sessionId)) {
    process.stdout.write(JSON.stringify({ success: false, faults: ['runner_failed'] }));
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    JSON.stringify({
      success: true,
      mode: input.mode,
      sessionId,
      stopReason,
      finalMarkerSeen,
      hiddenMarkerSeen: false,
      hiddenUserChunkSeen: false,
      terminalCreationCount,
      terminalReleaseCount,
      activeTerminalCount: 0,
      releasedProcessesGone: true,
      exited: true,
      faults: [],
    })
  );
}

if (import.meta.main) {
  const input = loadInput();
  delete process.env.BLADE_TOKEN_BUDGET_ACP_INPUT;
  await ensureStoreInitialized();
  WorkspaceTrustService.resetInstance();
  await WorkspaceTrustService.getInstance().trust(input.workspace);
  try {
    await main(input);
  } finally {
    WorkspaceTrustService.resetInstance();
  }
}
