import { describe, expect, it } from 'vitest';
import {
  applyWorkspaceTransition,
  handleSubagentLifecycle,
  handleTaskListUpdate,
  type FunctionToolCallRef,
} from '../../../../src/agent/loop/toolDomainPolicy.js';
import type { ToolResult } from '../../../../src/tools/types/index.js';

function makeToolCall(name: string, args = '{}'): FunctionToolCallRef {
  return { id: 'tc1', type: 'function', function: { name, arguments: args } };
}

describe('toolDomainPolicy', () => {
  describe('applyWorkspaceTransition', () => {
    it('updates the chat workspace only for successful managed transitions', () => {
      const context = {
        messages: [],
        sessionId: 'session-1',
        userId: 'user-1',
        workspaceRoot: '/repo',
      };
      const result: ToolResult = {
        success: true,
        llmContent: 'entered',
        metadata: {
          workspaceTransition: 'enter',
          workspaceRoot: '/worktrees/feature',
        },
      };

      expect(
        applyWorkspaceTransition(makeToolCall('EnterWorktree'), result, context)
      ).toBe('/worktrees/feature');
      expect(context.workspaceRoot).toBe('/worktrees/feature');
    });

    it('ignores failed or unrelated tool results', () => {
      const context = {
        messages: [],
        sessionId: 'session-1',
        userId: 'user-1',
        workspaceRoot: '/repo',
      };
      const result: ToolResult = {
        success: false,
        llmContent: 'failed',
        metadata: {
          workspaceTransition: 'enter',
          workspaceRoot: '/worktrees/feature',
        },
      };

      expect(
        applyWorkspaceTransition(makeToolCall('EnterWorktree'), result, context)
      ).toBeUndefined();
      expect(context.workspaceRoot).toBe('/repo');
    });
  });

  describe('handleSubagentLifecycle', () => {
    it('returns null for non-Task tools', () => {
      const result: ToolResult = {
        success: true,
        llmContent: 'ok',
        metadata: { subagentSessionId: 's1', subagentStatus: 'completed' },
      };
      expect(handleSubagentLifecycle(makeToolCall('Read'), result)).toBeNull();
    });

    it('returns null when no subagentSessionId', () => {
      const result: ToolResult = { success: true, llmContent: 'ok', metadata: {} };
      expect(handleSubagentLifecycle(makeToolCall('Task'), result)).toBeNull();
    });

    it('returns subagent_completed for completed status', () => {
      const result: ToolResult = {
        success: true,
        llmContent: 'done',
        metadata: {
          subagentSessionId: 'sess-123',
          subagentType: 'Explore',
          subagentStatus: 'completed',
          subagentSummary: 'Found 3 files',
        },
      };
      const event = handleSubagentLifecycle(makeToolCall('Task'), result);
      expect(event).toEqual({
        kind: 'subagent_completed',
        sessionId: 'sess-123',
        success: true,
        summary: 'Found 3 files',
      });
    });

    it('returns subagent_completed with success=false for failed status', () => {
      const result: ToolResult = {
        success: false,
        llmContent: '',
        metadata: {
          subagentSessionId: 'sess-456',
          subagentType: 'Task',
          subagentStatus: 'failed',
        },
      };
      const event = handleSubagentLifecycle(makeToolCall('Task'), result);
      expect(event).toEqual({
        kind: 'subagent_completed',
        sessionId: 'sess-456',
        success: false,
        summary: undefined,
      });
    });

    it('returns subagent_spawned for running status', () => {
      const args = JSON.stringify({
        prompt: 'Search for utils',
        subagent_type: 'Explore',
      });
      const result: ToolResult = {
        success: true,
        llmContent: '',
        metadata: {
          subagentSessionId: 'sess-789',
          subagentType: 'Explore',
          subagentStatus: 'running',
        },
      };
      const event = handleSubagentLifecycle(makeToolCall('Task', args), result);
      expect(event).toEqual({
        kind: 'subagent_spawned',
        sessionId: 'sess-789',
        type: 'Explore',
        prompt: 'Search for utils',
      });
    });
  });

  describe('handleTaskListUpdate', () => {
    it('returns null for non-task tools', () => {
      const result: ToolResult = { success: true, llmContent: 'ok' };
      expect(handleTaskListUpdate(makeToolCall('Read'), result)).toBeNull();
    });

    it('returns task_update for TaskList results', () => {
      const tasks = [{ id: '1', title: 'Fix bug', status: 'pending' }];
      const result: ToolResult = {
        success: true,
        llmContent: { tasks },
        metadata: {},
      };
      const action = handleTaskListUpdate(makeToolCall('TaskList'), result);
      expect(action?.kind).toBe('task_update');
      expect(action?.tasks).toEqual(tasks);
    });
  });
});
