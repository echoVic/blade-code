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

export interface BackgroundSubagentCompletionAcpEvidence {
  finalText: string;
  updates: acp.SessionNotification[];
}

export async function runBackgroundSubagentCompletionAcpDriver(input: {
  workspace: string;
  sessionId: string;
  childMarker: string;
  secret: string;
  timeoutMs?: number;
}): Promise<BackgroundSubagentCompletionAcpEvidence> {
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

    const expected = `BACKGROUND_PARENT_FINAL:${input.childMarker}`;
    const deadline = Date.now() + (input.timeoutMs ?? 180_000);
    while (Date.now() < deadline) {
      if (
        agentText(harness.client.updates).includes(expected) &&
        (await inboxIsMissing(input.workspace, input.sessionId))
      ) {
        const updates = [...harness.client.updates];
        const serialized = JSON.stringify(updates);
        if (serialized.includes(input.secret)) {
          throw new Error('ACP background completion evidence exposed credentials');
        }
        if (
          updates.some(
            (notification) =>
              notification.update.sessionUpdate === 'user_message_chunk' &&
              notification.update.content.type === 'text' &&
              notification.update.content.text.includes(input.childMarker)
          )
        ) {
          throw new Error('ACP rendered the hidden completion as a user message');
        }
        if (
          !updates.some(
            (notification) =>
              notification.update.sessionUpdate === 'session_info_update' &&
              notification.update._meta?.['blade/backgroundSubagentCompletion'] !==
                undefined
          )
        ) {
          throw new Error('ACP did not project the background completion wake');
        }
        return {
          finalText: agentText(updates),
          updates,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('ACP background completion did not resume the parent');
  } finally {
    await harness.close();
  }
}
