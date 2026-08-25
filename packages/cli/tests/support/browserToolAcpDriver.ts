import * as acp from '@agentclientprotocol/sdk';
import { BladeAgent } from '../../src/acp/BladeAgent.js';
import { runWithCwdOverride } from '../../src/utils/cwd.js';
import type { BrowserToolFixture } from '../integration/real-api/browser-tool-fixture.js';
import { ChildBackedRecordingAcpClient } from './acp/ChildBackedRecordingAcpClient.js';

interface AcpHarness {
  client: ChildBackedRecordingAcpClient;
  connection: acp.ClientSideConnection;
  close(): Promise<void>;
}

function createHarness(): AcpHarness {
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
  if (!agent) throw new Error('ACP Browser Tool Agent was not created');
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

function finalText(updates: readonly acp.SessionNotification[]): string {
  return updates
    .flatMap((notification) =>
      notification.update.sessionUpdate === 'agent_message_chunk' &&
      notification.update.content.type === 'text'
        ? [notification.update.content.text]
        : []
    )
    .join('');
}

export interface BrowserToolAcpEvidence {
  sessionId: string;
  finalText: string;
  updates: acp.SessionNotification[];
}

export async function runBrowserToolAcpDriver(input: {
  workspace: string;
  fixture: BrowserToolFixture;
  secret: string;
  timeoutMs?: number;
}): Promise<BrowserToolAcpEvidence> {
  const harness = createHarness();
  let sessionId = '';
  try {
    await runWithCwdOverride(input.workspace, async () => {
      await harness.connection.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { terminal: true },
      });
      const created = await harness.connection.newSession({
        cwd: input.workspace,
        mcpServers: [],
      });
      sessionId = created.sessionId;
      await harness.connection.setSessionMode({
        sessionId,
        modeId: 'yolo',
      });
      const prompt = harness.connection.prompt({
        sessionId,
        prompt: [{ type: 'text', text: input.fixture.prompt }],
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          void harness.connection.cancel({ sessionId });
          reject(new Error('ACP Browser Tool prompt timed out'));
        }, input.timeoutMs ?? 240_000);
      });
      const result = await Promise.race([prompt, timeout]).finally(() => {
        if (timer) clearTimeout(timer);
      });
      if (result.stopReason !== 'end_turn') {
        throw new Error(`ACP Browser Tool stopped with ${result.stopReason}`);
      }
    });

    const updates = [...harness.client.sessionUpdates];
    const text = finalText(updates);
    if (!text.includes(input.fixture.finalMarker)) {
      throw new Error('ACP Browser Tool final marker is missing');
    }
    const serialized = JSON.stringify(updates);
    if (serialized.includes(input.secret)) {
      throw new Error('ACP Browser Tool updates contain Provider credentials');
    }
    if (serialized.includes('browser-artifacts/')) {
      throw new Error('ACP Browser Tool updates expose a local screenshot path');
    }
    return { sessionId, finalText: text, updates };
  } finally {
    await harness.close();
  }
}
