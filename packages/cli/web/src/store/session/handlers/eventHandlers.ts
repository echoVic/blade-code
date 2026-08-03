import type { StreamEvent } from '@/services';
import type {
  AgentResponseContent,
  Message,
  SessionStoreState,
  SubagentProgress,
  TaskItem,
  ToolCallInfo,
} from '../types';
import { makeSubagentId, makeToolCallId } from '../utils/messageIdentity';
import { globalStreamingBuffer } from './streamingBuffer';

type GetState = () => SessionStoreState;
type SetState = {
  (
    partial:
      | SessionStoreState
      | Partial<SessionStoreState>
      | ((state: SessionStoreState) => SessionStoreState | Partial<SessionStoreState>),
    replace?: false
  ): void;
  (
    state: SessionStoreState | ((state: SessionStoreState) => SessionStoreState),
    replace: true
  ): void;
};

type EventHandler = (
  properties: Record<string, unknown>,
  get: GetState,
  set: SetState
) => void;

const createEmptyAgentContent = (): AgentResponseContent => ({
  textBefore: '',
  toolCalls: [],
  textAfter: '',
  thinkingContent: '',
  tasks: [],
  subagent: null,
  confirmation: null,
  question: null,
});

const ensureAssistantMessage = (
  get: GetState,
  set: SetState,
  fallbackId?: string
): string | null => {
  const { currentAssistantMessageId, messages, addMessage, startAgentResponse } = get();

  // 验证 currentAssistantMessageId 是否是有效的消息 ID（不是 toolCallId）
  if (currentAssistantMessageId && !currentAssistantMessageId.startsWith('call_')) {
    return currentAssistantMessageId;
  }

  if (fallbackId) {
    const existing = messages.find(
      (m) => m.id === fallbackId && m.role === 'assistant'
    );
    if (existing) {
      startAgentResponse(existing.id);
      return existing.id;
    }
  }

  // 只有当最后一条消息是 assistant 时才复用，否则创建新的
  const lastMessage = messages[messages.length - 1];
  if (lastMessage?.role === 'assistant') {
    return lastMessage.id;
  }

  // 创建新的 assistant 消息
  const id = fallbackId || `assistant-${Date.now()}`;
  const message: Message = {
    id,
    role: 'assistant',
    content: '',
    timestamp: Date.now(),
    agentContent: createEmptyAgentContent(),
  };
  addMessage(message);
  startAgentResponse(id);
  set((state) => ({
    messages: state.messages.map((m) =>
      m.id === id
        ? { ...m, agentContent: { ...(m.agentContent || createEmptyAgentContent()) } }
        : m
    ),
  }));
  return id;
};

const handleMessageCreated: EventHandler = (props, get, _set) => {
  const { currentSessionId, addMessage, startAgentResponse, messages, updateMessage } =
    get();
  if (props.sessionId !== currentSessionId) return;

  const messageId = props.messageId as string;
  const role = (props.role as 'user' | 'assistant') || 'assistant';
  const existing = messages.find((m) => m.id === messageId);

  const message: Message = {
    id: messageId,
    role,
    content: (props.content as string) || '',
    timestamp: Date.now(),
    agentContent: role === 'assistant' ? createEmptyAgentContent() : undefined,
  };
  if (existing) {
    updateMessage(messageId, {
      role,
      content: message.content,
      agentContent:
        role === 'assistant'
          ? { ...(existing.agentContent || createEmptyAgentContent()) }
          : undefined,
    });
  } else {
    addMessage(message);
  }

  if (role === 'assistant') {
    startAgentResponse(messageId);
  }
};

const handleMessageDelta: EventHandler = (props, get, set) => {
  const {
    currentSessionId,
    appendDelta,
    currentAssistantMessageId,
    hasToolCalls,
    addMessage,
    startAgentResponse,
  } = get();
  if (props.sessionId !== currentSessionId) return;

  const messageId = props.messageId as string;
  const delta = props.delta as string;

  if (!currentAssistantMessageId) {
    const newMessage: Message = {
      id: messageId,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      agentContent: createEmptyAgentContent(),
    };
    addMessage(newMessage);
    startAgentResponse(messageId);
    set((state) => ({
      messages: state.messages.map((m) =>
        m.id === messageId
          ? {
              ...m,
              agentContent: {
                ...(m.agentContent || createEmptyAgentContent()),
                textBefore: delta,
              },
            }
          : m
      ),
    }));
    return;
  }

  const position = hasToolCalls ? 'after' : 'before';
  appendDelta(currentAssistantMessageId, delta, position);
};

