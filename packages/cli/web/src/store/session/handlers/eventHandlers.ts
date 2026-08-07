import { taskFailureCode } from '@/lib/taskFailure';
import type { Message as ServiceMessage, StreamEvent } from '@/services';
import type {
  Message,
  SessionStoreState,
  SubagentProgress,
  TaskItem,
  ToolCallInfo,
} from '../types';
import { aggregateMessages } from '../utils/aggregateMessages';
import { createEmptyAgentContent, getTimelineText } from '../utils/agentTimeline';
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

const ensureAssistantMessage = (
  get: GetState,
  set: SetState,
  fallbackId?: string
): string | null => {
  const { currentAssistantMessageId, messages, addMessage, startAgentResponse } = get();

  // 验证 currentAssistantMessageId 是否是有效的消息 ID（不是 toolCallId）
  if (
    currentAssistantMessageId &&
    !currentAssistantMessageId.startsWith('call_') &&
    messages.some(
      (message) =>
        message.id === currentAssistantMessageId && message.role === 'assistant'
    )
  ) {
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

const handleMessageDelta: EventHandler = (props, get, _set) => {
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
    get().appendDelta(messageId, delta, 'before');
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
    updateMessage(messageId, {
      content: getTimelineText(message.agentContent),
    });
  }
};

const handleThinkingDelta: EventHandler = (props, get, set) => {
  const { currentSessionId, appendThinking } = get();
  if (props.sessionId !== currentSessionId) return;
  const targetMessageId = ensureAssistantMessage(
    get,
    set,
    props.messageId as string | undefined
  );
  if (!targetMessageId) return;
  appendThinking(targetMessageId, props.delta as string);
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
  let resumedFrom: string | undefined;

  if (toolName === 'Task') {
    try {
      const parsed = JSON.parse(args);
      subagentType = parsed.subagent_type;
      description = parsed.description || parsed.query || subagentType || '';
      subagentSessionId = parsed.subagent_session_id;
      resumedFrom = parsed.resume_from || parsed.resume;
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
      resumedFrom,
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

  const targetMessageId =
    (props.messageId as string) ||
    messageWithTool?.id ||
    [...messages].reverse().find((m) => m.role === 'assistant')?.id;

  if (!targetMessageId) {
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
  const subagentResumedFrom =
    metadata && typeof metadata.subagentResumedFrom === 'string'
      ? metadata.subagentResumedFrom
      : undefined;
  const subagentRootId =
    metadata && typeof metadata.subagentRootId === 'string'
      ? metadata.subagentRootId
      : undefined;
  const subagentResumeDepth =
    metadata && typeof metadata.subagentResumeDepth === 'number'
      ? metadata.subagentResumeDepth
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
          resumedFrom:
            subagentResumedFrom ||
            (typeof existing?.resumedFrom === 'string'
              ? existing.resumedFrom
              : undefined),
          rootAgentId:
            subagentRootId ||
            (typeof existing?.rootAgentId === 'string'
              ? existing.rootAgentId
              : subagentSessionId),
          resumeDepth:
            subagentResumeDepth ??
            (typeof existing?.resumeDepth === 'number' ? existing.resumeDepth : 0),
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
    cacheReadTokens: (props.cacheReadTokens as number | undefined) ?? 0,
    cacheWriteTokens: (props.cacheWriteTokens as number | undefined) ?? 0,
    costUsd: props.costUsd as number | undefined,
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
    sessionId: props.subagentSessionId as string | undefined,
    resumedFrom: props.resumedFrom as string | undefined,
    rootAgentId: props.rootAgentId as string | undefined,
    resumeDepth: typeof props.resumeDepth === 'number' ? props.resumeDepth : undefined,
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

const handlePermissionAsked: EventHandler = (props, get, set) => {
  const { currentSessionId, setConfirmation } = get();
  if (props.sessionId !== currentSessionId) return;

  const requestId = (props.requestId as string) || '';
  const assistantMessageId = ensureAssistantMessage(
    get,
    set,
    requestId ? `assistant-permission-${requestId}` : undefined
  );
  if (!assistantMessageId) return;

  const details = props.details as Record<string, unknown> | undefined;
  const toolName =
    (props.toolName as string) || (details?.toolName as string) || 'Edit';

  setConfirmation(assistantMessageId, {
    toolCallId: requestId,
    toolName,
    description: props.description as string,
    diff: (details?.details as string) || (details?.diff as string) || '',
    status: 'pending',
  });
  set((state) => ({
    agentPhase: 'waiting_permission',
    isStreaming: true,
    sessions: state.sessions.map((session) =>
      session.sessionId === props.sessionId && session.projectPath === props.projectPath
        ? {
            ...session,
            pendingInteraction: {
              type: 'permission' as const,
              requestId,
            },
          }
        : session
    ),
  }));
};

const handlePermissionTimeout: EventHandler = (props, get, set) => {
  const { currentSessionId, currentSessionRef, messages, setConfirmation } = get();
  if (props.sessionId !== currentSessionId) return;

  const requestId = props.requestId as string;
  const message = messages.find(
    (candidate) => candidate.agentContent?.confirmation?.toolCallId === requestId
  );
  const confirmation = message?.agentContent?.confirmation;
  if (message && confirmation?.status === 'pending') {
    setConfirmation(message.id, { ...confirmation, status: 'denied' });
  }
  set({
    agentPhase: 'running',
    error: 'Permission request timed out',
    errorContext: {
      kind: 'interaction',
      ...(currentSessionRef ? { sessionRef: currentSessionRef } : {}),
    },
  });
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
  get().resetContextUsage();
  set({ agentPhase: 'running' });
};

const handleModelFallback: EventHandler = (props, get, set) => {
  if (props.sessionId !== get().currentSessionId) return;
  set({ agentPhase: 'switching_model' });
};

const handleQuestionRequired: EventHandler = (props, get, set) => {
  const { currentSessionId, setQuestion } = get();
  if (props.sessionId !== currentSessionId) return;
  const requestId = (props.requestId as string) || (props.toolCallId as string) || '';
  const assistantMessageId = ensureAssistantMessage(
    get,
    set,
    requestId ? `assistant-question-${requestId}` : undefined
  );
  if (!assistantMessageId) return;

  setQuestion(assistantMessageId, {
    toolCallId: requestId,
    questions: props.questions as QuestionInfo['questions'],
    status: 'pending',
  });
  set((state) => ({
    agentPhase: 'waiting_permission',
    isStreaming: true,
    sessions: state.sessions.map((session) =>
      session.sessionId === props.sessionId && session.projectPath === props.projectPath
        ? {
            ...session,
            pendingInteraction: {
              type: 'question' as const,
              requestId,
            },
          }
        : session
    ),
  }));
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

const handleInteractionResolved: EventHandler = (props, get, set) => {
  const { currentSessionId } = get();
  if (props.sessionId !== currentSessionId) return;
  const requestId = props.requestId as string;
  set((state) => ({
    agentPhase: 'running',
    sessions: state.sessions.map((session) =>
      session.sessionId === props.sessionId &&
      session.projectPath === props.projectPath &&
      session.pendingInteraction?.requestId === requestId
        ? { ...session, pendingInteraction: undefined }
        : session
    ),
  }));
};

const handleSessionCompleted: EventHandler = (props, get) => {
  const { currentSessionId, endAgentResponse } = get();
  if (props.sessionId !== currentSessionId) return;
  endAgentResponse();
};

const handleSessionError: EventHandler = (props, get, set) => {
  const { currentSessionId, currentSessionRef, endAgentResponse } = get();
  if (props.sessionId !== currentSessionId) return;

  const failure =
    props.taskFailure &&
    typeof props.taskFailure === 'object' &&
    !Array.isArray(props.taskFailure)
      ? (props.taskFailure as Record<string, unknown>)
      : undefined;
  const failureCode = taskFailureCode(failure?.code);
  set({
    agentPhase: 'error',
    error: (props.error as string) || 'An error occurred',
    errorContext: {
      kind: 'execution',
      ...(currentSessionRef ? { sessionRef: currentSessionRef } : {}),
      ...(failureCode ? { failureCode } : {}),
    },
  });
  endAgentResponse();
};

const handleSessionStatus: EventHandler = (props, get, set) => {
  const { currentSessionId } = get();
  if (props.sessionId !== currentSessionId) return;

  if (props.status === 'idle') {
    set({
      isStreaming: false,
      isStopping: false,
      agentPhase: 'idle',
      currentRunId: null,
      pendingSteeringCount: 0,
      pendingInputDelivery: null,
      recoveredSteeringCount: 0,
    });
  } else if (
    props.status === 'queued' ||
    props.status === 'running' ||
    props.status === 'waiting_permission'
  ) {
    const queued = typeof props.queued === 'number' ? Math.max(0, props.queued) : 0;
    set({
      isStreaming: true,
      agentPhase:
        props.status === 'waiting_permission' ? 'waiting_permission' : 'running',
      currentRunId: typeof props.runId === 'string' ? props.runId : get().currentRunId,
      pendingSteeringCount: queued,
      pendingInputDelivery:
        queued > 0 &&
        (props.pendingInputDelivery === 'current_turn' ||
          props.pendingInputDelivery === 'next_turn')
          ? props.pendingInputDelivery
          : null,
      recoveredSteeringCount:
        typeof props.recovered === 'number'
          ? Math.max(0, props.recovered)
          : get().recoveredSteeringCount,
    });
  } else if (props.status === 'error') {
    set({
      isStreaming: false,
      isStopping: false,
      agentPhase: 'error',
      currentRunId: null,
      pendingSteeringCount: 0,
      pendingInputDelivery: null,
    });
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
    pendingInputDelivery: 'current_turn',
  });
};

const handleFollowUpQueued: EventHandler = (props, get, set) => {
  if (props.sessionId !== get().currentSessionId) return;
  set({
    pendingSteeringCount:
      typeof props.queued === 'number' ? Math.max(0, props.queued) : 1,
    pendingInputDelivery: 'next_turn',
  });
};

const handleSteeringApplied: EventHandler = (props, get, set) => {
  if (props.sessionId !== get().currentSessionId) return;
  const queued = typeof props.queued === 'number' ? Math.max(0, props.queued) : 0;
  set({
    pendingSteeringCount: queued,
    pendingInputDelivery: queued > 0 ? get().pendingInputDelivery : null,
    recoveredSteeringCount:
      typeof props.recovered === 'number'
        ? Math.max(0, props.recovered)
        : get().recoveredSteeringCount,
  });
};

const handleFollowUpStarted: EventHandler = (props, get, set) => {
  if (props.sessionId !== get().currentSessionId) return;
  const queued = typeof props.queued === 'number' ? Math.max(0, props.queued) : 0;
  set({
    agentPhase: 'running',
    pendingSteeringCount: queued,
    pendingInputDelivery: queued > 0 ? 'current_turn' : null,
    recoveredSteeringCount:
      typeof props.recovered === 'number'
        ? Math.max(0, props.recovered)
        : get().recoveredSteeringCount,
  });
};

const handleGoalUpdated: EventHandler = (props, get, set) => {
  if (props.sessionId !== get().currentSessionId) return;
  set({ goal: (props.goal as SessionStoreState['goal']) ?? null });
};

const handleGoalCleared: EventHandler = (props, get, set) => {
  if (props.sessionId !== get().currentSessionId) return;
  set({ goal: null });
};

const handleGoalContinuationStarted: EventHandler = (props, get, set) => {
  if (props.sessionId !== get().currentSessionId) return;
  set({
    goal: (props.goal as SessionStoreState['goal']) ?? get().goal,
    isStreaming: true,
    agentPhase: 'running',
  });
};

const handleSessionRewound: EventHandler = (props, get, set) => {
  if (props.sessionId !== get().currentSessionId || !Array.isArray(props.messages)) {
    return;
  }
  const now = Date.now();
  const rawMessages = props.messages.flatMap((value, index): ServiceMessage[] => {
    if (typeof value !== 'object' || value === null) return [];
    const raw = value as Record<string, unknown>;
    if (
      !['user', 'assistant', 'system', 'tool'].includes(String(raw.role)) ||
      (!Array.isArray(raw.content) && typeof raw.content !== 'string')
    ) {
      return [];
    }
    return [
      {
        id: `rewind-${index}-${now}`,
        role: raw.role as ServiceMessage['role'],
        content: raw.content as ServiceMessage['content'],
        timestamp: now + index,
        metadata:
          typeof raw.metadata === 'object' && raw.metadata !== null
            ? (raw.metadata as Record<string, unknown>)
            : undefined,
        thinkingContent:
          typeof raw.thinkingContent === 'string'
            ? raw.thinkingContent
            : typeof raw.reasoningContent === 'string'
              ? raw.reasoningContent
              : undefined,
        tool_call_id:
          typeof raw.tool_call_id === 'string' ? raw.tool_call_id : undefined,
        name: typeof raw.name === 'string' ? raw.name : undefined,
        tool_calls: raw.tool_calls as ServiceMessage['tool_calls'],
      },
    ];
  });
  set({
    messages: aggregateMessages(rawMessages),
    isStreaming: false,
    isStopping: false,
    agentPhase: 'idle',
    currentRunId: null,
    pendingSteeringCount: 0,
    pendingInputDelivery: null,
    recoveredSteeringCount: 0,
    currentAssistantMessageId: null,
    hasToolCalls: false,
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
  'interaction.resolved': handleInteractionResolved,
  'session.completed': handleSessionCompleted,
  'session.error': handleSessionError,
  'session.status': handleSessionStatus,
  'run.cancelled': handleRunCancelled,
  'steering.queued': handleSteeringQueued,
  'follow_up.queued': handleFollowUpQueued,
  'follow_up.started': handleFollowUpStarted,
  'steering.applied': handleSteeringApplied,
  'goal.updated': handleGoalUpdated,
  'goal.cleared': handleGoalCleared,
  'goal.continuation.started': handleGoalContinuationStarted,
  'session.rewound': handleSessionRewound,
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
    const ref = get().currentSessionRef;
    const props = event.properties;
    if (
      !ref ||
      props.sessionId !== ref.sessionId ||
      props.projectPath !== ref.projectPath
    ) {
      return;
    }

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

    // A tool group is a structural boundary in the assistant timeline. Flush
    // pending prose/reasoning first so an 80ms text buffer cannot reorder it.
    if (event.type === 'tool.start') {
      globalStreamingBuffer.drainAll();
    }

    // message.delta 走 buffer
    if (event.type === 'message.delta') {
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
      globalStreamingBuffer.drainAllExcept(channelKey);

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
      const { currentSessionId, currentAssistantMessageId } = get();
      if (props.sessionId !== currentSessionId) return;
      if (!currentAssistantMessageId) {
        const handler = eventHandlers['thinking.delta'];
        if (handler) handler(props, get, set);
        return;
      }

      const delta = props.delta as string;
      const targetMessageId =
        (props.messageId as string | undefined) || currentAssistantMessageId;
      const channelKey = `thinking:${targetMessageId}`;
      globalStreamingBuffer.drainAllExcept(channelKey);

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
