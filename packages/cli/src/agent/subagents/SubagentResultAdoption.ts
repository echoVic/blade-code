import type {
  SessionAdoptedToolResult,
  SessionInterruptedToolCall,
} from '../../context/storage/PersistentStore.js';
import type { JsonValue } from '../../store/types.js';
import { isVerificationAuditSubagent } from '../../utils/shell/readOnlyAudit.js';
import {
  type AgentSession,
  type AgentSessionOwner,
  isAgentSessionOwnedBy,
} from './AgentSessionStore.js';
import type { SubagentIsolationMode } from './SubagentWorktreeLifecycle.js';
import type { SubagentResult } from './types.js';

const MAX_ADOPTED_RESULT_CHARS = 1_000_000;
const MAX_ADOPTED_ERROR_CHARS = 100_000;
const MAX_ADOPTED_LIST_ITEMS = 10_000;

function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

export interface CanonicalSubagentTaskResult {
  success: boolean;
  llmContent: string;
  errorMessage?: string;
  metadata: Record<string, unknown>;
}

export interface CompletedSubagentTaskResultInput {
  result: SubagentResult;
  sessionId: string;
  subagentType: string;
  subagentSource?: string;
  description: string;
  isolation: SubagentIsolationMode;
  resumedFrom?: string;
  rootAgentId: string;
  resumeDepth: number;
}

function validStringList(value: unknown): value is string[] | undefined {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.length <= MAX_ADOPTED_LIST_ITEMS &&
      value.every((item) => typeof item === 'string'))
  );
}

function sessionResult(session: AgentSession): SubagentResult | undefined {
  const result = session.result;
  if (
    !result ||
    typeof result.success !== 'boolean' ||
    typeof result.message !== 'string' ||
    result.message.length > MAX_ADOPTED_RESULT_CHARS ||
    (result.error !== undefined &&
      (typeof result.error !== 'string' ||
        result.error.length > MAX_ADOPTED_ERROR_CHARS)) ||
    !validStringList(result.verificationCommands) ||
    !validStringList(result.modifiedFiles) ||
    (session.status === 'completed' && result.success !== true) ||
    (session.status === 'failed' && result.success !== false)
  ) {
    return undefined;
  }
  return {
    success: result.success,
    message: result.message,
    error: result.error,
    verificationCommands: result.verificationCommands,
    verificationVerdict: result.verificationVerdict,
    modifiedFiles: result.modifiedFiles,
    stats: session.stats,
    messages: session.messages,
    worktreePath: session.worktree?.worktreeRoot,
    worktreeBranch: session.worktree?.branch,
    worktree: session.worktree,
  };
}

export function buildCompletedSubagentTaskResult(
  input: CompletedSubagentTaskResultInput
): CanonicalSubagentTaskResult {
  const worktreeNote = input.result.worktreePath
    ? `\n\nWorktree preserved at ${input.result.worktreePath}${input.result.worktreeBranch ? ` on branch ${input.result.worktreeBranch}` : ''}.`
    : '';
  const resumeHint =
    `\n\nAgent ID: ${input.sessionId}\n` +
    `To continue this agent, call Task with resume_from="${input.sessionId}".`;
  const metadata = {
    summary: `${input.subagentType} 任务${input.result.success ? '完成' : '失败'}`,
    subagent_type: input.subagentType,
    description: input.description,
    stats: input.result.stats,
    subagentSessionId: input.sessionId,
    subagentType: input.subagentType,
    subagentStatus: input.result.success ? 'completed' : 'failed',
    subagentSummary: input.result.message.slice(0, 500),
    subagentResumedFrom: input.resumedFrom,
    subagentRootId: input.rootAgentId,
    subagentResumeDepth: input.resumeDepth,
    resume_from_hint: input.sessionId,
    resumed_from: input.resumedFrom,
    verificationCommands: input.result.verificationCommands,
    verificationVerdict: input.result.verificationVerdict,
    modifiedFiles: input.result.modifiedFiles,
    verificationAgentBuiltin:
      isVerificationAuditSubagent(input.subagentType) &&
      input.subagentSource === 'builtin',
    isolation: input.isolation,
    worktreePath: input.result.worktreePath,
    worktreeBranch: input.result.worktreeBranch,
  };
  if (input.result.success) {
    return {
      success: true,
      llmContent: `${input.result.message}${worktreeNote}${resumeHint}`,
      metadata,
    };
  }
  const errorMessage = input.result.error || 'Unknown error';
  return {
    success: false,
    llmContent: `Subagent execution failed: ${errorMessage}.${worktreeNote}${resumeHint}`,
    errorMessage,
    metadata,
  };
}

export function buildSubagentResultAdoption(
  call: SessionInterruptedToolCall,
  session: AgentSession,
  owner: AgentSessionOwner
): SessionAdoptedToolResult | undefined {
  if (
    call.toolName !== 'Task' ||
    !call.input ||
    typeof call.input !== 'object' ||
    Array.isArray(call.input) ||
    !isAgentSessionOwnedBy(session, owner) ||
    (session.status !== 'completed' && session.status !== 'failed')
  ) {
    return undefined;
  }
  const params = call.input as Record<string, unknown>;
  if (
    params.subagent_session_id !== session.id ||
    params.description !== session.description ||
    (typeof params.subagent_type === 'string' &&
      params.subagent_type !== session.subagentType)
  ) {
    return undefined;
  }
  const resumeFrom = params.resume_from ?? params.resume;
  if (
    (params.resume_from !== undefined &&
      params.resume !== undefined &&
      params.resume_from !== params.resume) ||
    (resumeFrom === undefined && session.resumedFrom !== undefined) ||
    (resumeFrom !== undefined &&
      (typeof resumeFrom !== 'string' || resumeFrom !== session.resumedFrom))
  ) {
    return undefined;
  }
  const result = sessionResult(session);
  if (!result) return undefined;

  const canonical = buildCompletedSubagentTaskResult({
    result,
    sessionId: session.id,
    subagentType: session.subagentType,
    subagentSource: session.configSnapshot?.source,
    description: session.description,
    isolation: session.isolation ?? 'none',
    resumedFrom: session.resumedFrom,
    rootAgentId: session.rootAgentId,
    resumeDepth: session.resumeDepth,
  });
  const metadata = {
    ...canonical.metadata,
    processRestartRecovery: true,
    subagentResultAdopted: true,
    sideEffectsUncertain: false,
  };
  return {
    toolCallId: call.toolCallId,
    toolName: call.toolName,
    output: canonical.success ? toJsonValue(canonical.llmContent) : null,
    error: canonical.errorMessage,
    metadata: toJsonValue(metadata),
    subagentRef: {
      subagentSessionId: session.id,
      subagentType: session.subagentType,
      subagentDescription: session.description,
      subagentStatus: canonical.success ? 'completed' : 'failed',
      subagentSummary: result.message.slice(0, 500),
      subagentResumedFrom: session.resumedFrom,
      subagentRootId: session.rootAgentId,
      subagentResumeDepth: session.resumeDepth,
      verificationVerdict: result.verificationVerdict,
    },
  };
}
