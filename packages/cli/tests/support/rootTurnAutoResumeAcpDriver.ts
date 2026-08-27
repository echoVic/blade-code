import { access } from 'node:fs/promises';
import * as acp from '@agentclientprotocol/sdk';
import { BladeAgent } from '../../src/acp/BladeAgent.js';
import { getSessionInboxFilePath } from '../../src/context/storage/pathUtils.js';
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
  if (!agent) throw new Error('ACP root-turn Agent was not created');
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

function finalAgentText(updates: readonly acp.SessionNotification[]): string {
  return updates
    .flatMap((notification) =>
      notification.update.sessionUpdate === 'agent_message_chunk' &&
      notification.update.content.type === 'text'
        ? [notification.update.content.text]
        : []
    )
    .join('');
}

function describeAcpPromptFailure(error: unknown, secret: string): string {
  const candidate = error as {
    message?: unknown;
    code?: unknown;
    data?: unknown;
  };
  let detail: string;
  try {
    detail = JSON.stringify({
      message: candidate?.message,
      code: candidate?.code,
      data: candidate?.data,
    });
  } catch {
    detail = error instanceof Error ? error.message : String(error);
  }
  return secret ? detail.replaceAll(secret, '[REDACTED]') : detail;
}

async function inboxIsMissing(workspace: string, sessionId: string): Promise<boolean> {
  try {
    await access(getSessionInboxFilePath(workspace, sessionId));
    return false;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return true;
    }
    throw error;
  }
}

async function waitForRecovery(input: {
  harness: AcpHarness;
  workspace: string;
  sessionId: string;
  expected: string;
  timeoutMs: number;
}): Promise<void> {
  const deadline = Date.now() + input.timeoutMs;
  while (Date.now() < deadline) {
    if (
      finalAgentText(input.harness.client.updates).includes(input.expected) &&
      (await inboxIsMissing(input.workspace, input.sessionId))
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('ACP root-turn recovery timed out');
}

async function waitForAttention(harness: AcpHarness, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const projected = harness.client.updates.some(
      ({ update }) =>
        update.sessionUpdate === 'session_info_update' &&
        (update._meta?.['blade/turnRecovery'] as { state?: unknown } | undefined)
          ?.state === 'requires_attention'
    );
    if (projected) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('ACP root-turn attention projection timed out');
}

export interface RootTurnAutoResumeAcpEvidence {
  attentionProjected: true;
  finalText: string;
  updates: acp.SessionNotification[];
}

export async function runRootTurnAutoResumeAcpDriver(input: {
  workspace: string;
  home: string;
  sessionId: string;
  expected: string;
  secret: string;
  timeoutMs?: number;
}): Promise<RootTurnAutoResumeAcpEvidence> {
  const previousHome = process.env.HOME;
  process.env.HOME = input.home;
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
      await waitForAttention(harness, 30_000);
      if (finalAgentText(harness.client.updates)) {
        throw new Error('ACP root-turn recovery replayed before explicit input');
      }
      let result: acp.PromptResponse;
      try {
        result = await harness.connection.prompt({
          sessionId: input.sessionId,
          prompt: [
            {
              type: 'text',
              text:
                'I inspected the workspace and external state. Continue safely ' +
                'without repeating any write or other side effect.',
            },
          ],
        });
      } catch (error) {
        throw new Error(
          `ACP explicit recovery prompt failed: ${describeAcpPromptFailure(
            error,
            input.secret
          )}`
        );
      }
      if (result.stopReason !== 'end_turn') {
        throw new Error(`ACP explicit recovery stopped with ${result.stopReason}`);
      }
      await waitForRecovery({
        harness,
        workspace: input.workspace,
        sessionId: input.sessionId,
        expected: input.expected,
        timeoutMs: input.timeoutMs ?? 120_000,
      });
    });

    const updates = [...harness.client.updates];
    if (JSON.stringify(updates).includes(input.secret)) {
      throw new Error('ACP root-turn recovery exposed the Provider credential');
    }
    return {
      attentionProjected: true,
      finalText: finalAgentText(updates),
      updates,
    };
  } finally {
    try {
      await harness.close();
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  }
}