const handleMessageComplete: EventHandler = (props, get) => {
  const { currentSessionId, updateMessage, messages } = get();
  if (props.sessionId !== currentSessionId) return;

  const messageId = props.messageId as string;
  const message = messages.find((m) => m.id === messageId);
  if (message?.agentContent) {
    const { textBefore, textAfter } = message.agentContent;
    updateMessage(messageId, {
      content: textBefore + textAfter,
    });
  }
};

const handleThinkingDelta: EventHandler = (props, get) => {
  const { currentSessionId, appendThinking, currentAssistantMessageId } = get();
  if (props.sessionId !== currentSessionId) return;
  if (!currentAssistantMessageId) return;

  appendThinking(currentAssistantMessageId, props.delta as string);
};

const handleThinkingCompleted: EventHandler = () => {
  // Thinking deltas are applied incrementally, so completion is a no-op here.
};

const handleToolStart: EventHandler = (props, get, set) => {
  const { currentSessionId, appendToolCall, setHasToolCalls, setSubagent } = get();
  if (props.sessionId !== currentSessionId) return;
  const targetMessageId = ensureAssistantMessage(
    get,
    set,
    (props.messageId as string) || (props.toolCallId as string)
  );
  if (!targetMessageId) return;

  setHasToolCalls(true);

  const toolName = (props.toolName as string) || 'Unknown';
  const args = props.arguments as string;

  let subagentType: string | undefined;
  let description = '';
  let subagentSessionId: string | undefined;

  if (toolName === 'Task') {
    try {
      const parsed = JSON.parse(args);
      subagentType = parsed.subagent_type;
      description = parsed.description || parsed.query || subagentType || '';
      subagentSessionId = parsed.subagent_session_id;
    } catch {
      // ignore
    }
  }

  if (subagentType) {
    setSubagent(targetMessageId, {
      id: makeSubagentId({
        explicitId: props.toolCallId as string | undefined,
        sessionId: subagentSessionId,
        messageId: targetMessageId,
        agentType: subagentType,
        description,
      }),
      type: subagentType,
      description,
      status: 'running',
      startTime: Date.now(),
      sessionId: subagentSessionId,
      output: '',
      thinking: '',
    });
    return;
  }

  const toolCall: ToolCallInfo = {
    toolCallId: makeToolCallId({
      explicitId: props.toolCallId as string | undefined,
      messageId: targetMessageId,
      toolName,
      argumentsValue: args,
      toolKind: props.toolKind as string | undefined,
    }),
    toolName,
    arguments: args,
    toolKind: props.toolKind as string,
    status: 'running',
    startTime: Date.now(),
  };
  appendToolCall(targetMessageId, toolCall);
};

