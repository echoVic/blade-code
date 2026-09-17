import { LRUCache } from 'lru-cache';
import type { PendingResumeFailureEvidence } from '../../agent/runtime/PendingResumeRecoveryPolicy.js';
import type { TaskAdmissionHandle } from '../../agent/runtime/TaskRunScheduler.js';
import type {
  CommunicationStyleSelection,
  PermissionMode,
  ReasoningEffortSelection,
  ResponseVerbositySelection,
  ServiceTierSelection,
} from '../../config/types.js';
import type {
  SessionTaskDelivery,
  SessionTaskKind,
  SessionTaskPriority,
  SessionTaskRetryRef,
  SessionTaskWorktree,
} from '../../context/types.js';
import type { SessionMetadata } from '../../services/SessionService.js';
import { SessionService } from '../../services/SessionService.js';
import {
  CONFIRMATION_ABORTED_REASON,
  type ConfirmationDetails,
  type ConfirmationResponse,
} from '../../tools/types/ExecutionTypes.js';
import { Bus } from '../bus.js';
import type { SessionProjectionLease } from '../SessionProjectionResidency.js';
import type { SessionRef } from '../sessionRef.js';

export interface WebPendingResumeAttempt {
  attempt: number;
  deadlineAt: number;
  generation: number;
  projectedInputIds: Set<string>;
}

export interface SessionInfo {
  id: string;
  projectPath: string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
  rootId: string;
  parentId?: string;
  messageCount: number;
  currentRunId?: string;
  relationType?: 'subagent' | 'fork';
  taskStatus: SessionMetadata['taskStatus'];
  taskStatusReason?: string;
  taskFailure?: SessionMetadata['taskFailure'];
  taskStartedAt?: string;
  taskCompletedAt?: string;
  taskPromptSummary?: string;
  taskPriority?: SessionTaskPriority;
  taskKind?: SessionTaskKind;
  taskDueAt?: string;
  taskModelId?: string;
  selectedModelId?: string;
  permissionMode?: PermissionMode;
  reasoningEffort?: ReasoningEffortSelection;
  serviceTier?: ServiceTierSelection;
  responseVerbosity?: ResponseVerbositySelection;
  communicationStyle?: CommunicationStyleSelection;
  communicationStyleDigest?: string;
  projectInstructionsDigest?: string;
  pendingInteraction?: SessionMetadata['pendingInteraction'];
  taskRetryAvailable?: boolean;
  taskRetriedFrom?: SessionTaskRetryRef;
  taskDelivery?: SessionTaskDelivery;
  taskIsolation?: SessionMetadata['taskIsolation'];
  taskSourceProjectPath?: string;
  taskWorktreePath?: string;
  taskWorktreeBranch?: string;
  taskBaseCommit?: string;
  taskDiffStat?: SessionMetadata['taskDiffStat'];
  taskQueuePosition?: number;
  taskQueueDepth?: number;
  taskConcurrencyLimit?: number;
  archivedAt?: string;
  archivedBySessionId?: string;
  taskWorktree?: SessionTaskWorktree;
}

export interface RunState {
  id: string;
  sessionId: string;
  projectPath: string;
  status:
    | 'queued'
    | 'running'
    | 'waiting_permission'
    | 'attention_required'
    | 'completed'
    | 'failed'
    | 'cancelled';
  abortController: AbortController;
  pendingPermission?: {
    permissionId: string;
    resolve: (response: ConfirmationResponse) => void;
    details: ConfirmationDetails;
  };
  pendingFollowUpRequested?: boolean;
  taskAdmission?: TaskAdmissionHandle;
  taskAdmissionUpdate?: Promise<void>;
  disposeRuntimeOnSettle?: boolean;
  pendingResume?: WebPendingResumeAttempt;
  projectionLease: SessionProjectionLease<SessionInfo>;
  completion?: Promise<void>;
  createdAt: Date;
}

const activeRuns = new Map<string, RunState>();
const recentRuns = new LRUCache<string, RunState>({
  max: 100,
  ttl: 30 * 60 * 1_000,
});

export function sessionRefFromSession(session: SessionInfo): SessionRef {
  return { sessionId: session.id, projectPath: session.projectPath };
}

function runRef(run: RunState): SessionRef {
  return { sessionId: run.sessionId, projectPath: run.projectPath };
}

export function registerRun(run: RunState): void {
  activeRuns.set(run.id, run);
}

export function getRun(runId: string | undefined): RunState | undefined {
  if (!runId) return undefined;
  return activeRuns.get(runId) ?? recentRuns.get(runId);
}

export function settleRun(run: RunState): void {
  if (activeRuns.get(run.id) !== run) return;
  activeRuns.delete(run.id);
  recentRuns.set(run.id, run);
}

export function forgetRun(runId: string): void {
  activeRuns.delete(runId);
  recentRuns.delete(runId);
}

export function isActiveRun(run: RunState | undefined): run is RunState {
  return (
    run?.status === 'queued' ||
    run?.status === 'running' ||
    run?.status === 'waiting_permission'
  );
}

