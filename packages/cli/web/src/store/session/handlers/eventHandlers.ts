import type { McpElicitationDetails } from '@api/schemas';
import { taskFailureCode } from '@/lib/taskFailure';
import type { Message as ServiceMessage, StreamEvent } from '@/services';
import type {
  Message,
  SessionStoreState,
  SubagentProgress,
  TaskItem,
  ToolCallInfo,
} from '../types';
import {
  createEmptyAgentContent,
  getSubagents,
  getTimelineText,
} from '../utils/agentTimeline';
import { aggregateMessages } from '../utils/aggregateMessages';
import {
  makeSubagentId,
  makeToolCallId,
  normalizeSubagentStatus,
} from '../utils/messageIdentity';
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

const findSubagentTarget = (
  messages: Message[],
  subagentId: string | undefined,
  preferredMessageId?: string | null
): { messageId: string; subagent: SubagentProgress } | undefined => {
  if (subagentId) {
    for (const message of messages) {
      const subagent = getSubagents(message.agentContent).find(
        (candidate) => candidate.id === subagentId || candidate.sessionId === subagentId
      );
      if (subagent) return { messageId: message.id, subagent };
    }
  }

  if (preferredMessageId) {
    const preferred = messages.find((message) => message.id === preferredMessageId);
    const candidates = getSubagents(preferred?.agentContent);
    const subagent =
      candidates.find((candidate) => candidate.status === 'running') ??
      candidates[candidates.length - 1];
    if (subagent) return { messageId: preferredMessageId, subagent };
  }

  for (const message of [...messages].reverse()) {
    const candidates = getSubagents(message.agentContent);
    const subagent =
      candidates.find((candidate) => candidate.status === 'running') ??
      candidates[candidates.length - 1];
    if (subagent) return { messageId: message.id, subagent };
  }
  return undefined;
};

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

const handleToolProgress: EventHandler = (props, get) => {
  const { currentSessionId, updateToolCall, messages } = get();
  if (props.sessionId !== currentSessionId) return;
  const toolCallId = props.toolCallId as string;
  if (!toolCallId) return;
  const message = messages.find((candidate) =>
    candidate.agentContent?.toolCalls.some((tool) => tool.toolCallId === toolCallId)
  );
  if (!message) return;
  updateToolCall(message.id, toolCallId, {
    summary: props.message as string,
    progress: typeof props.progress === 'number' ? props.progress : undefined,
    progressTotal: typeof props.total === 'number' ? props.total : undefined,
    progressMessage: props.message as string,
  });
};

