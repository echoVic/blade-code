import path from 'node:path';
import type { Message } from '../../services/ChatServiceInterface.js';
import type { ToolResult } from '../../tools/types/index.js';
import { VERIFICATION_SUBAGENT_TYPE } from '../../utils/shell/readOnlyAudit.js';
import { isReadOnlyBashCommand } from '../../utils/shell/readOnlyValidation.js';
import { isVerificationCommand } from '../../utils/shell/verificationCommand.js';

export { VERIFICATION_SUBAGENT_TYPE };
export const BASH_MUTATION_MARKER = '<bash-mutation>';
export const MAX_INDEPENDENT_VERIFICATION_RETRIES = 3;

export type VerificationVerdict = 'pass' | 'fail' | 'partial';

const VERDICT_PATTERN = /^##\s+Verification Result:\s*(PASS|FAIL|PARTIAL)\s*$/gim;
const NON_IMPLEMENTATION_PATH_PATTERN =
  /(?:^|\/)(?:docs?|tests?|__tests__|fixtures?|examples?|snapshots?)(?:\/|$)/i;
const NON_IMPLEMENTATION_EXTENSION_PATTERN = /\.(?:md|mdx|txt|snap)$/i;
const HIGH_RISK_PATH_PATTERN =
  /(?:^|\/)(?:api|server|backend|infra|infrastructure|auth|security|migrations?|database|workflows?)(?:\/|$)/i;
const HIGH_RISK_FILE_PATTERN =
  /(?:^|\/)(?:Dockerfile|docker-compose(?:\.[^/]+)?|wrangler\.(?:jsonc?|toml)|[^/]+\.tf)$/i;

export interface IndependentVerificationGateInput {
  enabled: boolean;
  isSubagent: boolean;
  taskAvailable: boolean;
  delegationForbidden: boolean;
  singleTaskDelegationRequired: boolean;
  modifiedFiles: ReadonlySet<string>;
  mutationRevision: number;
  verificationRevision: number;
  verificationVerdict?: VerificationVerdict;
  retryCount: number;
}

export interface IndependentVerificationEvidence {
  modifiedFiles?: string[];
  verificationAttempted?: boolean;
  verificationVerdict?: VerificationVerdict;
  verificationAgentBuiltin?: boolean;
}

export interface IndependentVerificationState {
  modifiedFiles: Set<string>;
  mutationRevision: number;
  verificationRevision: number;
  verificationVerdict?: VerificationVerdict;
}

export type IndependentVerificationGateAction =
  | { action: 'none' }
  | {
      action: 'retry';
      prompt: string;
      requireVerificationTask: boolean;
    }
  | { action: 'fail'; message: string };

function normalizeFilePath(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().replaceAll('\\', '/');
  if (!normalized) return undefined;
  return path.posix.normalize(normalized);
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(normalizeFilePath)
    .filter((entry): entry is string => entry !== undefined);
}

export function parseVerificationVerdict(
  message: string | undefined
): VerificationVerdict | undefined {
  if (!message) return undefined;
  const matches = [...message.matchAll(VERDICT_PATTERN)].map((match) =>
    match[1]?.toLowerCase()
  );
  return matches.length === 1 ? (matches[0] as VerificationVerdict) : undefined;
}

export function collectModifiedFiles(
  toolName: string,
  result: ToolResult,
  workspaceRoot?: string
): string[] {
  if (!result.success) return [];
  const metadata = result.metadata;
  if (!metadata || typeof metadata !== 'object') return [];

  if (toolName === 'Edit' || toolName === 'Write') {
    const filePath = normalizeFilePath(metadata.file_path);
    return filePath ? [filePath] : [];
  }

  if (toolName === 'ApplyPatch') {
    const affected = stringArray(metadata.affected_paths);
    if (affected.length > 0) return affected;
    if (!Array.isArray(metadata.changes)) return [];
    return metadata.changes
      .map((change) =>
        change && typeof change === 'object' && 'path' in change
          ? normalizeFilePath(change.path)
          : undefined
      )
      .filter((entry): entry is string => entry !== undefined);
  }

  if (toolName === 'NotebookEdit') {
    const notebookPath = normalizeFilePath(metadata.notebook_path);
    return notebookPath ? [notebookPath] : [];
  }

  if (toolName === 'Task' || toolName === 'TaskOutput') {
    return stringArray(metadata.modifiedFiles ?? metadata.modified_files);
  }

  if (toolName === 'Bash' && typeof metadata.command === 'string') {
    const command = metadata.command;
    if (
      !isVerificationCommand(command, workspaceRoot) &&
      !isReadOnlyBashCommand(command)
    ) {
      return [BASH_MUTATION_MARKER];
    }
  }

  return [];
}

export function recordModifiedFiles(
  modifiedFiles: Set<string>,
  toolName: string,
  result: ToolResult,
  workspaceRoot?: string
): string[] {
  const recorded = collectModifiedFiles(toolName, result, workspaceRoot);
  for (const filePath of recorded) modifiedFiles.add(filePath);
  return recorded;
}

