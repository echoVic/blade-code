import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import * as acp from '@agentclientprotocol/sdk';
import { BladeAgent } from '../../src/acp/BladeAgent.js';
import { runWithCwdOverride } from '../../src/utils/cwd.js';
import type { ProcessIdentity } from '../../src/utils/process/ProcessIdentity.js';
import type { ForegroundBoundedOutputFixture } from '../integration/real-api/foregroundBoundedOutputFixture.js';
import { ChildBackedRecordingAcpClient } from './acp/ChildBackedRecordingAcpClient.js';

const execFileAsync = promisify(execFile);
const ACP_EVIDENCE_PREFIX = '__BLADE_BOUNDED_ACP_EVIDENCE__';

interface PairedHarness {
  client: ChildBackedRecordingAcpClient;
  connection: acp.ClientSideConnection;
  egressMetrics: {
    sessionUpdateCalls: number;
    sessionUpdateInFlight: number;
    maxSessionUpdateInFlight: number;
  };
  close(): Promise<void>;
}

function createHarness(options: { sessionUpdateDelayMs?: number } = {}): PairedHarness {
  const client = new ChildBackedRecordingAcpClient();
  const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
  const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
  let agent: BladeAgent | undefined;
  const egressMetrics = {
    sessionUpdateCalls: 0,
    sessionUpdateInFlight: 0,
    maxSessionUpdateInFlight: 0,
  };
  const connection = new acp.ClientSideConnection(
    () => client,
    acp.ndJsonStream(clientToAgent.writable, agentToClient.readable)
  );
  const agentConnection = new acp.AgentSideConnection(
    (productionConnection) => {
      const sessionUpdate =
        productionConnection.sessionUpdate.bind(productionConnection);
      productionConnection.sessionUpdate = async (params) => {
        egressMetrics.sessionUpdateCalls += 1;
        egressMetrics.sessionUpdateInFlight += 1;
        egressMetrics.maxSessionUpdateInFlight = Math.max(
          egressMetrics.maxSessionUpdateInFlight,
          egressMetrics.sessionUpdateInFlight
        );
        try {
          if (options.sessionUpdateDelayMs) {
            await new Promise((resolve) =>
              setTimeout(resolve, options.sessionUpdateDelayMs)
            );
          }
          await sessionUpdate(params);
        } finally {
          egressMetrics.sessionUpdateInFlight -= 1;
        }
      };
      agent = new BladeAgent(productionConnection);
      return agent;
    },
    acp.ndJsonStream(agentToClient.writable, clientToAgent.readable)
  );
  if (!agent) throw new Error('ACP bounded output Agent was not created');
  const productionAgent = agent;
  let closePromise: Promise<void> | undefined;
  return {
    client,
    connection,
    egressMetrics,
    close: () => {
      closePromise ??= (async () => {
        let firstError: unknown;
        try {
          await productionAgent.destroy();
        } catch (error) {
          firstError = error;
        }
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

function finalAgentText(notifications: readonly acp.SessionNotification[]): string {
  return notifications
    .flatMap((notification) =>
      notification.update.sessionUpdate === 'agent_message_chunk' &&
      notification.update.content.type === 'text'
        ? [notification.update.content.text]
        : []
    )
    .join('');
}

export interface ForegroundBoundedOutputAcpEvidence {
  sessionId: string;
  finalText: string;
  toolUpdateText: string;
  terminalReleaseCount: number;
  loadReplayedToolCount: number;
  sessionUpdateCalls: number;
  maxSessionUpdateInFlight: number;
  updates: acp.SessionNotification[];
  processes: Array<{ pid: number; identity: ProcessIdentity }>;
}

export interface ForegroundBoundedOutputAcpToolFacts {
  finalCount: number;
  finalStatus: string | null | undefined;
  progressContainsRawOutput: boolean;
  hasStdoutTail: boolean;
  hasStderrTail: boolean;
  hasStdoutPrefix: boolean;
  hasStderrPrefix: boolean;
  finalText: string;
}

type AcpToolCallUpdateNotification = acp.SessionNotification & {
  update: Extract<
    acp.SessionNotification['update'],
    { sessionUpdate: 'tool_call_update' }
  >;
};

function isToolCallUpdate(
  notification: acp.SessionNotification
): notification is AcpToolCallUpdateNotification {
  return notification.update.sessionUpdate === 'tool_call_update';
}

export function inspectForegroundBoundedOutputAcpToolUpdates(
  updates: readonly acp.SessionNotification[],
  toolCallId: string,
  fixture: Pick<
    ForegroundBoundedOutputFixture,
    'stdoutPrefixSentinel' | 'stderrPrefixSentinel' | 'stdoutTail' | 'stderrTail'
  >
): ForegroundBoundedOutputAcpToolFacts {
  const matching = updates
    .filter(isToolCallUpdate)
    .filter((notification) => notification.update.toolCallId === toolCallId);
  const progressText = JSON.stringify(
    matching.filter((notification) => notification.update.status === 'in_progress')
  );
  const finals = matching.filter(
    (notification) =>
      notification.update.status === 'completed' ||
      notification.update.status === 'failed'
  );
  const final = finals.at(-1);
  const finalText = final ? JSON.stringify(final) : '';
  const rawMarkers = [
    fixture.stdoutPrefixSentinel,
    fixture.stderrPrefixSentinel,
    fixture.stdoutTail,
    fixture.stderrTail,
  ];

  return {
    finalCount: finals.length,
    finalStatus: final?.update.status,
    progressContainsRawOutput: rawMarkers.some((marker) =>
      progressText.includes(marker)
    ),
    hasStdoutTail: finalText.includes(fixture.stdoutTail),
    hasStderrTail: finalText.includes(fixture.stderrTail),
    hasStdoutPrefix: finalText.includes(fixture.stdoutPrefixSentinel),
    hasStderrPrefix: finalText.includes(fixture.stderrPrefixSentinel),
    finalText,
  };
}

export async function runForegroundBoundedOutputAcpDriverInProcess(input: {
  workspace: string;
  fixture: ForegroundBoundedOutputFixture;
  secret: string;
  timeoutMs?: number;
}): Promise<ForegroundBoundedOutputAcpEvidence> {
  const first = createHarness({ sessionUpdateDelayMs: 25 });
  let sessionId = '';
  let updates: acp.SessionNotification[] = [];
  let finalText = '';
  let toolUpdateText = '';
  let terminalReleaseCount = 0;
  let processes: Array<{ pid: number; identity: ProcessIdentity }> = [];
  try {
    await runWithCwdOverride(input.workspace, async () => {
      await first.connection.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { terminal: true },
      });
      const created = await first.connection.newSession({
        cwd: input.workspace,
        mcpServers: [],
      });
      sessionId = created.sessionId;
      await first.connection.setSessionMode({
        sessionId,
        modeId: 'yolo',
      });
      const prompt = first.connection.prompt({
        sessionId,
        prompt: [{ type: 'text', text: input.fixture.acpPrompt }],
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          void first.connection.cancel({ sessionId });
          reject(new Error('ACP bounded output prompt timed out'));
        }, input.timeoutMs ?? 180_000);
      });
      const result = await Promise.race([prompt, timeout]).finally(() => {
        if (timer) clearTimeout(timer);
      });
      if (result.stopReason !== 'end_turn') {
        throw new Error(`ACP bounded output stopped with ${result.stopReason}`);
      }
    });

    updates = [...first.client.sessionUpdates];
    finalText = finalAgentText(updates);
    const bashStarts = updates.filter(
      (notification) =>
        notification.update.sessionUpdate === 'tool_call' &&
        notification.update.title.includes('Bash')
    );
    if (bashStarts.length !== 1) {
      throw new Error(
        `ACP bounded output expected one Bash call, got ${bashStarts.length}`
      );
    }
    const toolCallId =
      bashStarts[0]?.update.sessionUpdate === 'tool_call'
        ? bashStarts[0].update.toolCallId
        : '';
    const terminalUpdates = updates.filter(
      (notification) =>
        notification.update.sessionUpdate === 'tool_call_update' &&
        notification.update.toolCallId === toolCallId
    );
    const toolFacts = inspectForegroundBoundedOutputAcpToolUpdates(
      updates,
      toolCallId,
      input.fixture
    );
    toolUpdateText = toolFacts.finalText;
    if (
      toolFacts.finalCount !== 1 ||
      toolFacts.finalStatus !== 'completed' ||
      toolFacts.progressContainsRawOutput ||
      !toolFacts.hasStdoutTail ||
      !toolFacts.hasStderrTail ||
      toolFacts.hasStdoutPrefix ||
      toolFacts.hasStderrPrefix
    ) {
      throw new Error(
        `ACP live tool update violated bounded output markers: ${JSON.stringify({
          finalCount: toolFacts.finalCount,
          finalStatus: toolFacts.finalStatus,
          progressContainsRawOutput: toolFacts.progressContainsRawOutput,
          hasStdoutTail: toolFacts.hasStdoutTail,
          hasStderrTail: toolFacts.hasStderrTail,
          hasStdoutPrefix: toolFacts.hasStdoutPrefix,
          hasStderrPrefix: toolFacts.hasStderrPrefix,
          finalPreview: toolFacts.finalText
            .replaceAll(input.secret, '[REDACTED]')
            .slice(-1_000),
        })}`
      );
    }
    if (
      terminalUpdates.some(
        (notification) =>
          '_meta' in notification.update && notification.update._meta !== undefined
      )
    ) {
      throw new Error('ACP live tool update exposed a private metadata extension');
    }
    if (
      !finalText.includes(
        `BOUNDED_FOREGROUND_ACP_OK_${input.fixture.stdoutTail.replace(
          'STDOUT_RETAINED_TAIL_',
          ''
        )}`
      )
    ) {
      throw new Error(
        `ACP final response marker is missing: ${JSON.stringify({
          finalTextLength: finalText.length,
          finalTextPreview: finalText
            .replaceAll(input.secret, '[REDACTED]')
            .slice(-1_000),
        })}`
      );
    }
    if (
      first.egressMetrics.sessionUpdateCalls === 0 ||
      first.egressMetrics.maxSessionUpdateInFlight !== 1 ||
      first.egressMetrics.sessionUpdateInFlight !== 0
    ) {
      throw new Error(
        `ACP ordered egress metrics are invalid: ${JSON.stringify(first.egressMetrics)}`
      );
    }
    if (JSON.stringify(updates).includes(input.secret)) {
      throw new Error('ACP notification evidence contains secret material');
    }
    terminalReleaseCount = [...first.client.releaseCounts.values()].reduce(
      (total, count) => total + count,
      0
    );
    if (terminalReleaseCount !== 1 || first.client.activeTerminalCount() !== 0) {
      throw new Error('ACP terminal handle was not released exactly once');
    }
    processes = [...first.client.releasedProcesses];
  } finally {
    await first.close().catch(() => undefined);
  }

  const second = createHarness();
  let loadReplayedToolCount = 0;
  try {
    await runWithCwdOverride(input.workspace, async () => {
      await second.connection.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { terminal: true },
      });
      await second.connection.loadSession({
        sessionId,
        cwd: input.workspace,
        mcpServers: [],
      });
    });
    loadReplayedToolCount = second.client.sessionUpdates.filter(
      (notification) =>
        notification.update.sessionUpdate === 'tool_call' ||
        notification.update.sessionUpdate === 'tool_call_update'
    ).length;
    if (loadReplayedToolCount !== 0) {
      throw new Error('ACP session/load replayed historical tool calls');
    }
  } finally {
    await second.close().catch(() => undefined);
  }

  return {
    sessionId,
    finalText,
    toolUpdateText,
    terminalReleaseCount,
    loadReplayedToolCount,
    sessionUpdateCalls: first.egressMetrics.sessionUpdateCalls,
    maxSessionUpdateInFlight: first.egressMetrics.maxSessionUpdateInFlight,
    updates,
    processes,
  };
}