const handleToolResult: EventHandler = (props, get, set) => {
  const { currentSessionId, updateToolCall, updateSubagent, messages } = get();
  if (props.sessionId !== currentSessionId) return;

  const toolCallId = props.toolCallId as string;
  if (!toolCallId) return;

  // 先通过 toolCallId 找到包含该工具调用的消息
  const messageWithTool = messages.find((m) =>
    m.agentContent?.toolCalls.some((tc) => tc.toolCallId === toolCallId)
  );
  const messageWithSubagent = messages.find((message) =>
    getSubagents(message.agentContent).some((subagent) => subagent.id === toolCallId)
  );

  const targetMessageId =
    (props.messageId as string) ||
    messageWithTool?.id ||
    messageWithSubagent?.id ||
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
  const matchingSubagent = getSubagents(message?.agentContent).find(
    (subagent) => subagent.id === toolCallId
  );

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

  if (matchingSubagent) {
    updateSubagent(targetMessageId, matchingSubagent.id, {
      sessionId: matchingSubagent.sessionId || subagentSessionId,
      type: subagentType || matchingSubagent.type,
      status: subagentStatus
        ? normalizeSubagentStatus(subagentStatus)
        : props.success
          ? 'completed'
          : 'failed',
      resumedFrom: subagentResumedFrom || matchingSubagent.resumedFrom,
      rootAgentId: subagentRootId || matchingSubagent.rootAgentId,
      resumeDepth: subagentResumeDepth ?? matchingSubagent.resumeDepth,
    });
  }

  if (subagentSessionId && subagentStatus) {
    set((state) => ({
      messages: state.messages.map((m) => {
        if (m.id !== targetMessageId) return m;
        const baseMetadata = (m.metadata ?? {}) as Record<string, unknown>;
        const existingRefs = Array.isArray(baseMetadata.subtaskRefs)
          ? (baseMetadata.subtaskRefs as Record<string, unknown>[])
          : [];
        const existingIndex = existingRefs.findIndex(
          (ref) =>
            ref.childSessionId === subagentSessionId || ref.subagentId === toolCallId
        );
        const existing =
          existingIndex >= 0
            ? existingRefs[existingIndex]
            : ((baseMetadata.subtaskRef as Record<string, unknown> | undefined) ?? {});
        const nextRef = {
          ...existing,
          subagentId: toolCallId,
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
        const subtaskRefs = [...existingRefs];
        if (existingIndex >= 0) subtaskRefs[existingIndex] = nextRef;
        else subtaskRefs.push(nextRef);
        return {
          ...m,
          metadata: {
            ...baseMetadata,
            subtaskRef: nextRef,
            subtaskRefs,
          },
        };
      }),
    }));
  }
};

const handleMcpCatalogChanged: EventHandler = (props, get, set) => {
  const { currentSessionId, appendToolCall } = get();
  if (props.sessionId !== currentSessionId) return;
  const messageId = ensureAssistantMessage(
    get,
    set,
    (props.messageId as string) || `mcp-catalog-${String(props.revision)}`
  );
  if (!messageId) return;
  const added = Array.isArray(props.added) ? props.added.map(String) : [];
  const removed = Array.isArray(props.removed) ? props.removed.map(String) : [];
  const updated = Array.isArray(props.updated) ? props.updated.map(String) : [];
  const summary =
    `MCP catalog r${String(props.revision)}: ` +
    `+${added.length} -${removed.length} ~${updated.length}`;
  appendToolCall(messageId, {
    toolCallId: `mcp-catalog:${String(props.revision)}`,
    toolName: 'MCP Catalog',
    arguments: JSON.stringify({
      serverName: props.serverName,
      added,
      removed,
      updated,
    }),
    toolKind: 'readonly',
    status: 'success',
    startTime: Date.now(),
    summary,
    output: [
      added.length > 0 ? `Added: ${added.join(', ')}` : '',
      removed.length > 0 ? `Removed: ${removed.join(', ')}` : '',
      updated.length > 0 ? `Updated: ${updated.join(', ')}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
  });
};

const handleMcpContentChanged: EventHandler = (props, get, set) => {
  const { currentSessionId, appendToolCall } = get();
  if (props.sessionId !== currentSessionId) return;
  const messageId = ensureAssistantMessage(
    get,
    set,
    (props.messageId as string) || `mcp-content-${String(props.revision)}`
  );
  if (!messageId) return;
  const added = Array.isArray(props.added) ? props.added.map(String) : [];
  const removed = Array.isArray(props.removed) ? props.removed.map(String) : [];
  const updated = Array.isArray(props.updated) ? props.updated.map(String) : [];
  const summary =
    `MCP ${String(props.contentKind)} r${String(props.revision)}: ` +
    `+${added.length} -${removed.length} ~${updated.length}`;
  appendToolCall(messageId, {
    toolCallId: `mcp-content:${String(props.revision)}`,
    toolName: 'MCP Content',
    arguments: JSON.stringify({
      serverName: props.serverName,
      contentKind: props.contentKind,
      added,
      removed,
      updated,
    }),
    toolKind: 'readonly',
    status: 'success',
    startTime: Date.now(),
    summary,
    output: [
      added.length > 0 ? `Added: ${added.join(', ')}` : '',
      removed.length > 0 ? `Removed: ${removed.join(', ')}` : '',
      updated.length > 0 ? `Updated: ${updated.join(', ')}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
  });
};

const handleMcpResourceUpdated: EventHandler = (props, get, set) => {
  const { currentSessionId, appendToolCall } = get();
  if (props.sessionId !== currentSessionId) return;
  const messageId = ensureAssistantMessage(
    get,
    set,
    (props.messageId as string) || `mcp-resource-${String(props.revision)}`
  );
  if (!messageId) return;
  appendToolCall(messageId, {
    toolCallId: `mcp-resource:${String(props.revision)}`,
    toolName: 'MCP Resource',
    arguments: JSON.stringify({
      serverName: props.serverName,
      uri: props.uri,
    }),
    toolKind: 'readonly',
    status: 'success',
    startTime: Date.now(),
    summary: `MCP resource updated: ${String(props.uri)}`,
    output: `${String(props.serverName)} · revision ${String(props.revision)}`,
  });
};

const handleMcpConnectionChanged: EventHandler = (props, get, set) => {
  const { currentSessionId, appendToolCall } = get();
  if (props.sessionId !== currentSessionId) return;
  const messageId = ensureAssistantMessage(
    get,
    set,
    (props.messageId as string) || `mcp-connection-${String(props.revision)}`
  );
  if (!messageId) return;
  const phase = String(props.phase);
  const summary =
    `MCP ${String(props.serverName)} ${phase}` +
    (phase === 'reconnecting'
      ? ` (${String(props.attempt)}/${String(props.maxAttempts)})`
      : '');
  appendToolCall(messageId, {
    toolCallId: `mcp-connection:${String(props.revision)}`,
    toolName: 'MCP Connection',
    arguments: JSON.stringify({
      serverName: props.serverName,
      phase,
      reason: props.reason,
      attempt: props.attempt,
      maxAttempts: props.maxAttempts,
    }),
    toolKind: 'readonly',
    status: phase === 'failed' ? 'error' : 'success',
    startTime: Date.now(),
    summary,
    output: [
      `Reason: ${String(props.reason)}`,
      props.error ? `Error: ${String(props.error)}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
  });
};

const handleMcpLog: EventHandler = (props, get, set) => {
  const { currentSessionId, appendToolCall } = get();
  if (props.sessionId !== currentSessionId) return;
  const messageId = ensureAssistantMessage(
    get,
    set,
    (props.messageId as string) || `mcp-log-${String(props.revision)}`
  );
  if (!messageId) return;
  const level = String(props.level);
  const logger = typeof props.logger === 'string' ? props.logger : undefined;
  const summary =
    `MCP ${level} · ${String(props.serverName)}` + (logger ? ` · ${logger}` : '');
  appendToolCall(messageId, {
    toolCallId: `mcp-log:${String(props.revision)}`,
    toolName: 'MCP Log',
    arguments: JSON.stringify({
      serverName: props.serverName,
      level,
      logger,
    }),
    toolKind: 'readonly',
    status: 'success',
    startTime: Date.now(),
    summary,
    output: [
      String(props.message),
      `SHA-256: ${String(props.dataSha256)}`,
      props.truncated === true ? 'Truncated' : '',
      props.detailsOmitted === true ? 'Details omitted by runtime policy' : '',
    ]
      .filter(Boolean)
      .join('\n'),
  });
};

const handleMcpInstructionsChanged: EventHandler = (props, get, set) => {
  const { currentSessionId, appendToolCall } = get();
  if (props.sessionId !== currentSessionId) return;
  const serverName = String(props.serverName);
  const action = String(props.action);
  const messageId = ensureAssistantMessage(
    get,
    set,
    (props.messageId as string) ||
      `mcp-instructions-${String(props.revision)}-${serverName}`
  );
  if (!messageId) return;
  const summary =
    `MCP instructions ${action}: ${serverName}` +
    (props.truncated === true ? ' (truncated)' : '');
  appendToolCall(messageId, {
    toolCallId: `mcp-instructions:${String(props.revision)}:${serverName}:${action}`,
    toolName: 'MCP Instructions',
    arguments: JSON.stringify({
      serverName,
      action,
      reason: props.reason,
    }),
    toolKind: 'readonly',
    status: 'success',
    startTime: Date.now(),
    summary,
    output: [
      typeof props.text === 'string' ? props.text : '',
      props.sha256 ? `SHA-256: ${String(props.sha256)}` : '',
      props.detailsOmitted === true ? 'Details omitted by runtime policy' : '',
    ]
      .filter(Boolean)
      .join('\n'),
  });
};

const handleMcpTaskChanged: EventHandler = (props, get, set) => {
  const { currentSessionId, appendToolCall, updateToolCall } = get();
  if (props.sessionId !== currentSessionId) return;
  const taskId = String(props.taskId);
  const status = String(props.status);
  const toolCallId = `mcp-task:${taskId}`;
  const messageId = ensureAssistantMessage(
    get,
    set,
    (props.messageId as string) || `mcp-task-${taskId}`
  );
  if (!messageId) return;
  const summary =
    `MCP task ${status}: ${taskId}` +
    ` · ${String(props.serverName)}/${String(props.toolName)}`;
  const taskProjection = {
    status:
      status === 'failed' || status === 'cancelled'
        ? ('error' as const)
        : status === 'completed'
          ? ('success' as const)
          : ('running' as const),
    summary,
    output: [
      typeof props.statusMessage === 'string' ? props.statusMessage : '',
      props.hasResult === true ? 'Result available via TaskOutput' : '',
      typeof props.error === 'string' ? `Error: ${props.error}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
  };
  const existing = get()
    .messages.find((message) => message.id === messageId)
    ?.agentContent?.toolCalls.some((tool) => tool.toolCallId === toolCallId);
  if (existing) {
    updateToolCall(messageId, toolCallId, taskProjection);
    return;
  }
  appendToolCall(messageId, {
    toolCallId,
    toolName: 'MCP Task',
    arguments: JSON.stringify({
      taskId,
      serverName: props.serverName,
      toolName: props.toolName,
    }),
    toolKind: 'readonly',
    status: taskProjection.status,
    startTime: Number(props.createdAt) || Date.now(),
    summary: taskProjection.summary,
    output: taskProjection.output,
  });
};

const handleProjectRulesLoaded: EventHandler = (props, get, set) => {
  const { currentSessionId, appendToolCall } = get();
  if (props.sessionId !== currentSessionId) return;
  const files = Array.isArray(props.files)
    ? props.files.filter(
        (file): file is Record<string, unknown> =>
          Boolean(file) && typeof file === 'object' && !Array.isArray(file)
      )
    : [];
  const messageId = ensureAssistantMessage(
    get,
    set,
    (props.messageId as string) || `project-rules-${Date.now()}`
  );
  if (!messageId) return;
  const blockedWrite = props.blockedWrite === true;
  const summary =
    `Project rules loaded: ${files.length}` +
    (blockedWrite ? ' (write retry required)' : '');
  appendToolCall(messageId, {
    toolCallId: `project-rules:${files.map((file) => String(file.id)).join(',')}`,
    toolName: 'Project Rules',
    arguments: JSON.stringify({
      triggerPaths: props.triggerPaths,
      blockedWrite,
    }),
    toolKind: 'readonly',
    status: 'success',
    startTime: Date.now(),
    summary,
    output: files
      .map(
        (file) =>
          `${String(file.relativePath)} ${String(file.source)} ` +
          `SHA-256: ${String(file.contentSha256)}`
      )
      .join('\n'),
  });
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

const handleSubagentUpdate: EventHandler = (props, get) => {
  const { currentSessionId, currentAssistantMessageId, messages, updateSubagent } =
    get();
  if (props.sessionId !== currentSessionId) return;
  const subagentSessionId = props.subagentSessionId as string | undefined;
  const target = findSubagentTarget(
    messages,
    subagentSessionId,
    currentAssistantMessageId
  );
  if (!target) return;
  updateSubagent(target.messageId, target.subagent.id, {
    sessionId: target.subagent.sessionId || subagentSessionId,
    currentTool: props.toolName as string,
  });
};

const handleSubagentDelta: EventHandler = (props, get) => {
  const { currentSessionId, currentAssistantMessageId, messages, updateSubagent } =
    get();
  if (props.sessionId !== currentSessionId) return;

  const delta = props.delta as string;
  if (!delta) return;

  const subagentSessionId = props.subagentSessionId as string | undefined;
  const target = findSubagentTarget(
    messages,
    subagentSessionId,
    currentAssistantMessageId
  );
  if (!target) return;
  updateSubagent(target.messageId, target.subagent.id, (current) => ({
    sessionId: current.sessionId || subagentSessionId,
    output: (current.output || '') + delta,
  }));
};

const handleSubagentThinkingDelta: EventHandler = (props, get) => {
  const { currentSessionId, currentAssistantMessageId, messages, updateSubagent } =
    get();
  if (props.sessionId !== currentSessionId) return;

  const delta = props.delta as string;
  if (!delta) return;

  const subagentSessionId = props.subagentSessionId as string | undefined;
  const target = findSubagentTarget(
    messages,
    subagentSessionId,
    currentAssistantMessageId
  );
  if (!target) return;
  updateSubagent(target.messageId, target.subagent.id, (current) => ({
    sessionId: current.sessionId || subagentSessionId,
    thinking: (current.thinking || '') + delta,
  }));
};

const handleSubagentComplete: EventHandler = (props, get) => {
  const { currentSessionId, currentAssistantMessageId, messages, updateSubagent } =
    get();
  if (props.sessionId !== currentSessionId) return;
  const subagentSessionId = props.subagentSessionId as string | undefined;
  const target = findSubagentTarget(
    messages,
    subagentSessionId,
    currentAssistantMessageId
  );
  if (!target) return;
  updateSubagent(target.messageId, target.subagent.id, {
    sessionId: target.subagent.sessionId || subagentSessionId,
    status: props.success ? 'completed' : 'failed',
    currentTool: undefined,
  });
};

const handleSubagentToolStart: EventHandler = (props, get) => {
  const { currentSessionId, currentAssistantMessageId, messages, updateSubagent } =
    get();
  if (props.sessionId !== currentSessionId) return;

  const toolCallId = props.toolCallId as string;
  const toolName = props.toolName as string;
  if (!toolCallId || !toolName) return;

  const subagentSessionId = props.subagentSessionId as string | undefined;
  const target = findSubagentTarget(
    messages,
    subagentSessionId,
    currentAssistantMessageId
  );
  if (!target) return;

  const toolCall: ToolCallInfo = {
    toolCallId,
    toolName,
    arguments: props.arguments as string,
    toolKind: props.toolKind as string,
    status: 'running',
    startTime: Date.now(),
  };

  updateSubagent(target.messageId, target.subagent.id, (current) => {
    const existing = current.toolCalls || [];
    return {
      sessionId: current.sessionId || subagentSessionId,
      currentTool: toolName,
      toolCalls: existing.some((tool) => tool.toolCallId === toolCallId)
        ? existing
        : [...existing, toolCall],
    };
  });
};

const handleSubagentToolResult: EventHandler = (props, get) => {
  const { currentSessionId, currentAssistantMessageId, messages, updateSubagent } =
    get();
  if (props.sessionId !== currentSessionId) return;

  const toolCallId = props.toolCallId as string;
  if (!toolCallId) return;
  const toolName = props.toolName as string | undefined;

  const subagentSessionId = props.subagentSessionId as string | undefined;
  const target = findSubagentTarget(
    messages,
    subagentSessionId,
    currentAssistantMessageId
  );
  if (!target) return;

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

  updateSubagent(target.messageId, target.subagent.id, (current) => ({
    sessionId: current.sessionId || subagentSessionId,
    currentTool: current.currentTool === toolName ? undefined : current.currentTool,
    toolCalls: (current.toolCalls || []).map((tool) =>
      tool.toolCallId === toolCallId
        ? {
            ...tool,
            status,
            summary,
            output,
            metadata: props.metadata as Record<string, unknown>,
          }
        : tool
    ),
  }));
};

const handleSubagentToolProgress: EventHandler = (props, get) => {
  const { currentSessionId, currentAssistantMessageId, messages, updateSubagent } =
    get();
  if (props.sessionId !== currentSessionId) return;
  const toolCallId = props.toolCallId as string;
  if (!toolCallId) return;
  const target = findSubagentTarget(
    messages,
    props.subagentSessionId as string | undefined,
    currentAssistantMessageId
  );
  if (!target) return;
  updateSubagent(target.messageId, target.subagent.id, (current) => ({
    toolCalls: (current.toolCalls || []).map((tool) =>
      tool.toolCallId === toolCallId
        ? {
            ...tool,
            summary: props.message as string,
            progress: typeof props.progress === 'number' ? props.progress : undefined,
            progressTotal: typeof props.total === 'number' ? props.total : undefined,
            progressMessage: props.message as string,
          }
        : tool
    ),
  }));
};

const handleSubagentMcpCatalogChanged: EventHandler = (props, get) => {
  const { currentSessionId, currentAssistantMessageId, messages, updateSubagent } =
    get();
  if (props.sessionId !== currentSessionId) return;
  const target = findSubagentTarget(
    messages,
    props.subagentSessionId as string | undefined,
    currentAssistantMessageId
  );
  if (!target) return;
  const added = Array.isArray(props.added) ? props.added.map(String) : [];
  const removed = Array.isArray(props.removed) ? props.removed.map(String) : [];
  const updated = Array.isArray(props.updated) ? props.updated.map(String) : [];
  const toolCallId = `mcp-catalog:${String(props.revision)}`;
  updateSubagent(target.messageId, target.subagent.id, (current) => ({
    toolCalls: [
      ...(current.toolCalls || []).filter((tool) => tool.toolCallId !== toolCallId),
      {
        toolCallId,
        toolName: 'MCP Catalog',
        arguments: JSON.stringify({
          serverName: props.serverName,
          added,
          removed,
          updated,
        }),
        toolKind: 'readonly',
        status: 'success',
        startTime: Date.now(),
        summary:
          `MCP catalog r${String(props.revision)}: ` +
          `+${added.length} -${removed.length} ~${updated.length}`,
        output: [
          added.length > 0 ? `Added: ${added.join(', ')}` : '',
          removed.length > 0 ? `Removed: ${removed.join(', ')}` : '',
          updated.length > 0 ? `Updated: ${updated.join(', ')}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      },
    ],
  }));
};

const handleSubagentMcpContentChanged: EventHandler = (props, get) => {
  const { currentSessionId, currentAssistantMessageId, messages, updateSubagent } =
    get();
  if (props.sessionId !== currentSessionId) return;
  const target = findSubagentTarget(
    messages,
    props.subagentSessionId as string | undefined,
    currentAssistantMessageId
  );
  if (!target) return;
  const added = Array.isArray(props.added) ? props.added.map(String) : [];
  const removed = Array.isArray(props.removed) ? props.removed.map(String) : [];
  const updated = Array.isArray(props.updated) ? props.updated.map(String) : [];
  const toolCallId = `mcp-content:${String(props.revision)}`;
  updateSubagent(target.messageId, target.subagent.id, (current) => ({
    toolCalls: [
      ...(current.toolCalls || []).filter((tool) => tool.toolCallId !== toolCallId),
      {
        toolCallId,
        toolName: 'MCP Content',
        arguments: JSON.stringify({
          serverName: props.serverName,
          contentKind: props.contentKind,
          added,
          removed,
          updated,
        }),
        toolKind: 'readonly',
        status: 'success',
        startTime: Date.now(),
        summary:
          `MCP ${String(props.contentKind)} r${String(props.revision)}: ` +
          `+${added.length} -${removed.length} ~${updated.length}`,
      },
    ],
  }));
};

const handleSubagentMcpResourceUpdated: EventHandler = (props, get) => {
  const { currentSessionId, currentAssistantMessageId, messages, updateSubagent } =
    get();
  if (props.sessionId !== currentSessionId) return;
  const target = findSubagentTarget(
    messages,
    props.subagentSessionId as string | undefined,
    currentAssistantMessageId
  );
  if (!target) return;
  const toolCallId = `mcp-resource:${String(props.revision)}`;
  updateSubagent(target.messageId, target.subagent.id, (current) => ({
    toolCalls: [
      ...(current.toolCalls || []).filter((tool) => tool.toolCallId !== toolCallId),
      {
        toolCallId,
        toolName: 'MCP Resource',
        arguments: JSON.stringify({
          serverName: props.serverName,
          uri: props.uri,
        }),
        toolKind: 'readonly',
        status: 'success',
        startTime: Date.now(),
        summary: `MCP resource updated: ${String(props.uri)}`,
      },
    ],
  }));
};

const handleSubagentMcpConnectionChanged: EventHandler = (props, get) => {
  const { currentSessionId, currentAssistantMessageId, messages, updateSubagent } =
    get();
  if (props.sessionId !== currentSessionId) return;
  const target = findSubagentTarget(
    messages,
    props.subagentSessionId as string | undefined,
    currentAssistantMessageId
  );
  if (!target) return;
  const phase = String(props.phase);
  const toolCallId = `mcp-connection:${String(props.revision)}`;
  updateSubagent(target.messageId, target.subagent.id, (current) => ({
    toolCalls: [
      ...(current.toolCalls || []).filter((tool) => tool.toolCallId !== toolCallId),
      {
        toolCallId,
        toolName: 'MCP Connection',
        arguments: JSON.stringify({
          serverName: props.serverName,
          phase,
          reason: props.reason,
          attempt: props.attempt,
          maxAttempts: props.maxAttempts,
        }),
        toolKind: 'readonly',
        status: phase === 'failed' ? 'error' : 'success',
        startTime: Date.now(),
        summary:
          `MCP ${String(props.serverName)} ${phase}` +
          (phase === 'reconnecting'
            ? ` (${String(props.attempt)}/${String(props.maxAttempts)})`
            : ''),
        output: props.error ? `Error: ${String(props.error)}` : undefined,
      },
    ],
  }));
};

const handleSubagentMcpLog: EventHandler = (props, get) => {
  const { currentSessionId, currentAssistantMessageId, messages, updateSubagent } =
    get();
  if (props.sessionId !== currentSessionId) return;
  const target = findSubagentTarget(
    messages,
    props.subagentSessionId as string | undefined,
    currentAssistantMessageId
  );
  if (!target) return;
  const level = String(props.level);
  const logger = typeof props.logger === 'string' ? props.logger : undefined;
  const toolCallId = `mcp-log:${String(props.revision)}`;
  updateSubagent(target.messageId, target.subagent.id, (current) => ({
    toolCalls: [
      ...(current.toolCalls || []).filter((tool) => tool.toolCallId !== toolCallId),
      {
        toolCallId,
        toolName: 'MCP Log',
        arguments: JSON.stringify({
          serverName: props.serverName,
          level,
          logger,
        }),
        toolKind: 'readonly',
        status: 'success',
        startTime: Date.now(),
        summary:
          `MCP ${level} · ${String(props.serverName)}` + (logger ? ` · ${logger}` : ''),
        output: [
          String(props.message),
          `SHA-256: ${String(props.dataSha256)}`,
          props.truncated === true ? 'Truncated' : '',
          props.detailsOmitted === true ? 'Details omitted by runtime policy' : '',
        ]
          .filter(Boolean)
          .join('\n'),
      },
    ],
  }));
};

const handleSubagentMcpInstructionsChanged: EventHandler = (props, get) => {
  const { currentSessionId, currentAssistantMessageId, messages, updateSubagent } =
    get();
  if (props.sessionId !== currentSessionId) return;
  const target = findSubagentTarget(
    messages,
    props.subagentSessionId as string | undefined,
    currentAssistantMessageId
  );
  if (!target) return;
  const serverName = String(props.serverName);
  const action = String(props.action);
  const toolCallId = `mcp-instructions:${String(props.revision)}:${serverName}:${action}`;
  updateSubagent(target.messageId, target.subagent.id, (current) => ({
    toolCalls: [
      ...(current.toolCalls || []).filter((tool) => tool.toolCallId !== toolCallId),
      {
        toolCallId,
        toolName: 'MCP Instructions',
        arguments: JSON.stringify({
          serverName,
          action,
          reason: props.reason,
        }),
        toolKind: 'readonly',
        status: 'success',
        startTime: Date.now(),
        summary:
          `MCP instructions ${action}: ${serverName}` +
          (props.truncated === true ? ' (truncated)' : ''),
        output: [
          typeof props.text === 'string' ? props.text : '',
          props.sha256 ? `SHA-256: ${String(props.sha256)}` : '',
          props.detailsOmitted === true ? 'Details omitted by runtime policy' : '',
        ]
          .filter(Boolean)
          .join('\n'),
      },
    ],
  }));
};

const handleSubagentMcpTaskChanged: EventHandler = (props, get) => {
  const { currentSessionId, currentAssistantMessageId, messages, updateSubagent } =
    get();
  if (props.sessionId !== currentSessionId) return;
  const target = findSubagentTarget(
    messages,
    props.subagentSessionId as string | undefined,
    currentAssistantMessageId
  );
  if (!target) return;
  const taskId = String(props.taskId);
  const status = String(props.status);
  const toolCallId = `mcp-task:${taskId}`;
  updateSubagent(target.messageId, target.subagent.id, (current) => ({
    toolCalls: [
      ...(current.toolCalls || []).filter((tool) => tool.toolCallId !== toolCallId),
      {
        toolCallId,
        toolName: 'MCP Task',
        arguments: JSON.stringify({
          taskId,
          serverName: props.serverName,
          toolName: props.toolName,
        }),
        toolKind: 'readonly',
        status:
          status === 'failed' || status === 'cancelled'
            ? 'error'
            : status === 'completed'
              ? 'success'
              : 'running',
        startTime: Number(props.createdAt) || Date.now(),
        summary:
          `MCP task ${status}: ${taskId}` +
          ` · ${String(props.serverName)}/${String(props.toolName)}`,
        output: [
          typeof props.statusMessage === 'string' ? props.statusMessage : '',
          props.hasResult === true ? 'Result available via TaskOutput' : '',
          typeof props.error === 'string' ? `Error: ${props.error}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      },
    ],
  }));
};

const handleSubagentProjectRulesLoaded: EventHandler = (props, get) => {
  const { currentSessionId, currentAssistantMessageId, messages, updateSubagent } =
    get();
  if (props.sessionId !== currentSessionId) return;
  const target = findSubagentTarget(
    messages,
    props.subagentSessionId as string | undefined,
    currentAssistantMessageId
  );
  if (!target) return;
  const files = Array.isArray(props.files)
    ? props.files.filter(
        (file): file is Record<string, unknown> =>
          Boolean(file) && typeof file === 'object' && !Array.isArray(file)
      )
    : [];
  const toolCallId = `project-rules:${files.map((file) => String(file.id)).join(',')}`;
  updateSubagent(target.messageId, target.subagent.id, (current) => ({
    toolCalls: [
      ...(current.toolCalls || []).filter((tool) => tool.toolCallId !== toolCallId),
      {
        toolCallId,
        toolName: 'Project Rules',
        arguments: JSON.stringify({
          triggerPaths: props.triggerPaths,
          blockedWrite: props.blockedWrite,
        }),
        toolKind: 'readonly',
        status: 'success',
        startTime: Date.now(),
        summary: `Project rules loaded: ${files.length}`,
        output: files
          .map(
            (file) =>
              `${String(file.relativePath)} ${String(file.source)} ` +
              `SHA-256: ${String(file.contentSha256)}`
          )
          .join('\n'),
      },
    ],
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
    (props.toolName as string) || (details?.toolName as string) || 'Tool';

  setConfirmation(assistantMessageId, {
    toolCallId: requestId,
    toolName,
    description: props.description as string,
    diff: (details?.details as string) || (details?.diff as string) || '',
    allowRemember: details?.type !== 'mcpSampling',
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
  const {
    currentSessionId,
    currentSessionRef,
    messages,
    setConfirmation,
    setElicitation,
  } = get();
  if (props.sessionId !== currentSessionId) return;

  const requestId = props.requestId as string;
  const message = messages.find(
    (candidate) => candidate.agentContent?.confirmation?.toolCallId === requestId
  );
  const confirmation = message?.agentContent?.confirmation;
  if (message && confirmation?.status === 'pending') {
    setConfirmation(message.id, { ...confirmation, status: 'denied' });
  }
  const elicitationMessage = messages.find(
    (candidate) => candidate.agentContent?.elicitation?.toolCallId === requestId
  );
  const elicitation = elicitationMessage?.agentContent?.elicitation;
  if (elicitationMessage && elicitation?.status === 'pending') {
    setElicitation(elicitationMessage.id, {
      ...elicitation,
      status: 'cancelled',
    });
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

const handleElicitationRequired: EventHandler = (props, get, set) => {
  const { currentSessionId, setElicitation } = get();
  if (props.sessionId !== currentSessionId) return;
  const requestId = (props.requestId as string) || (props.toolCallId as string) || '';
  const assistantMessageId = ensureAssistantMessage(
    get,
    set,
    requestId ? `assistant-elicitation-${requestId}` : undefined
  );
  const details = props.elicitation as McpElicitationDetails | undefined;
  if (!assistantMessageId || !details) return;

  setElicitation(assistantMessageId, {
    toolCallId: requestId,
    details,
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
              type: 'elicitation' as const,
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
  const { currentSessionId, endAgentResponse, messages, updateSubagent } = get();
  if (props.sessionId !== currentSessionId) return;

  set((state) => ({
    isStreaming: false,
    agentPhase: 'idle',
    messages: state.messages.map((message) => {
      const elicitation = message.agentContent?.elicitation;
      if (elicitation?.status !== 'pending' || !message.agentContent) {
        return message;
      }
      return {
        ...message,
        agentContent: {
          ...message.agentContent,
          elicitation: { ...elicitation, status: 'cancelled' as const },
        },
      };
    }),
  }));
  for (const message of messages) {
    for (const subagent of getSubagents(message.agentContent)) {
      if (subagent.status === 'running') {
        updateSubagent(message.id, subagent.id, { status: 'failed' });
      }
    }
  }
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
  'tool.progress': handleToolProgress,
  'tool.result': handleToolResult,
  'mcp.catalog.changed': handleMcpCatalogChanged,
  'mcp.content.changed': handleMcpContentChanged,
  'mcp.resource.updated': handleMcpResourceUpdated,
  'mcp.connection.changed': handleMcpConnectionChanged,
  'mcp.log': handleMcpLog,
  'mcp.instructions.changed': handleMcpInstructionsChanged,
  'mcp.task.changed': handleMcpTaskChanged,
  'project.rules.loaded': handleProjectRulesLoaded,
  'token.usage': handleTokenUsage,
  'task.updated': handleTaskUpdate,
  'subagent.start': handleSubagentStart,
  'subagent.update': handleSubagentUpdate,
  'subagent.delta': handleSubagentDelta,
  'subagent.thinking.delta': handleSubagentThinkingDelta,
  'subagent.tool.start': handleSubagentToolStart,
  'subagent.tool.progress': handleSubagentToolProgress,
  'subagent.tool.result': handleSubagentToolResult,
  'subagent.mcp.catalog.changed': handleSubagentMcpCatalogChanged,
  'subagent.mcp.content.changed': handleSubagentMcpContentChanged,
  'subagent.mcp.resource.updated': handleSubagentMcpResourceUpdated,
  'subagent.mcp.connection.changed': handleSubagentMcpConnectionChanged,
  'subagent.mcp.log': handleSubagentMcpLog,
  'subagent.mcp.instructions.changed': handleSubagentMcpInstructionsChanged,
  'subagent.mcp.task.changed': handleSubagentMcpTaskChanged,
  'subagent.project.rules.loaded': handleSubagentProjectRulesLoaded,
  'subagent.complete': handleSubagentComplete,
  'permission.asked': handlePermissionAsked,
  'permission.timeout': handlePermissionTimeout,
  'turn.started': handleTurnStarted,
  'compaction.started': handleCompactionStarted,
  'compaction.completed': handleCompactionCompleted,
  'model.fallback': handleModelFallback,
  'question.required': handleQuestionRequired,
  'elicitation.required': handleElicitationRequired,
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
      const targetAtAppend = findSubagentTarget(
        targetMessages,
        subagentSessionId || undefined,
        targetCurrentAssistantMessageId
      );

      globalStreamingBuffer.append(channelKey, delta, (bufferedDelta) => {
        const { currentAssistantMessageId, messages, updateSubagent } = get();
        const target =
          targetAtAppend ||
          findSubagentTarget(
            messages,
            subagentSessionId || undefined,
            currentAssistantMessageId
          );

        if (!target) return;
        updateSubagent(target.messageId, target.subagent.id, (current) => ({
          sessionId: current.sessionId || subagentSessionId,
          output: (current.output || '') + bufferedDelta,
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
      const targetAtAppend = findSubagentTarget(
        targetMessages,
        subagentSessionId || undefined,
        targetCurrentAssistantMessageId
      );

      globalStreamingBuffer.append(channelKey, delta, (bufferedDelta) => {
        const { currentAssistantMessageId, messages, updateSubagent } = get();
        const target =
          targetAtAppend ||
          findSubagentTarget(
            messages,
            subagentSessionId || undefined,
            currentAssistantMessageId
          );

        if (!target) return;
        updateSubagent(target.messageId, target.subagent.id, (current) => ({
          sessionId: current.sessionId || subagentSessionId,
          thinking: (current.thinking || '') + bufferedDelta,
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
