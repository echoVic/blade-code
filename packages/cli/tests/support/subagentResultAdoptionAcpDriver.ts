import { access } from 'node:fs/promises';
import * as acp from '@agentclientprotocol/sdk';
import { getSessionInboxFilePath } from '../../src/context/storage/pathUtils.js';
import { runWithCwdOverride } from '../../src/utils/cwd.js';
import { createBladeAcpHarness } from './acp/createBladeAcpHarness.js';

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

export interface SubagentResultAdoptionAcpEvidence {
  finalText: string;
  updates: acp.SessionNotification[];
}

export async function runSubagentResultAdoptionAcpDriver(input: {
  workspace: string;
  sessionId: string;
  expectedResponse: string;
  secret: string;
  timeoutMs?: number;
}): Promise<SubagentResultAdoptionAcpEvidence> {
  const harness = createBladeAcpHarness(new RecordingClient());
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
    const deadline = Date.now() + (input.timeoutMs ?? 180_000);
    while (Date.now() < deadline) {
      if (
        agentText(harness.client.updates).includes(input.expectedResponse) &&
        (await inboxIsMissing(input.workspace, input.sessionId))
      ) {
        const updates = [...harness.client.updates];
        if (JSON.stringify(updates).includes(input.secret)) {
          throw new Error('ACP adoption evidence exposed Provider credentials');
        }
        return { finalText: agentText(updates), updates };
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('ACP adoption did not complete the recovered parent turn');
  } finally {
    await harness.close();
  }
}