export async function runForegroundBoundedOutputAcpDriver(input: {
  workspace: string;
  fixture: ForegroundBoundedOutputFixture;
  secret: string;
  timeoutMs?: number;
}): Promise<ForegroundBoundedOutputAcpEvidence> {
  const runner = path.resolve(
    import.meta.dirname,
    'foregroundBoundedOutputAcpRunner.ts'
  );
  const encodedInput = Buffer.from(JSON.stringify(input), 'utf8').toString('base64');
  const result = await execFileAsync('bun', [runner], {
    cwd: path.resolve(import.meta.dirname, '../..'),
    env: {
      ...process.env,
      BLADE_BOUNDED_ACP_INPUT: encodedInput,
    },
    timeout: input.timeoutMs ?? 180_000,
    maxBuffer: 1024 * 1024,
    killSignal: 'SIGKILL',
  });
  const evidenceLine = result.stdout
    .split(/\r?\n/)
    .findLast((line) => line.startsWith(ACP_EVIDENCE_PREFIX));
  if (!evidenceLine) {
    throw new Error('Bun ACP runner did not return bounded evidence');
  }
  return JSON.parse(
    evidenceLine.slice(ACP_EVIDENCE_PREFIX.length)
  ) as ForegroundBoundedOutputAcpEvidence;
}

export function encodeForegroundBoundedOutputAcpEvidence(
  evidence: ForegroundBoundedOutputAcpEvidence
): string {
  return `${ACP_EVIDENCE_PREFIX}${JSON.stringify(evidence)}`;
}
