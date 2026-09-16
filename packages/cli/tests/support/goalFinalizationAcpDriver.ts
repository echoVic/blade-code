import * as acp from '@agentclientprotocol/sdk';
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
