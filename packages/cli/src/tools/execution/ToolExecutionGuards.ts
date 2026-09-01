import { PathSecurity } from '../../utils/pathSecurity.js';
import type {
  ExecutionContext,
  Tool,
  ToolInvocation,
  ToolResult,
} from '../types/index.js';
import { ToolErrorType, ToolKind } from '../types/index.js';
import { createRejectedResult } from './ToolExecutionResults.js';

export interface ValidatedToolCall {
  invocation: ToolInvocation<unknown>;
  params: Record<string, unknown>;
}

export function validateToolCall(
  tool: Tool,
  params: Record<string, unknown>,
  toolWhitelist: ReadonlySet<string> | null,
  toolBlacklist: ReadonlySet<string> | null
): ValidatedToolCall | ToolResult {
  if (toolBlacklist?.has(tool.name)) {
    return createRejectedResult(`Tool "${tool.name}" is blocked by --disallowed-tools`);
  }
  if (toolWhitelist && !toolWhitelist.has(tool.name)) {
    return createRejectedResult(
      `Tool "${tool.name}" is not in --allowed-tools whitelist`
    );
  }

  try {
    const invocation = tool.build(params);
    const validatedParams = invocation.params;
    if (
      typeof validatedParams !== 'object' ||
      validatedParams === null ||
      Array.isArray(validatedParams)
    ) {
      throw new Error('Tool parameters must be an object');
    }
    return {
      invocation,
      params: validatedParams as Record<string, unknown>,
    };
  } catch (error) {
    return createRejectedResult(
      `Parameter validation failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { errorType: ToolErrorType.VALIDATION_ERROR }
    );
  }
}

export async function enforceWorktreeIsolation(
  tool: Tool,
  params: Record<string, unknown>,
  context: ExecutionContext,
  invocation?: ToolInvocation<unknown>
): Promise<ToolResult | undefined> {
  if (context.worktreeActive) {
    return enforceActiveWorktreeBoundary(tool, params, context, invocation);
  }

  const isolatedTask = tool.name === 'Task' && params.isolation === 'worktree';
  if (
    !context.worktreeIsolationRequired ||
    tool.name === 'EnterWorktree' ||
    isolatedTask ||
    (tool.kind === ToolKind.ReadOnly && tool.name !== 'Task')
  ) {
    return undefined;
  }

  return createRejectedResult(
    'Blocked side-effecting tool outside the explicitly required worktree',
    {
      llmContent:
        'Worktree isolation is required. Call EnterWorktree and wait for it ' +
        'to succeed before using any write or execute tool.',
      summary: 'Blocked until EnterWorktree succeeds',
      errorType: ToolErrorType.PERMISSION_DENIED,
    }
  );
}

async function enforceActiveWorktreeBoundary(
  tool: Tool,
  params: Record<string, unknown>,
  context: ExecutionContext,
  invocation?: ToolInvocation<unknown>
): Promise<ToolResult | undefined> {
  const pathKeys =
    tool.kind === ToolKind.Write
      ? (['file_path', 'notebook_path', 'path'] as const)
      : tool.name === 'Bash'
        ? (['cwd'] as const)
        : [];
  const targets = [
    ...pathKeys
      .map((key) => params[key])
      .filter((value): value is string => typeof value === 'string'),
    ...(invocation?.getAffectedPaths() ?? []),
  ];

  if (targets.length === 0) {
    return undefined;
  }

  const workspaceRoot = context.workspaceRoot;
  if (!workspaceRoot) {
    return outsideWorktreeResult(targets[0], 'workspace root is missing');
  }

  for (const target of targets) {
    if (!(await PathSecurity.isWithinWorkspaceResolved(target, workspaceRoot))) {
      return outsideWorktreeResult(target);
    }
  }

  return undefined;
}

function outsideWorktreeResult(target: string, detail?: string): ToolResult {
  const suffix = detail ? ` (${detail})` : '';
  return createRejectedResult(
    `Blocked path outside the active worktree: ${target}${suffix}`,
    {
      llmContent:
        `The requested path "${target}" is outside the active worktree. ` +
        'Use a path under the current workspace root.',
      summary: 'Blocked path outside active worktree',
      errorType: ToolErrorType.PERMISSION_DENIED,
    }
  );
}
