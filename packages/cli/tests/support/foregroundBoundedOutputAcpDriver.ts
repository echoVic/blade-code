import * as acp from '@agentclientprotocol/sdk';
import { BladeAgent } from '../../src/acp/BladeAgent.js';
import { runWithCwdOverride } from '../../src/utils/cwd.js';
import type { ProcessIdentity } from '../../src/utils/process/ProcessIdentity.js';
import type { ForegroundBoundedOutputFixture } from '../integration/real-api/foregroundBoundedOutputFixture.js';
import { ChildBackedRecordingAcpClient } from './acp/ChildBackedRecordingAcpClient.js';

interface PairedHarness {
  client: ChildBackedRecordingAcpClient;
  connection: acp.ClientSideConnection;
  close(): Promise<void>;
}

function createHarness(): PairedHarness {
  const client = new ChildBackedRecordingAcpClient();
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
  if (!agent) throw new Error('ACP bounded output Agent was not created');
  const productionAgent = agent;
  let closePromise: Promise<void> | undefined;
  return {
    client,
    connection,
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

function finalAgentText(
  notifications: readonly acp.SessionNotification[]
): string {
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
  updates: acp.SessionNotification[];
  processes: Array<{ pid: number; identity: ProcessIdentity }>;
}

export async function runForegroundBoundedOutputAcpDriver(input: {
  workspace: string;
  fixture: ForegroundBoundedOutputFixture;
  secret: string;
  timeoutMs?: number;
}): Promise<ForegroundBoundedOutputAcpEvidence> {
  const first = createHarness();
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
      throw new Error(`ACP bounded output expected one Bash call, got ${bashStarts.length}`);
    }
    const terminalUpdates = updates.filter(
      (notification) =>
        notification.update.sessionUpdate === 'tool_call_update' &&
        notification.update.toolCallId ===
          (bashStarts[0]?.update.sessionUpdate === 'tool_call'
            ? bashStarts[0].update.toolCallId
            : undefined)
    );
    toolUpdateText = JSON.stringify(terminalUpdates);
    if (
      !toolUpdateText.includes(input.fixture.stdoutTail) ||
      !toolUpdateText.includes(input.fixture.stderrTail) ||
      toolUpdateText.includes(input.fixture.stdoutPrefixSentinel) ||
      toolUpdateText.includes(input.fixture.stderrPrefixSentinel)
    ) {
      throw new Error('ACP live tool update violated bounded output markers');
    }
    if (
      terminalUpdates.some(
        (notification) =>
          '_meta' in notification.update &&
          notification.update._meta !== undefined
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
      throw new Error('ACP final response marker is missing');
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
    updates,
    processes,
  };
}
