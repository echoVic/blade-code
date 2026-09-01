import { nanoid } from 'nanoid';
import { PermissionMode } from '../../config/types.js';
import { HookManager } from '../../hooks/HookManager.js';
import { getCwd } from '../../utils/cwd.js';
import type {
  ExecutionContext,
  PermissionDecision,
  Tool,
  ToolInvocation,
  ToolResult,
} from '../types/index.js';
import { ToolErrorType } from '../types/index.js';
import { createRejectedResult } from './ToolExecutionResults.js';

export interface PreToolUseResult {
  params: Record<string, unknown>;
  invocation: ToolInvocation<unknown>;
  decision?: PermissionDecision;
  toolUseId?: string;
  inputModified: boolean;
  rejection?: ToolResult;
}

export async function runPreToolUseHooks<TParams>(
  tool: Tool<TParams>,
  params: Record<string, unknown>,
  invocation: ToolInvocation<unknown>,
  context: ExecutionContext,
  ruleDecision: PermissionDecision,
  hookManager: HookManager = HookManager.getInstance()
): Promise<PreToolUseResult> {
  const unchanged: PreToolUseResult = {
    params,
    invocation,
    inputModified: false,
  };
  if (context.workspaceKind === 'acp-remote') {
    return unchanged;
  }
  const projectDir = context.workspaceRoot || getCwd();
  const sessionId = context.sessionId || 'unknown';
  if (
    !hookManager.isEnabled(projectDir, sessionId) ||
    ruleDecision.behavior === 'deny'
  ) {
    return unchanged;
  }

  try {
    const toolUseId = context.messageId || `tool_${nanoid()}`;
    const result = await hookManager.executePreToolHooks(tool.name, toolUseId, params, {
      projectDir,
      sessionId,
      permissionMode: context.permissionMode ?? PermissionMode.DEFAULT,
      abortSignal: context.signal,
    });

    if (result.warning) {
      console.warn(`[Hook Warning] ${result.warning}`);
    }

    const decision: PermissionDecision = {
      behavior: result.decision,
      source: 'hook',
      reason: result.reason,
    };
    if (!result.modifiedInput || result.decision === 'deny') {
      return {
        ...unchanged,
        decision,
        toolUseId,
      };
    }

    const modifiedParams = {
      ...params,
      ...result.modifiedInput,
    };

    try {
      return {
        params: modifiedParams,
        invocation: tool.build(modifiedParams as TParams),
        decision,
        toolUseId,
        inputModified: true,
      };
    } catch (error) {
      return {
        ...unchanged,
        decision,
        toolUseId,
        rejection: createRejectedResult(
          `Hook modified parameters are invalid: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { errorType: ToolErrorType.VALIDATION_ERROR }
        ),
      };
    }
  } catch (error) {
    console.error('[ToolExecutionHooks] Error executing pre-tool hooks:', error);
    return unchanged;
  }
}

export async function runPostToolUseHooks<TParams>(
  tool: Tool<TParams>,
  params: Record<string, unknown>,
  result: ToolResult,
  context: ExecutionContext,
  toolUseId?: string,
  hookManager: HookManager = HookManager.getInstance()
): Promise<void> {
  if (context.workspaceKind === 'acp-remote') {
    return;
  }
  const projectDir = context.workspaceRoot || getCwd();
  const sessionId = context.sessionId || 'unknown';
  if (!hookManager.isEnabled(projectDir, sessionId)) {
    return;
  }

  try {
    const resolvedToolUseId = toolUseId || context.messageId || `tool_${nanoid()}`;
    const hookResult = await hookManager.executePostToolHooks(
      tool.name,
      resolvedToolUseId,
      params,
      result,
      {
        projectDir,
        sessionId,
        permissionMode: context.permissionMode ?? PermissionMode.DEFAULT,
        abortSignal: context.signal,
      }
    );

    if (hookResult.additionalContext) {
      const currentContent =
        typeof result.llmContent === 'string'
          ? result.llmContent
          : result.llmContent
            ? JSON.stringify(result.llmContent)
            : '';
      result.llmContent =
        `${currentContent}\n\n---\n**Hook Context:**\n` + hookResult.additionalContext;
    }

    if (isRecord(hookResult.modifiedOutput)) {
      Object.assign(result, hookResult.modifiedOutput);
    }

    if (hookResult.warning) {
      console.warn(`[PostToolUseHook Warning] ${hookResult.warning}`);
    }
  } catch (error) {
    console.error('[ToolExecutionHooks] Error executing post-tool hooks:', error);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