const handleToolResult: EventHandler = (props, get, set) => {
  const { currentSessionId, updateToolCall, messages } = get();
  if (props.sessionId !== currentSessionId) return;

  const toolCallId = props.toolCallId as string;
  if (!toolCallId) return;

  // 先通过 toolCallId 找到包含该工具调用的消息
  const messageWithTool = messages.find((m) =>
    m.agentContent?.toolCalls.some((tc) => tc.toolCallId === toolCallId)
  );

  console.log('[handleToolResult]', {
    toolCallId,
    foundMessage: !!messageWithTool,
    messageId: messageWithTool?.id,
    toolCallsInMessage: messageWithTool?.agentContent?.toolCalls.map(
      (tc) => tc.toolCallId
    ),
    success: props.success,
  });

  const targetMessageId =
    (props.messageId as string) ||
    messageWithTool?.id ||
    [...messages].reverse().find((m) => m.role === 'assistant')?.id;

  if (!targetMessageId) {
    console.log('[handleToolResult] No targetMessageId found!');
    return;
  }

  const output = props.output as string;
  const summary =
    (props.summary as string) ||
    (output && output.trim()
      ? output.trim().split('\n')[0].slice(0, 120)
      : props.success
        ? '执行成功'
        : '执行失败');

  console.log('[handleToolResult] Updating tool call', {
    targetMessageId,
    toolCallId,
    status: props.success ? 'success' : 'error',
  });
  updateToolCall(targetMessageId, toolCallId, {
    status: props.success ? 'success' : 'error',
    summary,
    output,
    metadata: props.metadata as Record<string, unknown>,
  });

  const message = messages.find((m) => m.id === targetMessageId);
  if (message?.agentContent?.subagent?.id === toolCallId) {
    set((state) => ({
      messages: state.messages.map((m) => {
        if (m.id !== targetMessageId) return m;
        if (!m.agentContent?.subagent) return m;
        return {
          ...m,
          agentContent: {
            ...m.agentContent,
            subagent: {
              ...m.agentContent.subagent,
              status: props.success ? 'completed' : 'failed',
            },
          },
        };
      }),
    }));
  }

  const metadata = props.metadata as Record<string, unknown> | undefined;
  const subagentSessionId =
    metadata && typeof metadata.subagentSessionId === 'string'
      ? metadata.subagentSessionId
      : undefined;
  const subagentStatus =
    metadata && typeof metadata.subagentStatus === 'string'
      ? metadata.subagentStatus
      : undefined;
  const subagentType =
    metadata && typeof metadata.subagentType === 'string'
      ? metadata.subagentType
      : undefined;
  const subagentSummary =
    metadata && typeof metadata.subagentSummary === 'string'
      ? metadata.subagentSummary
      : undefined;

  if (subagentSessionId && subagentStatus) {
    set((state) => ({
      messages: state.messages.map((m) => {
        if (m.id !== targetMessageId) return m;
        const baseMetadata = (m.metadata ?? {}) as Record<string, unknown>;
        const existing = baseMetadata.subtaskRef as Record<string, unknown> | undefined;
        const nextRef = {
          ...(existing ?? {}),
          childSessionId: subagentSessionId,
          agentType:
            subagentType ||
            (typeof existing?.agentType === 'string' ? existing.agentType : 'subagent'),
          status: subagentStatus,
          summary:
            subagentSummary ||
            (typeof existing?.summary === 'string' ? existing.summary : ''),
        };
        return {
          ...m,
          metadata: {
            ...baseMetadata,
            subtaskRef: nextRef,
          },
        };
      }),
    }));
  }
};

const handleTokenUsage: EventHandler = (props, get) => {
  const { currentSessionId, updateTokenUsage, setMaxContextTokens } = get();
  if (props.sessionId !== currentSessionId) return;

  updateTokenUsage({
    inputTokens: props.inputTokens as number,
    outputTokens: props.outputTokens as number,
    totalTokens: props.totalTokens as number,
  });

  if (props.maxContextTokens) {
    setMaxContextTokens(props.maxContextTokens as number, false);
  }
};

const handleTaskUpdate: EventHandler = (props, get) => {
  const { currentSessionId, setTasks, currentAssistantMessageId } = get();
  if (props.sessionId !== currentSessionId) return;
  if (!currentAssistantMessageId) return;

  const tasks = (props.tasks as TaskItem[]) || [];
  setTasks(currentAssistantMessageId, tasks);
};

const handleSubagentStart: EventHandler = (props, get) => {
  const { currentSessionId, setSubagent, currentAssistantMessageId } = get();
  if (props.sessionId !== currentSessionId) return;
  if (!currentAssistantMessageId) return;

  const subagent: SubagentProgress = {
    id: makeSubagentId({
      explicitId: props.subagentId as string | undefined,
      sessionId: props.subagentSessionId as string | undefined,
      messageId: currentAssistantMessageId,
      agentType: props.type as string | undefined,
      description: props.description as string | undefined,
    }),
    type: (props.type as string) || 'unknown',
    description: (props.description as string) || '',
    status: 'running',
    startTime: Date.now(),
  };
  setSubagent(currentAssistantMessageId, subagent);
};

