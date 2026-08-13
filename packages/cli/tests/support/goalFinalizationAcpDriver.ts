import * as acp from '@agentclientprotocol/sdk';
import { BladeAgent } from '../../src/acp/BladeAgent.js';
import { runWithCwdOverride } from '../../src/utils/cwd.js';

class RecordingClient implements acp.Client {
  readonly updates: acp.SessionNotification[] = [];

  async requestPermission(): Promise<acp.RequestPermissionResponse> {
    return {
      outcome: {
        outcome: 'selected',
        optionId: 'allow_once',
      },
    };
  }

  async sessionUpdate(params: acp.SessionNotification): Promise<void> {
    this.updates.push(params);
  }
}

interface AcpHarness {
  client: RecordingClient;
  connection: acp.ClientSideConnection;
  close(): Promise<void>;
}

function createHarness(): AcpHarness {
  const client = new RecordingClient();
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
  if (!agent) throw new Error('ACP Goal finalization Agent was not created');
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

function hasCompletedGoal(updates: readonly acp.SessionNotification[]): boolean {
  return updates.some((notification) => {
    const update = notification.update;
    if (update.sessionUpdate !== 'session_info_update') return false;
    const goal = update._meta?.['blade/goal'];
    return (
      goal !== null &&
      typeof goal === 'object' &&
      !Array.isArray(goal) &&
      'status' in goal &&
      goal.status === 'complete'
    );
  });
}

export interface GoalFinalizationAcpEvidence {
  initialText: string;
  followupText: string;
  updates: acp.SessionNotification[];
}

export async function runGoalFinalizationAcpDriver(input: {
  workspace: string;
  sessionId: string;
  expectedInitial: string;
  followupPrompt: string;
  expectedFollowup: string;
  secret: string;
}): Promise<GoalFinalizationAcpEvidence> {
  const harness = createHarness();
  try {
    await runWithCwdOverride(input.workspace, async () => {
      await harness.connection.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      await harness.connection.loadSession({
        sessionId: input.sessionId,
        cwd: input.workspace,
        mcpServers: [],
      });
    });
    const initialUpdates = [...harness.client.updates];
    const initialText = agentText(initialUpdates);
    if (!initialText.includes(input.expectedInitial)) {
      throw new Error('ACP did not replay the recovered final response');
    }
    if (!hasCompletedGoal(initialUpdates)) {
      throw new Error('ACP did not project the recovered complete Goal');
    }

    await runWithCwdOverride(input.workspace, () =>
      harness.connection.prompt({
        sessionId: input.sessionId,
        prompt: [{ type: 'text', text: input.followupPrompt }],
      })
    );
    const followupUpdates = harness.client.updates.slice(initialUpdates.length);
    const followupText = agentText(followupUpdates);
    if (!followupText.includes(input.expectedFollowup)) {
      throw new Error('ACP real Provider follow-up did not complete');
    }

    const updates = [...harness.client.updates];
    if (JSON.stringify(updates).includes(input.secret)) {
      throw new Error('ACP Goal finalization evidence exposed Provider credentials');
    }
    return { initialText, followupText, updates };
  } finally {
    await harness.close();
  }
}
