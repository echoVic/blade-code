import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PermissionMode } from '../../../../src/config/types.js';

const mockState = vi.hoisted(() => ({
  publish: vi.fn(),
  updateSubagentTool: vi.fn(),
}));

vi.mock('../../../../src/server/bus.js', () => ({
  Bus: {
    publish: mockState.publish,
  },
}));

vi.mock('../../../../src/store/vanilla.js', () => ({
  vanillaStore: {
    getState: () => ({
      app: {
        actions: {
          updateSubagentTool: mockState.updateSubagentTool,
        },
      },
    }),
  },
}));

import { createSubagentExecutionContext } from '../../../../src/agent/subagents/createSubagentExecutionContext.js';

describe('createSubagentExecutionContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('builds subagent context that emits events with consistent session metadata', () => {
    const context = createSubagentExecutionContext({
      parentSessionId: 'parent-session',
      permissionMode: PermissionMode.AUTO_EDIT,
      subagentSessionId: 'subagent-session',
      prompt: 'inspect the repo',
    });

    expect(context.prompt).toBe('inspect the repo');
    expect(context.permissionMode).toBe(PermissionMode.AUTO_EDIT);
    expect(context.subagentSessionId).toBe('subagent-session');

    context.onToolStart?.(
      {
        id: 'tool-1',
        type: 'function',
        function: {
          name: 'Read',
          arguments: '{"file":"a.ts"}',
        },
      },
      'readonly'
    );

    context.onToolResult?.(
      {
        id: 'tool-1',
        type: 'function',
        function: {
          name: 'Read',
          arguments: '{}',
        },
      },
      {
        success: true,
        llmContent: 'ok',
        displayContent: 'ok',
        metadata: { summary: 'done' },
      }
    );

    context.onContentDelta?.('partial');
    context.onThinkingDelta?.('reasoning');
    context.onStreamEnd?.();

    expect(mockState.updateSubagentTool).toHaveBeenCalledWith('Read');
    expect(mockState.publish).toHaveBeenCalledWith(
      'parent-session',
      'subagent.update',
      expect.objectContaining({
        subagentSessionId: 'subagent-session',
        toolName: 'Read',
      })
    );
    expect(mockState.publish).toHaveBeenCalledWith(
      'parent-session',
      'subagent.tool.start',
      expect.objectContaining({
        subagentSessionId: 'subagent-session',
        toolCallId: 'tool-1',
        toolName: 'Read',
      })
    );
    expect(mockState.publish).toHaveBeenCalledWith(
      'parent-session',
      'subagent.tool.result',
      expect.objectContaining({
        subagentSessionId: 'subagent-session',
        toolCallId: 'tool-1',
        toolName: 'Read',
        summary: 'done',
      })
    );
    expect(mockState.publish).toHaveBeenCalledWith(
      'parent-session',
      'subagent.delta',
      {
        subagentSessionId: 'subagent-session',
        delta: 'partial',
      }
    );
    expect(mockState.publish).toHaveBeenCalledWith(
      'parent-session',
      'subagent.thinking.delta',
      {
        subagentSessionId: 'subagent-session',
        delta: 'reasoning',
      }
    );
    expect(mockState.publish).toHaveBeenCalledWith(
      'parent-session',
      'subagent.stream.end',
      {
        subagentSessionId: 'subagent-session',
      }
    );
  });
});