const handleSubagentUpdate: EventHandler = (props, get, set) => {
  const { currentSessionId, currentAssistantMessageId, messages } = get();
  if (props.sessionId !== currentSessionId) return;
  const subagentSessionId = props.subagentSessionId as string | undefined;
  const targetMessageId = subagentSessionId
    ? messages.find((m) => m.agentContent?.subagent?.sessionId === subagentSessionId)
        ?.id
    : currentAssistantMessageId ||
      [...messages].reverse().find((m) => m.agentContent?.subagent)?.id;
  if (!targetMessageId) return;
  const message = messages.find((m) => m.id === targetMessageId);
  if (!message?.agentContent?.subagent) return;

  set((state) => ({
    messages: state.messages.map((m) => {
      if (m.id !== targetMessageId) return m;
      if (!m.agentContent?.subagent) return m;
      return {
        ...m,
        agentContent: {
          ...m.agentContent,
          subagent: {
            ...m.agentContent.subagent,
            sessionId: m.agentContent.subagent.sessionId || subagentSessionId,
            currentTool: props.toolName as string,
          },
        },
      };
    }),
  }));
};

const handleSubagentDelta: EventHandler = (props, get, set) => {
  const { currentSessionId, currentAssistantMessageId, messages } = get();
  if (props.sessionId !== currentSessionId) return;

  const delta = props.delta as string;
  if (!delta) return;

  const subagentSessionId = props.subagentSessionId as string | undefined;
  const targetMessageId = subagentSessionId
    ? messages.find((m) => m.agentContent?.subagent?.sessionId === subagentSessionId)
        ?.id || messages.find((m) => m.agentContent?.subagent?.status === 'running')?.id
    : currentAssistantMessageId ||
      [...messages].reverse().find((m) => m.agentContent?.subagent)?.id;

  if (!targetMessageId) return;

  set((state) => ({
    messages: state.messages.map((m) => {
      if (m.id !== targetMessageId) return m;
      if (!m.agentContent?.subagent) return m;
      return {
        ...m,
        agentContent: {
          ...m.agentContent,
          subagent: {
            ...m.agentContent.subagent,
            sessionId: m.agentContent.subagent.sessionId || subagentSessionId,
            output: (m.agentContent.subagent.output || '') + delta,
          },
        },
      };
    }),
  }));
};

const handleSubagentThinkingDelta: EventHandler = (props, get, set) => {
  const { currentSessionId, currentAssistantMessageId, messages } = get();
  if (props.sessionId !== currentSessionId) return;

  const delta = props.delta as string;
  if (!delta) return;

  const subagentSessionId = props.subagentSessionId as string | undefined;
  const targetMessageId = subagentSessionId
    ? messages.find((m) => m.agentContent?.subagent?.sessionId === subagentSessionId)
        ?.id || messages.find((m) => m.agentContent?.subagent?.status === 'running')?.id
    : currentAssistantMessageId ||
      [...messages].reverse().find((m) => m.agentContent?.subagent)?.id;

  if (!targetMessageId) return;

  set((state) => ({
    messages: state.messages.map((m) => {
      if (m.id !== targetMessageId) return m;
      if (!m.agentContent?.subagent) return m;
      return {
        ...m,
        agentContent: {
          ...m.agentContent,
          subagent: {
            ...m.agentContent.subagent,
            sessionId: m.agentContent.subagent.sessionId || subagentSessionId,
            thinking: (m.agentContent.subagent.thinking || '') + delta,
          },
        },
      };
    }),
  }));
};

const handleSubagentComplete: EventHandler = (props, get, set) => {
  const { currentSessionId, currentAssistantMessageId, messages } = get();
  if (props.sessionId !== currentSessionId) return;
  const subagentSessionId = props.subagentSessionId as string | undefined;
  const targetMessageId = subagentSessionId
    ? messages.find((m) => m.agentContent?.subagent?.sessionId === subagentSessionId)
        ?.id || messages.find((m) => m.agentContent?.subagent?.status === 'running')?.id
    : currentAssistantMessageId ||
      [...messages].reverse().find((m) => m.agentContent?.subagent)?.id;
  if (!targetMessageId) return;
  const message = messages.find((m) => m.id === targetMessageId);
  if (!message?.agentContent?.subagent) return;

  set((state) => ({
    messages: state.messages.map((m) => {
      if (m.id !== targetMessageId) return m;
      if (!m.agentContent?.subagent) return m;
      return {
        ...m,
        agentContent: {
          ...m.agentContent,
          subagent: {
            ...m.agentContent.subagent,
            sessionId: m.agentContent.subagent.sessionId || subagentSessionId,
            status: props.success ? 'completed' : 'failed',
          },
        },
      };
    }),
  }));
};

