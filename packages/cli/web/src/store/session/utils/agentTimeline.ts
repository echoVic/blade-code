import type {
  AgentResponseContent,
  AgentTimelineBlock,
  SubagentProgress,
  ToolCallInfo,
} from '../types';

export function createEmptyAgentContent(): AgentResponseContent {
  return {
    timeline: [],
    textBefore: '',
    toolCalls: [],
    textAfter: '',
    thinkingContent: '',
    tasks: [],
    subagent: null,
    subagents: [],
    confirmation: null,
    question: null,
    elicitation: null,
  };
}

export function getSubagents(
  content: AgentResponseContent | undefined
): SubagentProgress[] {
  if (!content) return [];
  if (content.subagents && content.subagents.length > 0) {
    return content.subagents;
  }
  return content.subagent ? [content.subagent] : [];
}

export function withSubagents(
  content: AgentResponseContent,
  subagents: SubagentProgress[],
  preferredId?: string
): AgentResponseContent {
  const preferred =
    (preferredId
      ? subagents.find(
          (subagent) =>
            subagent.id === preferredId || subagent.sessionId === preferredId
        )
      : undefined) ??
    subagents[subagents.length - 1] ??
    null;
  return { ...content, subagents, subagent: preferred };
}

export function upsertSubagent(
  content: AgentResponseContent,
  next: SubagentProgress
): AgentResponseContent {
  const subagents = [...getSubagents(content)];
  let index = subagents.findIndex(
    (candidate) =>
      candidate.id === next.id ||
      Boolean(
        candidate.sessionId && next.sessionId && candidate.sessionId === next.sessionId
      )
  );
  if (index === -1 && next.sessionId) {
    index = subagents.findIndex(
      (candidate) =>
        !candidate.sessionId &&
        candidate.status === 'running' &&
        candidate.type === next.type &&
        candidate.description === next.description
    );
  }

  if (index === -1) {
    subagents.push(next);
    return withSubagents(content, subagents, next.id);
  }

  const existing = subagents[index];
  const merged = { ...existing, ...next, id: existing.id };
  subagents[index] = merged;
  return withSubagents(content, subagents, merged.id);
}

function nextBlockId(
  timeline: AgentTimelineBlock[],
  type: AgentTimelineBlock['type']
): string {
  return `${type}-${timeline.length}`;
}

export function appendTimelineText(
  content: AgentResponseContent,
  delta: string
): AgentResponseContent {
  if (!delta) return content;
  const timeline = [...getAgentTimeline(content)];
  const last = timeline[timeline.length - 1];
  if (last?.type === 'text') {
    timeline[timeline.length - 1] = { ...last, content: last.content + delta };
  } else {
    timeline.push({ id: nextBlockId(timeline, 'text'), type: 'text', content: delta });
  }
  return { ...content, timeline };
}

export function appendTimelineThinking(
  content: AgentResponseContent,
  delta: string
): AgentResponseContent {
  if (!delta) return content;
  const timeline = [...getAgentTimeline(content)];
  const last = timeline[timeline.length - 1];
  if (last?.type === 'thinking') {
    timeline[timeline.length - 1] = { ...last, content: last.content + delta };
  } else {
    timeline.push({
      id: nextBlockId(timeline, 'thinking'),
      type: 'thinking',
      content: delta,
    });
  }
  return { ...content, timeline };
}

export function appendTimelineToolCall(
  content: AgentResponseContent,
  toolCall: ToolCallInfo
): AgentResponseContent {
  const existingTool = content.toolCalls.some(
    (candidate) => candidate.toolCallId === toolCall.toolCallId
  );
  const toolCalls = existingTool ? content.toolCalls : [...content.toolCalls, toolCall];
  if (existingTool) return { ...content, toolCalls };

  const timeline = [...getAgentTimeline(content)];
  const last = timeline[timeline.length - 1];
  if (last?.type === 'tool_group') {
    timeline[timeline.length - 1] = {
      ...last,
      toolCallIds: [...last.toolCallIds, toolCall.toolCallId],
    };
  } else {
    timeline.push({
      id: nextBlockId(timeline, 'tool_group'),
      type: 'tool_group',
      toolCallIds: [toolCall.toolCallId],
    });
  }
  return { ...content, timeline, toolCalls };
}

export function getAgentTimeline(content: AgentResponseContent): AgentTimelineBlock[] {
  if (content.timeline && content.timeline.length > 0) return content.timeline;

  const timeline: AgentTimelineBlock[] = [];
  if (content.thinkingContent) {
    timeline.push({
      id: 'legacy-thinking',
      type: 'thinking',
      content: content.thinkingContent,
    });
  }
  if (content.textBefore) {
    timeline.push({
      id: 'legacy-text-before',
      type: 'text',
      content: content.textBefore,
    });
  }
  if (content.toolCalls.length > 0) {
    timeline.push({
      id: 'legacy-tool-group',
      type: 'tool_group',
      toolCallIds: content.toolCalls.map((toolCall) => toolCall.toolCallId),
    });
  }
  if (content.textAfter) {
    timeline.push({
      id: 'legacy-text-after',
      type: 'text',
      content: content.textAfter,
    });
  }
  return timeline;
}

export function getTimelineText(content: AgentResponseContent): string {
  return getAgentTimeline(content)
    .filter(
      (block): block is Extract<AgentTimelineBlock, { type: 'text' }> =>
        block.type === 'text'
    )
    .map((block) => block.content)
    .filter(Boolean)
    .join('\n\n');
}
