import { SessionRuntime } from '../../../src/agent/runtime/SessionRuntime.js';
import {
  type AgentSession,
  AgentSessionStore,
} from '../../../src/agent/subagents/AgentSessionStore.js';
import { BackgroundAgentManager } from '../../../src/agent/subagents/BackgroundAgentManager.js';
import { subagentRegistry } from '../../../src/agent/subagents/SubagentRegistry.js';
import { PermissionMode } from '../../../src/config/types.js';
import { taskTool } from '../../../src/tools/builtin/task/task.js';

export interface SubagentResultAdoptionFixture {
  sessionId: string;
  childSessionId: string;
  turnId: string;
  inputMessageId: string;
  toolCallId: string;
  assistantMessageId: string;
  childMarker: string;
  parentResponse: string;
  child: AgentSession;
}

export function resetSubagentAdoptionState(): void {
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
}

function registerAdoptionAgent(modelId: string): void {
  subagentRegistry.clear();
  subagentRegistry.register({
    name: 'adoption-memory',
    description: 'Return one durable marker without using tools',
    systemPrompt:
      'Answer with the exact marker requested by the user. Do not call tools.',
    tools: [],
    model: modelId,
    permissionMode: PermissionMode.YOLO,
    maxTurns: 2,
  });
}

export async function seedSubagentResultAdoptionFixture(input: {
  workspace: string;
  sessionId: string;
  marker: string;
  modelId: string;
}): Promise<SubagentResultAdoptionFixture> {
  resetSubagentAdoptionState();
  registerAdoptionAgent(input.modelId);
  const childSessionId = `agent-adoption-${input.marker.toLowerCase()}`;
  const childMarker = `CHILD_${input.marker}`;
  const parentResponse = `PARENT_${input.marker}`;
  const description = 'Recover the durable child result';
  const childPrompt = `Do not use tools. Reply exactly ${childMarker}.`;
  const taskParams = {
    subagent_type: 'adoption-memory',
    description,
    prompt: childPrompt,
    run_in_background: false,
    subagent_session_id: childSessionId,
  };
  const childResult = await taskTool
    .build(taskParams)
    .execute(new AbortController().signal, undefined, {
      sessionId: input.sessionId,
      workspaceRoot: input.workspace,
      modelId: input.modelId,
      permissionMode: PermissionMode.YOLO,
    });
  if (!childResult.success) {
    throw new Error(
      `Real child failed before adoption fixture: ${childResult.error?.message}`
    );
  }
  const child = AgentSessionStore.getInstance().loadSession(childSessionId);
  if (
    !child ||
    child.status !== 'completed' ||
    !child.result?.message.includes(childMarker)
  ) {
    throw new Error('Real child result was not durably completed');
  }

  const runtime = await SessionRuntime.create({
    sessionId: input.sessionId,
    workspaceRoot: input.workspace,
    modelId: input.modelId,
  });
  try {
    const parentPrompt = [
      'A previous child has already completed and its result is sufficient.',
      'Do not call Task, TaskOutput, or any other tool.',
      `Reply exactly ${parentResponse}.`,
    ].join(' ');
    const prepared = await runtime.prepareInputTurn(parentPrompt);
    if (!prepared.accepted) {
      throw new Error('Parent adoption input was not durably accepted');
    }
    const contextManager = runtime.getExecutionEngine().getContextManager();
    await contextManager.saveMessage(input.sessionId, 'user', parentPrompt, null, {
      inboxMessageId: prepared.messageId,
    });
    const assistantMessageId = await contextManager.saveMessage(
      input.sessionId,
      'assistant',
      ''
    );
    const toolCallId = await contextManager.saveToolUse(
      input.sessionId,
      'Task',
      taskParams,
      assistantMessageId
    );
    return {
      sessionId: input.sessionId,
      childSessionId,
      turnId: prepared.handle.id,
      inputMessageId: prepared.messageId,
      toolCallId,
      assistantMessageId,
      childMarker,
      parentResponse,
      child,
    };
  } finally {
    await runtime.dispose();
  }
}