const handleSubagentToolStart: EventHandler = (props, get, set) => {
  const { currentSessionId, currentAssistantMessageId, messages } = get();
  if (props.sessionId !== currentSessionId) return;

  const toolCallId = props.toolCallId as string;
  const toolName = props.toolName as string;
  if (!toolCallId || !toolName) return;

  const subagentSessionId = props.subagentSessionId as string | undefined;
  const targetMessageId = subagentSessionId
    ? messages.find((m) => m.agentContent?.subagent?.sessionId === subagentSessionId)
        ?.id || messages.find((m) => m.agentContent?.subagent?.status === 'running')?.id
    : currentAssistantMessageId ||
      [...messages].reverse().find((m) => m.agentContent?.subagent)?.id;

  if (!targetMessageId) return;

  const toolCall: ToolCallInfo = {
    toolCallId,
    toolName,
    arguments: props.arguments as string,
    toolKind: props.toolKind as string,
    status: 'running',
    startTime: Date.now(),
  };

  set((state) => ({
    messages: state.messages.map((m) => {
      if (m.id !== targetMessageId) return m;
      if (!m.agentContent?.subagent) return m;
      const existing = m.agentContent.subagent.toolCalls || [];
      if (existing.some((tc) => tc.toolCallId === toolCallId)) return m;
      return {
        ...m,
        agentContent: {
          ...m.agentContent,
          subagent: {
            ...m.agentContent.subagent,
            sessionId: m.agentContent.subagent.sessionId || subagentSessionId,
            toolCalls: [...existing, toolCall],
          },
        },
      };
    }),
  }));
};

const handleSubagentToolResult: EventHandler = (props, get, set) => {
  const { currentSessionId, currentAssistantMessageId, messages } = get();
  if (props.sessionId !== currentSessionId) return;

  const toolCallId = props.toolCallId as string;
  if (!toolCallId) return;

  const subagentSessionId = props.subagentSessionId as string | undefined;
  const targetMessageId = subagentSessionId
    ? messages.find((m) => m.agentContent?.subagent?.sessionId === subagentSessionId)
        ?.id || messages.find((m) => m.agentContent?.subagent?.status === 'running')?.id
    : currentAssistantMessageId ||
      [...messages].reverse().find((m) => m.agentContent?.subagent)?.id;

  if (!targetMessageId) return;

  const output = props.output as string;
  const success = props.success === true;
  const status: ToolCallInfo['status'] = success ? 'success' : 'error';
  const summary =
    (props.summary as string) ||
    (output && output.trim()
      ? output.trim().split('\n')[0].slice(0, 120)
      : success
        ? '执行成功'
        : '执行失败');

  set((state) => ({
    messages: state.messages.map((m) => {
      if (m.id !== targetMessageId) return m;
      if (!m.agentContent?.subagent) return m;
      const existing = m.agentContent.subagent.toolCalls || [];
      const updated = existing.map((tc) =>
        tc.toolCallId === toolCallId
          ? {
              ...tc,
              status,
              summary,
              output,
              metadata: props.metadata as Record<string, unknown>,
            }
          : tc
      );
      return {
        ...m,
        agentContent: {
          ...m.agentContent,
          subagent: {
            ...m.agentContent.subagent,
            sessionId: m.agentContent.subagent.sessionId || subagentSessionId,
            toolCalls: updated,
          },
        },
      };
    }),
  }));
};

