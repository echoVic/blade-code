import type { Message as RawMessage } from '@/services';
import type { Message, SubagentProgress, ToolCallInfo } from '../types';
import {
  appendTimelineText,
  appendTimelineThinking,
  appendTimelineToolCall,
  createEmptyAgentContent,
  getSubagents,
  upsertSubagent,
  withSubagents,
} from './agentTimeline';
import {
  makeSubagentId,
  makeToolCallId,
  normalizeSubagentStatus,
  normalizeToolArguments,
} from './messageIdentity';

const parseSubtaskRef = (
  messageId: string,
  ref: Record<string, unknown>
): SubagentProgress | null => {
  if (!ref || typeof ref !== 'object') return null;

  return {
    id: makeSubagentId({
      explicitId: typeof ref.subagentId === 'string' ? ref.subagentId : undefined,
      sessionId: ref.childSessionId as string | undefined,
      messageId,
      agentType: ref.agentType as string | undefined,
      description: ref.description as string | undefined,
      summary: ref.summary as string | undefined,
    }),
    type: (ref.agentType as string) || 'subagent',
    description: (ref.description as string) || (ref.summary as string) || '',
    status: normalizeSubagentStatus(ref.status),
    startTime: Date.now(),
    sessionId: ref.childSessionId as string | undefined,
    resumedFrom: ref.resumedFrom as string | undefined,
    rootAgentId: ref.rootAgentId as string | undefined,
    resumeDepth: typeof ref.resumeDepth === 'number' ? ref.resumeDepth : undefined,
  };
};

const parseSubtaskRefs = (
  messageId: string,
  metadata: Record<string, unknown> | undefined
): SubagentProgress[] => {
  if (!metadata || typeof metadata !== 'object') return [];
  const refs = Array.isArray(metadata.subtaskRefs)
    ? (metadata.subtaskRefs as Record<string, unknown>[])
    : metadata.subtaskRef && typeof metadata.subtaskRef === 'object'
      ? [metadata.subtaskRef as Record<string, unknown>]
      : [];
  return refs
    .map((ref) => parseSubtaskRef(messageId, ref))
    .filter((subagent): subagent is SubagentProgress => subagent !== null);
};

function getTextContent(content: RawMessage['content']): string {
  if (typeof content === 'string') return content;
  return content
    .filter(
      (part): part is Extract<typeof part, { type: 'text' }> => part.type === 'text'
    )
    .map((part) => part.text)
    .join('\n');
}

