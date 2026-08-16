import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SessionRuntime } from '../../../src/agent/runtime/SessionRuntime.js';
import { AgentSessionStore } from '../../../src/agent/subagents/AgentSessionStore.js';
import { BackgroundAgentManager } from '../../../src/agent/subagents/BackgroundAgentManager.js';
import { resetWorkspaceAgentResources } from '../../../src/agent/resources/WorkspaceAgentResources.js';

export const BACKGROUND_COMPLETION_AGENT_TYPE = 'background-memory';

export interface BackgroundSubagentCompletionFixture {
  sessionId: string;
  childMarker: string;
  childMarkerPath: string;
  independentMarker: string;
  independentMarkerPath: string;
  parentPrompt: string;
  inputMessageId: string;
}

export function resetBackgroundCompletionRuntimeState(): void {
  const manager = (
    BackgroundAgentManager as unknown as {
      instance?: BackgroundAgentManager | null;
    }
  ).instance;
  manager?.killAll();
  (
    BackgroundAgentManager as unknown as {
      instance: BackgroundAgentManager | null;
    }
  ).instance = null;
  (
    AgentSessionStore as unknown as {
      instance: AgentSessionStore | null;
    }
  ).instance = null;
  resetWorkspaceAgentResources();
}

export async function writeBackgroundCompletionAgent(workspace: string): Promise<void> {
  const agentDirectory = path.join(workspace, '.blade', 'agents');
  await mkdir(agentDirectory, { recursive: true });
  await writeFile(
    path.join(agentDirectory, `${BACKGROUND_COMPLETION_AGENT_TYPE}.md`),
    [
      '---',
      `name: ${BACKGROUND_COMPLETION_AGENT_TYPE}`,
      'description: Use when the parent requests the hidden background marker.',
      'tools:',
      '  - Read',
      'model: inherit',
      'permissionMode: dontAsk',
      'isolation: none',
      '---',
      'Follow the task prompt exactly.',
      'Call Read exactly once on the requested marker file.',
      'Return only its exact trimmed text and no explanation.',
      'Do not call Task, TaskOutput, or any other tool.',
      '',
    ].join('\n'),
    { mode: 0o600 }
  );
}

export async function seedBackgroundSubagentCompletionFixture(input: {
  workspace: string;
  sessionId: string;
  childMarker: string;
  independentMarker: string;
  modelId: string;
  requestPaddingBytes?: number;
}): Promise<BackgroundSubagentCompletionFixture> {
  const childMarkerPath = path.join(input.workspace, 'background-child-marker.txt');
  const independentMarkerPath = path.join(
    input.workspace,
    'parent-independent-marker.txt'
  );
  await Promise.all([
    writeFile(childMarkerPath, `${input.childMarker}\n`),
    writeFile(independentMarkerPath, `${input.independentMarker}\n`),
  ]);

  const parentPrompt = [
    'Follow this integration trajectory exactly.',
    `First call Task exactly once with subagent_type "${BACKGROUND_COMPLETION_AGENT_TYPE}",`,
    'description "Read hidden child marker", run_in_background true, and isolation',
    '"none". Tell that child to call Read exactly once on',
    '"background-child-marker.txt" and return only its exact trimmed content.',
    'Do not guess or invent the file content.',
    'After Task returns a running result, continue independent parent work by calling',
    'Read exactly once on "parent-independent-marker.txt".',
    'The parent must never read "background-child-marker.txt".',
    'Never call TaskOutput and never launch another Task.',
    'After the independent Read, if no background completion is in context, end this',
    'model turn with exactly WAITING_FOR_BACKGROUND_COMPLETION. Blade will wake you.',
    'When the background-subagent-completion notification arrives, call no tools and',
    'reply with exactly BACKGROUND_PARENT_FINAL:<child-result>, replacing',
    '<child-result> with the exact child result.',
  ].join(' ');
  if (parentPrompt.includes(input.childMarker)) {
    throw new Error('Parent prompt must not contain the child-only marker');
  }

  const runtime = await SessionRuntime.create({
    sessionId: input.sessionId,
    workspaceRoot: input.workspace,
    modelId: input.modelId,
  });
  try {
    if ((input.requestPaddingBytes ?? 0) > 0) {
      await runtime
        .getExecutionEngine()
        .getContextManager()
        .saveMessage(
          input.sessionId,
          'system',
          `<!-- retained-footprint-padding:${'x'.repeat(
            input.requestPaddingBytes ?? 0
          )} -->`,
          null,
          { clientVisible: false }
        );
    }
    const queued = await runtime.enqueueSteering(parentPrompt, {
      allowBeforeTurn: true,
    });
    if (!queued.accepted || !queued.messageId) {
      throw new Error('Background completion parent input was not durably queued');
    }
    await runtime
      .getExecutionEngine()
      .getContextManager()
      .saveMessage(input.sessionId, 'user', parentPrompt, null, {
        inboxMessageId: queued.messageId,
      });
    return {
      sessionId: input.sessionId,
      childMarker: input.childMarker,
      childMarkerPath,
      independentMarker: input.independentMarker,
      independentMarkerPath,
      parentPrompt,
      inputMessageId: queued.messageId,
    };
  } finally {
    await runtime.dispose();
  }
}