const handlePermissionAsked: EventHandler = (props, get, _set) => {
  const { currentSessionId, setConfirmation, messages } = get();
  if (props.sessionId !== currentSessionId) return;

  // 直接找最后一条 assistant 消息（不依赖 currentAssistantMessageId，因为它可能被错误设置）
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
  if (!lastAssistant) return;

  const details = props.details as Record<string, unknown> | undefined;
  const toolName =
    (props.toolName as string) || (details?.toolName as string) || 'Edit';

  setConfirmation(lastAssistant.id, {
    toolCallId: (props.requestId as string) || '',
    toolName,
    description: props.description as string,
    diff: (details?.details as string) || (details?.diff as string) || '',
    status: 'pending',
  });
  _set({ agentPhase: 'waiting_permission' });
};

const handlePermissionTimeout: EventHandler = (props, get, set) => {
  const { currentSessionId, messages, setConfirmation } = get();
  if (props.sessionId !== currentSessionId) return;

  const requestId = props.requestId as string;
  const message = messages.find(
    (candidate) => candidate.agentContent?.confirmation?.toolCallId === requestId
  );
  const confirmation = message?.agentContent?.confirmation;
  if (message && confirmation?.status === 'pending') {
    setConfirmation(message.id, { ...confirmation, status: 'denied' });
  }
  set({ agentPhase: 'running', error: 'Permission request timed out' });
};

const handleTurnStarted: EventHandler = (props, get, set) => {
  if (props.sessionId !== get().currentSessionId) return;
  set({ agentPhase: 'running' });
};

const handleCompactionStarted: EventHandler = (props, get, set) => {
  if (props.sessionId !== get().currentSessionId) return;
  set({ agentPhase: 'compacting' });
};

const handleCompactionCompleted: EventHandler = (props, get, set) => {
  if (props.sessionId !== get().currentSessionId) return;
  set({ agentPhase: 'running' });
};

const handleModelFallback: EventHandler = (props, get, set) => {
  if (props.sessionId !== get().currentSessionId) return;
  set({ agentPhase: 'switching_model' });
};

const handleQuestionRequired: EventHandler = (props, get) => {
  const { currentSessionId, setQuestion, currentAssistantMessageId } = get();
  if (props.sessionId !== currentSessionId) return;
  if (!currentAssistantMessageId) return;

  setQuestion(currentAssistantMessageId, {
    toolCallId: props.toolCallId as string,
    questions: props.questions as QuestionInfo['questions'],
    status: 'pending',
  });
};

interface QuestionInfo {
  toolCallId: string;
  questions: Array<{
    question: string;
    header: string;
    options: Array<{ label: string; description: string }>;
    multiSelect: boolean;
  }>;
  status: 'pending' | 'answered';
  answers?: Record<string, string | string[]>;
}

const handleSessionCompleted: EventHandler = (props, get) => {
  const { currentSessionId, endAgentResponse } = get();
  if (props.sessionId !== currentSessionId) return;
  endAgentResponse();
};

const handleSessionError: EventHandler = (props, get, set) => {
  const { currentSessionId, endAgentResponse } = get();
  if (props.sessionId !== currentSessionId) return;

  set({
    agentPhase: 'error',
    error: (props.error as string) || 'An error occurred',
  });
  endAgentResponse();
};

const handleSessionStatus: EventHandler = (props, get, set) => {
  const { currentSessionId } = get();
  if (props.sessionId !== currentSessionId) return;

  if (props.status === 'idle') {
    set({ isStreaming: false, agentPhase: 'idle' });
  } else if (props.status === 'running') {
    set({ agentPhase: 'running' });
  } else if (props.status === 'error') {
    set({ agentPhase: 'error' });
  }
};

const handleRunCancelled: EventHandler = (props, get, set) => {
  const { currentSessionId, endAgentResponse } = get();
  if (props.sessionId !== currentSessionId) return;

  set((state) => ({
    isStreaming: false,
    agentPhase: 'idle',
    messages: state.messages.map((m) => {
      if (!m.agentContent?.subagent) return m;
      if (m.agentContent.subagent.status !== 'running') return m;
      return {
        ...m,
        agentContent: {
          ...m.agentContent,
          subagent: {
            ...m.agentContent.subagent,
            status: 'failed',
          },
        },
      };
    }),
  }));
  endAgentResponse();
};

const handleSteeringQueued: EventHandler = (props, get, set) => {
  if (props.sessionId !== get().currentSessionId) return;
  set({
    pendingSteeringCount:
      typeof props.queued === 'number' ? Math.max(0, props.queued) : 1,
  });
};

