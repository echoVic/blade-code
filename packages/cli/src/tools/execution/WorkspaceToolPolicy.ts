import type { SessionWorkspace } from '../../agent/runtime/SessionWorkspace.js';
import { ToolErrorType, type ToolResult } from '../types/index.js';

export type WorkspaceToolPolicy =
  | { readonly kind: 'local' }
  | Pick<
      Extract<SessionWorkspace, { kind: 'acp-remote' }>,
      'kind' | 'readTextFile' | 'writeTextFile' | 'terminal'
    >;

export type WorkspaceToolPolicyReason =
  | 'host-only'
  | 'read-required'
  | 'read-write-required'
  | 'terminal-required';

export type WorkspaceToolPolicyDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: WorkspaceToolPolicyReason };

const REMOTE_ALWAYS_ALLOWED_BUILTINS = new Set([
  'WebFetch',
  'WebSearch',
  'AskUserQuestion',
  'ToolSearch',
  'ReadPromptArtifact',
  'EnterPlanMode',
  'ExitPlanMode',
  'GetGoal',
  'CreateGoal',
  'UpdateGoal',
  'TaskCreate',
  'TaskGet',
  'TaskUpdate',
  'TaskList',
  'BrowserNavigate',
  'BrowserSnapshot',
  'BrowserInteract',
  'BrowserWait',
  'BrowserInspect',
  'BrowserPage',
  'ListMcpResources',
  'ListMcpResourceTemplates',
  'ReadMcpResource',
  'ListMcpPrompts',
  'GetMcpPrompt',
  'CompleteMcpArgument',
  'ManageMcpResourceSubscription',
  'StartMcpTask',
  'ListMcpTasks',
  'CancelMcpTask',
]);

export function createWorkspaceToolPolicy(
  workspace: SessionWorkspace
): WorkspaceToolPolicy {
  return workspace.kind === 'acp-remote'
    ? Object.freeze({
        kind: 'acp-remote' as const,
        readTextFile: workspace.readTextFile,
        writeTextFile: workspace.writeTextFile,
        terminal: workspace.terminal,
      })
    : Object.freeze({ kind: 'local' as const });
}

export function freezeWorkspaceToolPolicy(
  policy: WorkspaceToolPolicy
): WorkspaceToolPolicy {
  return Object.freeze({ ...policy });
}

export function evaluateBuiltinToolAccess(
  policy: WorkspaceToolPolicy,
  toolName: string
): WorkspaceToolPolicyDecision {
  if (policy.kind === 'local') return { allowed: true };
  if (toolName === 'Read') {
    return policy.readTextFile
      ? { allowed: true }
      : { allowed: false, reason: 'read-required' };
  }
  if (toolName === 'Write' || toolName === 'Edit' || toolName === 'ApplyPatch') {
    return policy.readTextFile && policy.writeTextFile
      ? { allowed: true }
      : { allowed: false, reason: 'read-write-required' };
  }
  if (toolName === 'Bash') {
    return policy.terminal
      ? { allowed: true }
      : { allowed: false, reason: 'terminal-required' };
  }
  return REMOTE_ALWAYS_ALLOWED_BUILTINS.has(toolName)
    ? { allowed: true }
    : { allowed: false, reason: 'host-only' };
}

export function createRemoteToolUnavailableResult(
  reason: WorkspaceToolPolicyReason
): ToolResult {
  return {
    success: false,
    llmContent: 'ACP remote tool capability is unavailable',
    error: {
      type: ToolErrorType.VALIDATION_ERROR,
      code: 'acp_remote_tool_unavailable',
      message: 'ACP remote tool capability is unavailable',
      details: { reason },
    },
    metadata: { summary: 'ACP remote tool capability is unavailable' },
  };
}

export function filterBuiltinToolsForWorkspace<T extends { readonly name: string }>(
  tools: readonly T[],
  policy: WorkspaceToolPolicy
): T[] {
  return tools.filter((tool) => evaluateBuiltinToolAccess(policy, tool.name).allowed);
}
