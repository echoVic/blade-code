import type { Message as RawMessage } from '@/services';
import type {
  AgentResponseContent,
  Message,
  SubagentProgress,
  ToolCallInfo,
} from '../types';
import {
  makeSubagentId,
  makeToolCallId,
  normalizeSubagentStatus,
  normalizeToolArguments,
} from './messageIdentity';

const createEmptyAgentContent = (): AgentResponseContent => ({
  textBefore: '',
  toolCalls: [],
  textAfter: '',
  thinkingContent: '',
  todos: [],
  subagent: null,
  confirmation: null,
  question: null,
});

const parseSubtaskRef = (
  messageId: string,
  metadata: Record<string, unknown> | undefined
): SubagentProgress | null => {
  if (!metadata || typeof metadata !== 'object' || !('subtaskRef' in metadata)) {
    return null;
  }
  const ref = metadata.subtaskRef as Record<string, unknown>;
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
  };
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
    if (raw.role === 'user' || raw.role === 'system') {
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
      const agentContent = createEmptyAgentContent();
      agentContent.textBefore = getTextContent(raw.content);
      if (raw.thinkingContent) {
        agentContent.thinkingContent = raw.thinkingContent;
      }

      agentContent.subagent = parseSubtaskRef(raw.id, metadata);

      if (raw.tool_calls && Array.isArray(raw.tool_calls)) {
        for (const tc of raw.tool_calls) {
          const toolName = tc.function?.name || 'Unknown';
          const argumentsText = normalizeToolArguments(tc.function?.arguments);
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
          agentContent.toolCalls.push(toolCall);
        }
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

        const existingTool = currentAssistant.agentContent.toolCalls.find(
          (tc) => tc.toolCallId === toolCallId
        );

        if (existingTool) {
          existingTool.output = getTextContent(raw.content);
          existingTool.status = 'success';
          if (!existingTool.toolName || existingTool.toolName === 'Unknown') {
            existingTool.toolName = toolName;
          }
        } else {
          currentAssistant.agentContent.toolCalls.push({
            toolCallId: makeToolCallId({
              explicitId: toolCallId,
              messageId: currentAssistant.id,
              toolName,
              output: getTextContent(raw.content),
            }),
            toolName,
            output: getTextContent(raw.content),
            status: 'success',
            startTime: Date.now(),
          });
        }
      }
    }
  }

  if (currentAssistant) {
    result.push(currentAssistant);
  }

  return result;
}