const handleSteeringApplied: EventHandler = (props, get, set) => {
  if (props.sessionId !== get().currentSessionId) return;
  set({
    pendingSteeringCount:
      typeof props.queued === 'number' ? Math.max(0, props.queued) : 0,
    recoveredSteeringCount:
      typeof props.recovered === 'number'
        ? Math.max(0, props.recovered)
        : get().recoveredSteeringCount,
  });
};

const eventHandlers: Record<string, EventHandler> = {
  'message.created': handleMessageCreated,
  'message.delta': handleMessageDelta,
  'message.complete': handleMessageComplete,
  'thinking.delta': handleThinkingDelta,
  'thinking.completed': handleThinkingCompleted,
  'tool.start': handleToolStart,
  'tool.result': handleToolResult,
  'token.usage': handleTokenUsage,
  'task.updated': handleTaskUpdate,
  'subagent.start': handleSubagentStart,
  'subagent.update': handleSubagentUpdate,
  'subagent.delta': handleSubagentDelta,
  'subagent.thinking.delta': handleSubagentThinkingDelta,
  'subagent.tool.start': handleSubagentToolStart,
  'subagent.tool.result': handleSubagentToolResult,
  'subagent.complete': handleSubagentComplete,
  'permission.asked': handlePermissionAsked,
  'permission.timeout': handlePermissionTimeout,
  'turn.started': handleTurnStarted,
  'compaction.started': handleCompactionStarted,
  'compaction.completed': handleCompactionCompleted,
  'model.fallback': handleModelFallback,
  'question.required': handleQuestionRequired,
  'session.completed': handleSessionCompleted,
  'session.error': handleSessionError,
  'session.status': handleSessionStatus,
  'run.cancelled': handleRunCancelled,
  'steering.queued': handleSteeringQueued,
  'steering.applied': handleSteeringApplied,
};

// 需要缓冲的高频 delta 事件
const BUFFERED_EVENTS = new Set([
  'message.delta',
  'thinking.delta',
  'subagent.delta',
  'subagent.thinking.delta',
]);

// 流结束事件（需要先 drain buffer）
const STREAM_END_EVENTS = new Set([
  'message.complete',
  'thinking.completed',
  'session.completed',
  'session.error',
  'run.cancelled',
]);

const resolveSubagentTargetMessageId = (
  messages: Message[],
  currentAssistantMessageId: string | null,
  subagentSessionId: string
): string | undefined => {
  if (subagentSessionId) {
    return (
      messages.find((m) => m.agentContent?.subagent?.sessionId === subagentSessionId)
        ?.id || messages.find((m) => m.agentContent?.subagent?.status === 'running')?.id
    );
  }

  return (
    currentAssistantMessageId ||
    [...messages].reverse().find((m) => m.agentContent?.subagent)?.id
  );
};

