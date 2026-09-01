import type { AcpRemotePathStyle } from '../../acp/AcpRemotePath.js';
import { parseAcpRemoteWorkspaceDescriptor } from '../../acp/AcpRemoteWorkspace.js';
import type { SessionWorkspace } from '../../agent/runtime/SessionWorkspace.js';
import {
  type ExecutionContext,
  ToolErrorType,
  type ToolResult,
} from '../types/index.js';

const executionWorkspacePolicySymbol = Symbol('executionWorkspacePolicy');
const runtimeWorkspacePolicies = new WeakSet<object>();

export type WorkspaceToolPolicy =
  | { readonly kind: 'local' }
  | (Pick<
      Extract<SessionWorkspace, { kind: 'acp-remote' }>,
      'kind' | 'readTextFile' | 'writeTextFile' | 'terminal'
    > & { readonly pathStyle: AcpRemotePathStyle });

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
  if (workspace.kind === 'local') {
    const policy = freezeWorkspaceToolPolicy({ kind: 'local' });
    runtimeWorkspacePolicies.add(policy);
    return policy;
  }
  const descriptor = parseAcpRemoteWorkspaceDescriptor(workspace.descriptor);
  const policy = freezeWorkspaceToolPolicy({
    kind: 'acp-remote' as const,
    readTextFile: workspace.readTextFile,
    writeTextFile: workspace.writeTextFile,
    terminal: workspace.terminal,
    pathStyle: descriptor.style,
  });
  runtimeWorkspacePolicies.add(policy);
  return policy;
}

export function freezeWorkspaceToolPolicy(
  policy: WorkspaceToolPolicy
): WorkspaceToolPolicy {
  const frozen = Object.freeze({ ...policy });
  if (runtimeWorkspacePolicies.has(policy)) {
    runtimeWorkspacePolicies.add(frozen);
  }
  return frozen;
}

export function bindExecutionWorkspaceToolPolicy(
  context: ExecutionContext,
  policy: WorkspaceToolPolicy | undefined
): ExecutionContext {
  if (!policy || !runtimeWorkspacePolicies.has(policy)) return context;
  return Object.assign(context, { [executionWorkspacePolicySymbol]: policy });
}

export function getExecutionWorkspaceToolPolicy(
  context: ExecutionContext
): WorkspaceToolPolicy | undefined {
  const candidate = (
    context as ExecutionContext & {
      [executionWorkspacePolicySymbol]?: WorkspaceToolPolicy;
    }
  )[executionWorkspacePolicySymbol];
  return candidate && runtimeWorkspacePolicies.has(candidate) ? candidate : undefined;
}

export function isRuntimeWorkspaceToolPolicy(
  policy: WorkspaceToolPolicy | undefined
): boolean {
  return policy !== undefined && runtimeWorkspacePolicies.has(policy);
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