export function restoreIndependentVerificationState(
  messages: readonly Message[]
): IndependentVerificationState {
  const state: IndependentVerificationState = {
    modifiedFiles: new Set<string>(),
    mutationRevision: 0,
    verificationRevision: -1,
  };

  for (const message of messages) {
    if (message.role !== 'tool' || !message.metadata) continue;
    const metadata = message.metadata;
    if (typeof metadata !== 'object' || Array.isArray(metadata) || metadata === null) {
      continue;
    }
    const durableToolMetadata =
      metadata.metadata &&
      typeof metadata.metadata === 'object' &&
      !Array.isArray(metadata.metadata)
        ? metadata.metadata
        : undefined;
    const directEvidence = metadata.independentVerification;
    const evidence =
      directEvidence &&
      typeof directEvidence === 'object' &&
      !Array.isArray(directEvidence)
        ? directEvidence
        : durableToolMetadata
          ? {
              modifiedFiles: collectModifiedFiles(
                typeof metadata.toolName === 'string'
                  ? metadata.toolName
                  : (message.name ?? ''),
                {
                  success: typeof metadata.error !== 'string',
                  llmContent: message.content,
                  metadata: durableToolMetadata,
                }
              ),
              verificationAttempted:
                (metadata.toolName === 'Task' || message.name === 'Task') &&
                durableToolMetadata.verificationAgentBuiltin === true &&
                (durableToolMetadata.subagentStatus === 'completed' ||
                  durableToolMetadata.status === 'completed'),
              verificationAgentBuiltin:
                durableToolMetadata.verificationAgentBuiltin === true,
              verificationVerdict:
                durableToolMetadata.verificationVerdict === 'pass' ||
                durableToolMetadata.verificationVerdict === 'fail' ||
                durableToolMetadata.verificationVerdict === 'partial'
                  ? durableToolMetadata.verificationVerdict
                  : undefined,
            }
          : undefined;
    if (typeof evidence !== 'object' || Array.isArray(evidence) || evidence === null) {
      continue;
    }

    const modified = stringArray(evidence.modifiedFiles);
    if (modified.length > 0) {
      for (const filePath of modified) state.modifiedFiles.add(filePath);
      state.mutationRevision++;
      state.verificationRevision = -1;
      state.verificationVerdict = undefined;
    }

    if (
      evidence.verificationAttempted === true &&
      evidence.verificationAgentBuiltin === true
    ) {
      state.verificationRevision = state.mutationRevision;
      state.verificationVerdict =
        evidence.verificationVerdict === 'pass' ||
        evidence.verificationVerdict === 'fail' ||
        evidence.verificationVerdict === 'partial'
          ? evidence.verificationVerdict
          : undefined;
    }
  }

  return state;
}

export function requiresIndependentVerification(
  modifiedFiles: ReadonlySet<string>
): boolean {
  if (modifiedFiles.has(BASH_MUTATION_MARKER)) return true;
  const implementationFiles = [...modifiedFiles].filter(
    (filePath) =>
      !NON_IMPLEMENTATION_PATH_PATTERN.test(filePath) &&
      !NON_IMPLEMENTATION_EXTENSION_PATTERN.test(filePath)
  );
  return (
    implementationFiles.length >= 3 ||
    implementationFiles.some(
      (filePath) =>
        HIGH_RISK_PATH_PATTERN.test(filePath) || HIGH_RISK_FILE_PATTERN.test(filePath)
    )
  );
}

export function checkIndependentVerificationGate(
  input: IndependentVerificationGateInput
): IndependentVerificationGateAction {
  if (
    !input.enabled ||
    input.isSubagent ||
    !input.taskAvailable ||
    input.delegationForbidden ||
    input.singleTaskDelegationRequired ||
    !requiresIndependentVerification(input.modifiedFiles)
  ) {
    return { action: 'none' };
  }

  if (
    input.verificationRevision === input.mutationRevision &&
    input.verificationVerdict === 'pass'
  ) {
    return { action: 'none' };
  }

  if (input.retryCount >= MAX_INDEPENDENT_VERIFICATION_RETRIES) {
    return {
      action: 'fail',
      message:
        'Independent verification did not produce a fresh PASS before the retry limit.',
    };
  }

  if (input.verificationRevision === input.mutationRevision) {
    if (input.verificationVerdict === 'fail') {
      return {
        action: 'retry',
        requireVerificationTask: false,
        prompt:
          'The independent verification agent returned FAIL. Fix every reported ' +
          'failure with tool calls, then run a fresh verification agent. Do not ' +
          'finish or claim success before the new verdict is PASS.',
      };
    }
    if (input.verificationVerdict === 'partial') {
      return {
        action: 'retry',
        requireVerificationTask: false,
        prompt:
          'The independent verification agent returned PARTIAL. Resolve the ' +
          'reported medium-risk findings with tool calls, then run a fresh ' +
          'verification agent. Do not finish before the new verdict is PASS.',
      };
    }
    return {
      action: 'retry',
      requireVerificationTask: true,
      prompt:
        'The verification agent did not return exactly one structured ' +
        '"## Verification Result: PASS | FAIL | PARTIAL" verdict. Run Task again ' +
        'with subagent_type="verification" and run_in_background=false. Require ' +
        'tool-backed evidence and the exact final verdict heading.',
    };
  }

  const changedFiles = [...input.modifiedFiles]
    .filter((filePath) => filePath !== BASH_MUTATION_MARKER)
    .slice(0, 20)
    .join(', ');
  return {
    action: 'retry',
    requireVerificationTask: true,
    prompt:
      'This turn made a non-trivial implementation. Before finishing, call Task ' +
      'with subagent_type="verification", run_in_background=false, and ' +
      'isolation="none". Give it the original request, implementation approach, ' +
      `and changed files${changedFiles ? `: ${changedFiles}` : ''}. Do not give ` +
      'the verifier your test results or a claimed outcome. Do not ask it to ' +
      'skip any project check; the runtime replaces the verifier prompt with ' +
      'an authoritative scope. Only a fresh structured PASS verdict allows completion.',
  };
}
