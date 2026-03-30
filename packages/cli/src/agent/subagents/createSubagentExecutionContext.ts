import { PermissionMode } from '../../config/types.js';
import { Bus } from '../../server/bus.js';
import { vanillaStore } from '../../store/vanilla.js';
import type { SubagentContext } from './types.js';

export interface CreateSubagentExecutionContextParams {
  parentSessionId?: string;
  permissionMode?: PermissionMode;
  subagentSessionId: string;
  prompt: string;
}

export function createSubagentExecutionContext({
  parentSessionId,
  permissionMode,
  subagentSessionId,
  prompt,
}: CreateSubagentExecutionContextParams): SubagentContext {
  return {
    prompt,
    parentSessionId,
    permissionMode,
    subagentSessionId,
    onToolStart: (toolCall, toolKind) => {
      const toolName =
        toolCall.type === 'function' ? toolCall.function.name : 'Unknown';
      vanillaStore.getState().app.actions.updateSubagentTool(toolName);
      if (parentSessionId) {
        Bus.publish(parentSessionId, 'subagent.update', {
          subagentSessionId,
          toolName,
        });
        if (toolCall.type === 'function') {
          Bus.publish(parentSessionId, 'subagent.tool.start', {
            subagentSessionId,
            toolCallId: toolCall.id,
            toolName,
            arguments: toolCall.function.arguments,
            toolKind,
          });
        }
      }
    },
    onToolResult: (toolCall, result) => {
      if (!parentSessionId) return;
      if (toolCall.type !== 'function') return;
      Bus.publish(parentSessionId, 'subagent.tool.result', {
        subagentSessionId,
        toolCallId: toolCall.id,
        toolName: toolCall.function.name,
        success: !result.error,
        summary: result.metadata?.summary,
        output: result.displayContent,
        metadata: result.metadata,
      });
    },
    onContentDelta: (delta) => {
      if (parentSessionId) {
        Bus.publish(parentSessionId, 'subagent.delta', {
          subagentSessionId,
          delta,
        });
      }
    },
    onThinkingDelta: (delta) => {
      if (parentSessionId) {
        Bus.publish(parentSessionId, 'subagent.thinking.delta', {
          subagentSessionId,
          delta,
        });
      }
    },
    onStreamEnd: () => {
      if (parentSessionId) {
        Bus.publish(parentSessionId, 'subagent.stream.end', {
          subagentSessionId,
        });
      }
    },
  };
}