export function cancelRun(run: RunState, reason = 'user-cancel'): boolean {
  if (
    run.status === 'cancelled' ||
    run.status === 'completed' ||
    run.status === 'failed' ||
    run.status === 'attention_required'
  ) {
    return false;
  }

  const pendingPermission = run.pendingPermission;
  run.pendingPermission = undefined;
  pendingPermission?.resolve({
    approved: false,
    reason: CONFIRMATION_ABORTED_REASON,
  });
  if (pendingPermission) {
    Bus.publish(runRef(run), 'interaction.resolved', {
      requestId: pendingPermission.permissionId,
    });
  }
  run.abortController.abort(reason);
  run.status = 'cancelled';
  Bus.publish(runRef(run), 'run.cancelled', { runId: run.id });
  return true;
}

export function resetSessionRuns(reason: string): void {
  for (const run of activeRuns.values()) {
    cancelRun(run, reason);
  }
  activeRuns.clear();
  recentRuns.clear();
}

export function listActiveRuns(): RunState[] {
  return [...activeRuns.values()];
}

export function activeRunCount(): number {
  return activeRuns.size;
}

export function findActivePermissionRun(
  ref: SessionRef,
  permissionId: string
): RunState | undefined {
  return [...activeRuns.values()].find(
    (run) =>
      run.sessionId === ref.sessionId &&
      run.projectPath === ref.projectPath &&
      run.pendingPermission?.permissionId === permissionId
  );
}

export function buildPendingInteractionEvent(
  pending: NonNullable<RunState['pendingPermission']>,
  replayed = false
): { type: string; properties: Record<string, unknown> } {
  const { permissionId, details } = pending;
  if (details.type === 'askUserQuestion' && details.questions) {
    return {
      type: 'question.required',
      properties: {
        requestId: permissionId,
        toolCallId: details.toolCallId ?? permissionId,
        questions: details.questions,
        details,
        ...(replayed ? { replayed: true } : {}),
      },
    };
  }
  if (details.type === 'mcpElicitation' && details.mcpElicitation) {
    return {
      type: 'elicitation.required',
      properties: {
        requestId: permissionId,
        toolCallId: details.toolCallId ?? permissionId,
        elicitation: details.mcpElicitation,
        ...(replayed ? { replayed: true } : {}),
      },
    };
  }

  return {
    type: 'permission.asked',
    properties: {
      requestId: permissionId,
      toolName: details.toolName,
      description: details.message,
      args: details.args,
      details,
      ...(replayed ? { replayed: true } : {}),
    },
  };
}

export function syncSessionTaskMetadata(
  session: SessionInfo,
  metadata: SessionMetadata
): void {
  session.title = metadata.title ?? session.title;
  session.taskStatus = metadata.taskStatus;
  session.taskStatusReason = metadata.taskStatusReason;
  session.taskFailure = metadata.taskFailure;
  session.taskStartedAt = metadata.taskStartedAt;
  session.taskCompletedAt = metadata.taskCompletedAt;
  session.taskPromptSummary = metadata.taskPromptSummary;
  session.taskPriority = metadata.taskPriority;
  session.taskKind = metadata.taskKind;
  session.taskDueAt = metadata.taskDueAt;
  session.taskModelId = metadata.taskModelId;
  session.selectedModelId = metadata.selectedModelId;
  session.permissionMode = metadata.permissionMode as PermissionMode | undefined;
  session.reasoningEffort = metadata.reasoningEffort;
  session.serviceTier = metadata.serviceTier;
  session.responseVerbosity = metadata.responseVerbosity;
  session.communicationStyle = metadata.communicationStyle;
  session.communicationStyleDigest = metadata.communicationStyleDigest;
  session.projectInstructionsDigest = metadata.projectInstructionsDigest;
  session.pendingInteraction = metadata.pendingInteraction;
  session.taskRetryAvailable = metadata.taskRetryAvailable;
  session.taskRetriedFrom = metadata.taskRetriedFrom;
  session.taskDelivery = metadata.taskDelivery;
  session.taskIsolation = metadata.taskIsolation;
  session.taskSourceProjectPath = metadata.taskSourceProjectPath;
  session.taskWorktreePath = metadata.taskWorktreePath;
  session.taskWorktreeBranch = metadata.taskWorktreeBranch;
  session.taskBaseCommit = metadata.taskBaseCommit;
  session.taskDiffStat = metadata.taskDiffStat;
  session.taskQueuePosition = metadata.taskQueuePosition;
  session.taskQueueDepth = metadata.taskQueueDepth;
  session.taskConcurrencyLimit = metadata.taskConcurrencyLimit;
  session.archivedAt = metadata.archivedAt;
  session.archivedBySessionId = metadata.archivedBySessionId;
  session.messageCount = metadata.messageCount;
  session.updatedAt = new Date(metadata.lastMessageTime);
}

export async function refreshSessionTaskMetadata(session: SessionInfo): Promise<void> {
  const metadata = await SessionService.findSessionMetadata(
    session.id,
    session.projectPath
  );
  if (metadata) syncSessionTaskMetadata(session, metadata);
}