export function aggregateMessages(rawMessages: RawMessage[]): Message[] {
  const result: Message[] = [];
  let currentAssistant: Message | null = null;

  for (const raw of rawMessages) {
    if (raw.role === 'system') continue;
    if (raw.role === 'user') {
      if (currentAssistant) {
        result.push(currentAssistant);
        currentAssistant = null;
      }
      result.push({
        id: raw.id,
        role: raw.role,
        content: raw.content,
        timestamp: raw.timestamp || Date.now(),
        metadata: raw.metadata as Record<string, unknown> | undefined,
      });
    } else if (raw.role === 'assistant') {
      if (currentAssistant) {
        result.push(currentAssistant);
      }
      const metadata = raw.metadata as Record<string, unknown> | undefined;
      let agentContent = createEmptyAgentContent();
      if (raw.thinkingContent) {
        agentContent = appendTimelineThinking(agentContent, raw.thinkingContent);
        agentContent.thinkingContent = raw.thinkingContent;
      }
      const textContent = getTextContent(raw.content);
      if (textContent) {
        agentContent = appendTimelineText(agentContent, textContent);
        agentContent.textBefore = textContent;
      }

      const persistedSubagents = parseSubtaskRefs(raw.id, metadata);

      if (raw.tool_calls && Array.isArray(raw.tool_calls)) {
        for (const tc of raw.tool_calls) {
          const toolName = tc.function?.name || 'Unknown';
          const argumentsText = normalizeToolArguments(tc.function?.arguments);
          if (toolName === 'Task') {
            let taskArgs: Record<string, unknown> = {};
            try {
              taskArgs = JSON.parse(argumentsText) as Record<string, unknown>;
            } catch {
              // Keep a recoverable card even when historical arguments are bad.
            }
            const type =
              typeof taskArgs.subagent_type === 'string'
                ? taskArgs.subagent_type
                : 'subagent';
            const description =
              typeof taskArgs.description === 'string' ? taskArgs.description : type;
            agentContent = upsertSubagent(agentContent, {
              id: makeSubagentId({
                explicitId: tc.id,
                sessionId:
                  typeof taskArgs.subagent_session_id === 'string'
                    ? taskArgs.subagent_session_id
                    : undefined,
                messageId: raw.id,
                agentType: type,
                description,
              }),
              type,
              description,
              status: 'running',
              startTime: Date.now(),
              sessionId:
                typeof taskArgs.subagent_session_id === 'string'
                  ? taskArgs.subagent_session_id
                  : undefined,
              resumedFrom:
                typeof taskArgs.resume_from === 'string'
                  ? taskArgs.resume_from
                  : typeof taskArgs.resume === 'string'
                    ? taskArgs.resume
                    : undefined,
            });
            continue;
          }
          const toolCall: ToolCallInfo = {
            toolCallId: makeToolCallId({
              explicitId: tc.id,
              messageId: raw.id,
              toolName,
              argumentsValue: tc.function?.arguments,
            }),
            toolName,
            arguments: argumentsText,
            status: 'running',
            startTime: Date.now(),
          };
          agentContent = appendTimelineToolCall(agentContent, toolCall);
        }
      }
      for (const subagent of persistedSubagents) {
        agentContent = upsertSubagent(agentContent, subagent);
      }

      currentAssistant = {
        id: raw.id,
        role: 'assistant',
        content: getTextContent(raw.content),
        timestamp: raw.timestamp || Date.now(),
        metadata,
        agentContent,
      };
    } else if (raw.role === 'tool') {
      if (currentAssistant && currentAssistant.agentContent) {
        const rawAny = raw as unknown as Record<string, unknown>;
        const metadata = raw.metadata as Record<string, unknown> | undefined;
        const toolCallId =
          (rawAny.tool_call_id as string) || (metadata?.toolCallId as string);
        const toolName =
          (rawAny.name as string) || (metadata?.toolName as string) || 'Tool';
        const toolMetadata =
          metadata?.metadata &&
          typeof metadata.metadata === 'object' &&
          !Array.isArray(metadata.metadata)
            ? (metadata.metadata as Record<string, unknown>)
            : undefined;
        const failed = typeof metadata?.error === 'string' && metadata.error.length > 0;
        const subagents = getSubagents(currentAssistant.agentContent);
        const subagentIndex = subagents.findIndex(
          (subagent) => subagent.id === toolCallId
        );

        if (subagentIndex >= 0) {
          const current = subagents[subagentIndex];
          const subagentStatus =
            typeof toolMetadata?.subagentStatus === 'string'
              ? normalizeSubagentStatus(toolMetadata.subagentStatus)
              : failed
                ? 'failed'
                : 'completed';
          subagents[subagentIndex] = {
            ...current,
            sessionId:
              typeof toolMetadata?.subagentSessionId === 'string'
                ? toolMetadata.subagentSessionId
                : current.sessionId,
            type:
              typeof toolMetadata?.subagentType === 'string'
                ? toolMetadata.subagentType
                : current.type,
            status: subagentStatus,
            resumedFrom:
              typeof toolMetadata?.subagentResumedFrom === 'string'
                ? toolMetadata.subagentResumedFrom
                : current.resumedFrom,
            rootAgentId:
              typeof toolMetadata?.subagentRootId === 'string'
                ? toolMetadata.subagentRootId
                : current.rootAgentId,
            resumeDepth:
              typeof toolMetadata?.subagentResumeDepth === 'number'
                ? toolMetadata.subagentResumeDepth
                : current.resumeDepth,
          };
          currentAssistant.agentContent = withSubagents(
            currentAssistant.agentContent,
            subagents,
            current.id
          );
          continue;
        }

        const existingTool = currentAssistant.agentContent.toolCalls.find(
          (tc) => tc.toolCallId === toolCallId
        );

        if (existingTool) {
          existingTool.output = getTextContent(raw.content);
          existingTool.status = failed ? 'error' : 'success';
          existingTool.metadata = toolMetadata;
          existingTool.summary =
            typeof toolMetadata?.summary === 'string'
              ? toolMetadata.summary
              : existingTool.summary;
          if (!existingTool.toolName || existingTool.toolName === 'Unknown') {
            existingTool.toolName = toolName;
          }
        } else {
          currentAssistant.agentContent = appendTimelineToolCall(
            currentAssistant.agentContent,
            {
              toolCallId: makeToolCallId({
                explicitId: toolCallId,
                messageId: currentAssistant.id,
                toolName,
                output: getTextContent(raw.content),
              }),
              toolName,
              output: getTextContent(raw.content),
              status: failed ? 'error' : 'success',
              startTime: Date.now(),
              metadata: toolMetadata,
              summary:
                typeof toolMetadata?.summary === 'string'
                  ? toolMetadata.summary
                  : undefined,
            }
          );
        }
      }
    }
  }

  if (currentAssistant) {
    result.push(currentAssistant);
  }

  return result;
}