export const createEventDispatcher = (get: GetState, set: SetState) => {
  return (event: StreamEvent) => {
    // delta 事件不打印日志，避免大量 console.log 阻塞主线程
    if (!BUFFERED_EVENTS.has(event.type)) {
      console.log('[SSE Event]', event.type, event.properties);
    }

    // 流结束事件：先 drain buffer 确保内容不丢失，再执行 handler
    if (STREAM_END_EVENTS.has(event.type)) {
      globalStreamingBuffer.drainAll();
      const handler = eventHandlers[event.type];
      if (handler) {
        handler(event.properties, get, set);
      }
      return;
    }

    // message.delta 走 buffer
    if (event.type === 'message.delta') {
      const props = event.properties;
      const { currentSessionId, currentAssistantMessageId, hasToolCalls } = get();
      if (props.sessionId !== currentSessionId) return;

      const targetMessageId = (props.messageId as string) || currentAssistantMessageId;
      const delta = props.delta as string;

      // 首次收到 delta 且无 assistant message：需立即创建消息，直接透传
      if (!currentAssistantMessageId) {
        const handler = eventHandlers['message.delta'];
        if (handler) handler(props, get, set);
        return;
      }

      const position = hasToolCalls ? 'after' : 'before';
      const channelKey = `content:${targetMessageId}:${position}`;

      globalStreamingBuffer.append(channelKey, delta, (bufferedDelta) => {
        const { appendDelta } = get();
        if (targetMessageId) {
          appendDelta(targetMessageId, bufferedDelta, position);
        }
      });
      return;
    }

    // thinking.delta 走 buffer
    if (event.type === 'thinking.delta') {
      const props = event.properties;
      const { currentSessionId, currentAssistantMessageId } = get();
      if (props.sessionId !== currentSessionId) return;
      if (!currentAssistantMessageId) return;

      const delta = props.delta as string;
      const targetMessageId = currentAssistantMessageId;
      const channelKey = `thinking:${targetMessageId}`;

      globalStreamingBuffer.append(channelKey, delta, (bufferedDelta) => {
        const { appendThinking } = get();
        if (targetMessageId) {
          appendThinking(targetMessageId, bufferedDelta);
        }
      });
      return;
    }

    // subagent.delta 走 buffer
    if (event.type === 'subagent.delta') {
      const props = event.properties;
      const { currentSessionId } = get();
      if (props.sessionId !== currentSessionId) return;

      const delta = props.delta as string;
      if (!delta) return;

      const subagentSessionId = (props.subagentSessionId as string) || '';
      const channelKey = `subagent:${subagentSessionId}`;
      const {
        currentAssistantMessageId: targetCurrentAssistantMessageId,
        messages: targetMessages,
      } = get();
      const targetMessageIdAtAppend = resolveSubagentTargetMessageId(
        targetMessages,
        targetCurrentAssistantMessageId,
        subagentSessionId
      );

      globalStreamingBuffer.append(channelKey, delta, (bufferedDelta) => {
        const { currentAssistantMessageId, messages } = get();
        const targetMessageId =
          targetMessageIdAtAppend ||
          resolveSubagentTargetMessageId(
            messages,
            currentAssistantMessageId,
            subagentSessionId
          );

        if (!targetMessageId) return;
        set((state) => ({
          messages: state.messages.map((m) => {
            if (m.id !== targetMessageId) return m;
            if (!m.agentContent?.subagent) return m;
            return {
              ...m,
              agentContent: {
                ...m.agentContent,
                subagent: {
                  ...m.agentContent.subagent,
                  sessionId: m.agentContent.subagent.sessionId || subagentSessionId,
                  output: (m.agentContent.subagent.output || '') + bufferedDelta,
                },
              },
            };
          }),
        }));
      });
      return;
    }

    // subagent.thinking.delta 走 buffer
    if (event.type === 'subagent.thinking.delta') {
      const props = event.properties;
      const { currentSessionId } = get();
      if (props.sessionId !== currentSessionId) return;

      const delta = props.delta as string;
      if (!delta) return;

      const subagentSessionId = (props.subagentSessionId as string) || '';
      const channelKey = `subagent-thinking:${subagentSessionId}`;
      const {
        currentAssistantMessageId: targetCurrentAssistantMessageId,
        messages: targetMessages,
      } = get();
      const targetMessageIdAtAppend = resolveSubagentTargetMessageId(
        targetMessages,
        targetCurrentAssistantMessageId,
        subagentSessionId
      );

      globalStreamingBuffer.append(channelKey, delta, (bufferedDelta) => {
        const { currentAssistantMessageId, messages } = get();
        const targetMessageId =
          targetMessageIdAtAppend ||
          resolveSubagentTargetMessageId(
            messages,
            currentAssistantMessageId,
            subagentSessionId
          );

        if (!targetMessageId) return;
        set((state) => ({
          messages: state.messages.map((m) => {
            if (m.id !== targetMessageId) return m;
            if (!m.agentContent?.subagent) return m;
            return {
              ...m,
              agentContent: {
                ...m.agentContent,
                subagent: {
                  ...m.agentContent.subagent,
                  sessionId: m.agentContent.subagent.sessionId || subagentSessionId,
                  thinking: (m.agentContent.subagent.thinking || '') + bufferedDelta,
                },
              },
            };
          }),
        }));
      });
      return;
    }

    // 其它事件直通
    const handler = eventHandlers[event.type];
    if (handler) {
      handler(event.properties, get, set);
    }
  };
};
