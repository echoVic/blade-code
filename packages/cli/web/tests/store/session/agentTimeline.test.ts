import { describe, expect, it } from 'vitest';
import {
  appendTimelineText,
  appendTimelineThinking,
  appendTimelineToolCall,
  createEmptyAgentContent,
  getAgentTimeline,
} from '@/store/session/utils/agentTimeline';

describe('agentTimeline', () => {
  it('preserves interleaved thinking, prose, and tool groups', () => {
    let content = createEmptyAgentContent();
    content = appendTimelineThinking(content, 'inspect');
    content = appendTimelineText(content, 'first explanation');
    content = appendTimelineToolCall(content, {
      toolCallId: 'read-1',
      toolName: 'Read',
      status: 'success',
      startTime: 1,
    });
    content = appendTimelineToolCall(content, {
      toolCallId: 'read-2',
      toolName: 'Read',
      status: 'success',
      startTime: 2,
    });
    content = appendTimelineText(content, 'second explanation');
    content = appendTimelineToolCall(content, {
      toolCallId: 'bash-1',
      toolName: 'Bash',
      status: 'running',
      startTime: 3,
    });

    expect(getAgentTimeline(content)).toEqual([
      expect.objectContaining({ type: 'thinking', content: 'inspect' }),
      expect.objectContaining({ type: 'text', content: 'first explanation' }),
      expect.objectContaining({
        type: 'tool_group',
        toolCallIds: ['read-1', 'read-2'],
      }),
      expect.objectContaining({ type: 'text', content: 'second explanation' }),
      expect.objectContaining({ type: 'tool_group', toolCallIds: ['bash-1'] }),
    ]);
  });

  it('derives an ordered fallback for legacy agent content', () => {
    expect(
      getAgentTimeline({
        textBefore: 'before',
        toolCalls: [
          {
            toolCallId: 'legacy-tool',
            toolName: 'Read',
            status: 'success',
            startTime: 1,
          },
        ],
        textAfter: 'after',
        thinkingContent: 'thinking',
        tasks: [],
        subagent: null,
        confirmation: null,
        question: null,
      }).map((block) => block.type)
    ).toEqual(['thinking', 'text', 'tool_group', 'text']);
  });
});
