import { nanoid } from 'nanoid';
import { Agent } from '../../agent/Agent.js';
import { drainLoop } from '../../agent/loop/index.js';
import type { LoopEvent } from '../../agent/loop/types.js';
import type { PreparedInputTurn } from '../../agent/runtime/ActiveTurnMailbox.js';
import type { PendingResumeFailureEvidence } from '../../agent/runtime/PendingResumeRecoveryPolicy.js';
import { SessionRuntime } from '../../agent/runtime/SessionRuntime.js';
import type { SessionRuntimeResidencyLease } from '../../agent/runtime/SessionRuntimeResidency.js';
import {
  type TaskAdmissionHandle,
  taskRunScheduler,
} from '../../agent/runtime/TaskRunScheduler.js';
import type { ChatContext, LoopResult, UserMessageContent } from '../../agent/types.js';
import { FOLLOW_UP_QUEUE_MAX_ITEMS } from '../../api/schemas.js';
import type { PermissionMode } from '../../config/types.js';
import { taskFailureForCode, toTaskFailure } from '../../context/taskFailure.js';
import type { SessionTaskDispatch } from '../../context/types.js';
import { createLogger, LogCategory } from '../../logging/Logger.js';
import { SessionService } from '../../services/SessionService.js';
import { STRUCTURED_OUTPUT_TOOL_NAME } from '../../services/StructuredOutputService.js';
import {
  CONFIRMATION_ABORTED_REASON,
  type ConfirmationDetails,
  type ConfirmationResponse,
} from '../../tools/types/ExecutionTypes.js';
import { Bus } from '../bus.js';
import type { SessionProjectionLease } from '../SessionProjectionResidency.js';
import { projectSessionLoopEvent } from './sessionLoopEventProjection.js';
import {
  buildPendingInteractionEvent,
  cancelRun,
  type RunState,
  refreshSessionTaskMetadata,
  type SessionInfo,
  sessionRefFromSession,
  settleRun,
  syncSessionTaskMetadata,
  type WebPendingResumeAttempt,
} from './sessionRunState.js';

const logger = createLogger(LogCategory.SERVICE);
const WEB_PENDING_RESUME_DEADLINE_ABORT =
  'web-pending-resume-recovery-budget-exhausted';

class WebAgentRunFailure extends Error {
  constructor(readonly evidence: PendingResumeFailureEvidence) {
    super(evidence.taskFailure.message);
    this.name = 'WebAgentRunFailure';
  }
}

export interface SessionRunOptions {
  pendingInputOnly?: boolean;
  preparedInputTurn?: PreparedInputTurn;
  goalContinuationOnly?: boolean;
  outputSchema?: SessionTaskDispatch['outputSchema'];
  taskAdmission?: TaskAdmissionHandle;
  runtimeLease?: SessionRuntimeResidencyLease<SessionRuntime>;
  projectionLease?: SessionProjectionLease<SessionInfo>;
  disposeRuntime?: (session: SessionInfo, runtime?: SessionRuntime) => Promise<void>;
  pendingResume?: WebPendingResumeAttempt;
  onPendingResumeFailure?: (
    attempt: WebPendingResumeAttempt,
    evidence: PendingResumeFailureEvidence,
    workStillPending: boolean,
    deadlineExceeded: boolean
  ) => boolean;
  onPendingResumeSuccess?: (attempt: WebPendingResumeAttempt) => boolean;
  onPendingResumeCancelled?: (attempt: WebPendingResumeAttempt) => void;
}

function getDisplayContent(content: UserMessageContent): string {
  if (typeof content === 'string') return content;
  return content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

export async function executeRunAsync(
  run: RunState,
  session: SessionInfo,
  content: UserMessageContent,
  permissionMode: PermissionMode,
  acquireRuntime: (
    session: SessionInfo
  ) => Promise<SessionRuntimeResidencyLease<SessionRuntime>>,
  options: SessionRunOptions = {}
): Promise<void> {
  const { abortController, sessionId, id: runId } = run;
  const userMessageId = options.preparedInputTurn?.messageId ?? nanoid(12);
  const startsFromPending =
    options.pendingInputOnly === true ||
    options.preparedInputTurn?.mode === 'pending' ||
    options.goalContinuationOnly === true;
  let assistantMessageId: string | undefined = startsFromPending
    ? undefined
    : nanoid(12);
  let runtimeLease = options.runtimeLease;
  const projectionLease = options.projectionLease;
  let runtime: SessionRuntime | undefined;
  let agent: Agent | undefined;
  let outputStarted = false;
  let toolExecutionStarted = false;
  let pendingResumeDeadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const sessionRef = sessionRefFromSession(session);
  const projectedInboxMessageIds =
    options.pendingResume?.projectedInputIds ?? new Set<string>();
  const rememberProjectedInboxMessageId = (messageId: string): void => {
    if (projectedInboxMessageIds.has(messageId)) return;
    if (projectedInboxMessageIds.size >= FOLLOW_UP_QUEUE_MAX_ITEMS) {
      const oldest = projectedInboxMessageIds.values().next().value;
      if (oldest !== undefined) projectedInboxMessageIds.delete(oldest);
    }
    projectedInboxMessageIds.add(messageId);
  };
  const emit = (type: string, properties: Record<string, unknown>) => {
    Bus.publish(sessionRef, type, properties);
  };

  const settleRecoveryAttention = async (result: LoopResult): Promise<boolean> => {
    const assessment = result.metadata?.recoveryAttention;
    if (!assessment || !runtime) return false;
    if (options.preparedInputTurn) {
      await runtime
        .finishTurn(options.preparedInputTurn.handle, {
          preserveStartupRecovery: true,
          outcome: {
            status: 'aborted',
            cause: 'failed',
            turnsCount: 0,
            toolCallsCount: 0,
            durationMs: 0,
          },
        })
        .catch(() => undefined);
    }
    const reason = `Turn recovery requires attention: ${assessment.reason}`;
    const metadata = await runtime
      .setTaskStatus('interrupted', reason)
      .catch(() => undefined);
    if (metadata) syncSessionTaskMetadata(session, metadata);
    else {
      session.taskStatus = 'interrupted';
      session.taskStatusReason = reason;
      session.taskCompletedAt = undefined;
    }
    run.status = 'attention_required';
    emit('session.status', { status: 'idle' });
    return true;
  };

  const finalizeCancellation = async (): Promise<void> => {
    const reason = String(abortController.signal.reason || 'Task run cancelled');
    if (session.taskIsolation) {
      if (!runtimeLease) {
        runtimeLease = await acquireRuntime(session).catch(() => undefined);
      }
      const taskRuntime = runtime ?? runtimeLease?.value;
      if (reason === 'user-cancel') {
        await taskRuntime?.discardPendingInput().catch((error) => {
          logger.warn(
            `[SessionRoutes] Failed to discard cancelled input for ${session.id}:`,
            error
          );
        });
      }
      const metadata = await taskRuntime
        ?.setTaskStatus('cancelled', reason)
        .catch(() => undefined);
      if (metadata) {
        syncSessionTaskMetadata(session, metadata);
      } else {
        await refreshSessionTaskMetadata(session).catch(() => undefined);
      }
    }
    session.taskStatus = 'cancelled';
    session.taskStatusReason = reason;
    session.taskCompletedAt ??= new Date().toISOString();
  };

  try {
    if (options.pendingResume) {
      const remainingMs = options.pendingResume.deadlineAt - Date.now();
      if (remainingMs <= 0) {
        abortController.abort(WEB_PENDING_RESUME_DEADLINE_ABORT);
        throw new WebAgentRunFailure({
          taskFailure: taskFailureForCode('timeout'),
          outputStarted: false,
          toolExecutionStarted: false,
          toolCallsCount: 0,
        });
      }
      pendingResumeDeadlineTimer = setTimeout(() => {
        abortController.abort(WEB_PENDING_RESUME_DEADLINE_ABORT);
        const pendingPermission = run.pendingPermission;
        run.pendingPermission = undefined;
        pendingPermission?.resolve({
          approved: false,
          reason: CONFIRMATION_ABORTED_REASON,
        });
        if (pendingPermission) {
          emit('interaction.resolved', {
            requestId: pendingPermission.permissionId,
          });
        }
      }, remainingMs);
      pendingResumeDeadlineTimer.unref?.();
    }
    if (options.taskAdmission) {
      await options.taskAdmission.ready;
      await run.taskAdmissionUpdate;
      if (abortController.signal.aborted) {
        throw new Error(String(abortController.signal.reason || 'Task run cancelled'));
      }
    }

    session.taskStatus = 'running';
    session.taskStatusReason = undefined;
    session.taskStartedAt = new Date().toISOString();
    session.taskCompletedAt = undefined;
    if (!options.pendingInputOnly && !options.goalContinuationOnly) {
      emit('message.created', {
        messageId: userMessageId,
        role: 'user',
        content: getDisplayContent(content),
        ...(options.preparedInputTurn?.metadata
          ? { metadata: options.preparedInputTurn.metadata }
          : {}),
      });
    }
    emit('session.status', { status: 'running' });
    if (assistantMessageId) {
      emit('message.created', {
        messageId: assistantMessageId,
        role: 'assistant',
        content: '',
      });
    }

    runtimeLease ??= await acquireRuntime(session);
    runtime = runtimeLease.value;
    const runtimeOwner = runtime;
    const structuredOutputExpected = Boolean(
      options.outputSchema ??
        runtimeOwner
          .getPendingSteeringMessages()
          .find((pending) => pending.outputSchema)?.outputSchema
    );
    agent = await Agent.createWithRuntime(runtimeOwner, {
      sessionId,
      ...(session.taskWorktree
        ? { toolBlacklist: ['EnterWorktree', 'ExitWorktree'] }
        : {}),
    });

    const requestConfirmation = async (
      details: ConfirmationDetails
    ): Promise<ConfirmationResponse> => {
      const permissionId = details.interactionRequestId ?? nanoid(12);
      const permissionTimeoutMs = 5 * 60 * 1_000;

      run.status = 'waiting_permission';

      const resultPromise = new Promise<ConfirmationResponse>((resolve) => {
        const timeout = setTimeout(() => {
          logger.warn(
            `[SessionRoutes] Permission ${permissionId} timed out after ${permissionTimeoutMs}ms`
          );
          emit('permission.timeout', { requestId: permissionId });
          resolve({ approved: false, reason: 'timeout' });
        }, permissionTimeoutMs);

        run.pendingPermission = {
          permissionId,
          resolve: (response) => {
            clearTimeout(timeout);
            resolve(response);
          },
          details,
        };
      });

      const pendingInteraction = run.pendingPermission;
      if (!pendingInteraction) {
        throw new Error('Permission request was not registered');
      }
      const interaction = buildPendingInteractionEvent(pendingInteraction);
      emit(interaction.type, interaction.properties);

      logger.info(
        `[SessionRoutes] Permission request created: ${permissionId}, runId: ${runId}`
      );

      const response = await resultPromise;
      logger.info(
        `[SessionRoutes] Permission response received: ${permissionId}, approved: ${response.approved}`
      );
      if (!abortController.signal.aborted) {
        run.status = 'running';
      }
      if (run.pendingPermission === pendingInteraction) {
        run.pendingPermission = undefined;
      }
      emit('interaction.resolved', { requestId: permissionId });

      return response;
    };

    const modelContext = await SessionService.loadSessionModelContext(
      session.id,
      session.projectPath
    );
    const chatContext: ChatContext = {
      messages: modelContext,
      userId: 'web-user',
      sessionId,
      workspaceRoot: session.projectPath,
      signal: abortController.signal,
      permissionMode,
      onPermissionModeChange: async (nextMode) => {
        session.permissionMode = nextMode;
        session.updatedAt = new Date();
        emit('session.updated', { permissionMode: nextMode });
      },
      ...(session.taskWorktree ? { worktreeActive: true } : {}),
      confirmationHandler: { requestConfirmation },
    };
    const ensureAssistantMessage = (): string => {
      if (!assistantMessageId) {
        assistantMessageId = nanoid(12);
        emit('message.created', {
          messageId: assistantMessageId,
          role: 'assistant',
          content: '',
        });
      }
      return assistantMessageId;
    };

    const handleLoopEvent = async (event: LoopEvent) => {
      if (
        event.kind === 'tool_start' ||
        event.kind === 'tool_progress' ||
        event.kind === 'tool_result'
      ) {
        toolExecutionStarted = true;
      }
      const projection = projectSessionLoopEvent(event);
      if (projection) {
        if (projection.toolName === STRUCTURED_OUTPUT_TOOL_NAME) return;
        emit(projection.type, {
          ...(projection.messageScoped ? { messageId: ensureAssistantMessage() } : {}),
          ...projection.properties,
        });
        return;
      }
      switch (event.kind) {
        case 'conversation_recap':
          // The committed recap part is delivered by SessionEventLog (including replay).
          // Close the preceding live group so later deltas appear below the recap.
          if (assistantMessageId) {
            emit('message.complete', { messageId: assistantMessageId });
            assistantMessageId = undefined;
          }
          break;
        case 'content_delta':
          if (event.delta.length > 0) outputStarted = true;
          if (structuredOutputExpected) break;
          emit('message.delta', {
            messageId: ensureAssistantMessage(),
            delta: event.delta,
          });
          break;
        case 'structured_output':
          outputStarted = true;
          emit('structured.output', {
            messageId: ensureAssistantMessage(),
            output: event.output,
            schemaDigest: event.schemaDigest,
          });
          break;
        case 'thinking_delta':
          if (event.delta.length > 0) outputStarted = true;
          emit('thinking.delta', {
            messageId: ensureAssistantMessage(),
            delta: event.delta,
          });
          break;
        case 'token_usage':
          emit('token.usage', { ...event.usage });
          break;
        case 'turn_start':
          emit('turn.started', { turn: event.turn, maxTurns: event.maxTurns });
          break;
        case 'turn_recovery':
          emit('turn.recovery', { assessment: event.assessment });
          break;
        case 'provider_recovery':
        case 'turn_activity':
          // SessionRuntime already publishes these authoritative projections.
          break;
        case 'steering_applied':
          for (const message of event.messages) {
            if ((message.origin ?? 'user') !== 'user') continue;
            if (message.persisted) continue;
            if (projectedInboxMessageIds.has(message.id)) continue;
            emit('message.created', {
              messageId: message.id,
              role: 'user',
              content: getDisplayContent(message.content),
              ...(message.metadata ? { metadata: message.metadata } : {}),
              ...(message.recovered ? { recovered: true } : {}),
            });
            rememberProjectedInboxMessageId(message.id);
          }
          emit('steering.applied', {
            runId,
            messageIds: event.messageIds,
            count: event.count,
            recovered: event.recovered,
            delivery: event.delivery,
            queued: runtimeOwner.getPendingSteeringCount(),
          });
          emit('follow_up.queue.changed', { queue: event.queue });
          break;
        case 'follow_up_started':
          if (assistantMessageId) {
            emit('message.complete', { messageId: assistantMessageId });
            assistantMessageId = undefined;
          }
          emit('follow_up.started', {
            runId,
            queued: event.queued,
            recovered: event.recovered,
          });
          emit('follow_up.queue.changed', { queue: event.queue });
          ensureAssistantMessage();
          break;
        case 'follow_up_queue_changed':
          emit('follow_up.queue.changed', { queue: event.queue });
          break;
        case 'goal_updated':
          emit('goal.updated', { goal: event.goal });
          break;
        case 'goal_continuation_started':
          emit('goal.continuation.started', {
            goal: event.goal,
            continuation: event.continuation,
            ...(event.prematureStopPattern
              ? { prematureStopPattern: event.prematureStopPattern }
              : {}),
            ...(event.prematureStopCount !== undefined
              ? { prematureStopCount: event.prematureStopCount }
              : {}),
          });
          ensureAssistantMessage();
          break;
        case 'compaction':
          emit(
            event.phase === 'start' ? 'compaction.started' : 'compaction.completed',
            {
              ...(event.reason ? { reason: event.reason } : {}),
              ...(event.strategy ? { strategy: event.strategy } : {}),
              ...(event.outcome ? { outcome: event.outcome } : {}),
              ...(event.preTokens !== undefined ? { preTokens: event.preTokens } : {}),
              ...(event.preTokenSource ? { preTokenSource: event.preTokenSource } : {}),
              ...(event.estimatedPendingTokens !== undefined
                ? { estimatedPendingTokens: event.estimatedPendingTokens }
                : {}),
              ...(event.postTokens !== undefined
                ? { postTokens: event.postTokens }
                : {}),
              ...(event.sampleAttempts !== undefined
                ? { sampleAttempts: event.sampleAttempts }
                : {}),
              ...(event.inputReductions !== undefined
                ? { inputReductions: event.inputReductions }
                : {}),
              ...(event.messagesOmitted !== undefined
                ? { messagesOmitted: event.messagesOmitted }
                : {}),
              ...(event.filesOmitted !== undefined
                ? { filesOmitted: event.filesOmitted }
                : {}),
              ...(event.imagesOmitted !== undefined
                ? { imagesOmitted: event.imagesOmitted }
                : {}),
              ...(event.fallbackTargetTokens !== undefined
                ? { fallbackTargetTokens: event.fallbackTargetTokens }
                : {}),
              ...(event.fallbackMessagesOmitted !== undefined
                ? { fallbackMessagesOmitted: event.fallbackMessagesOmitted }
                : {}),
              ...(event.fallbackMessagesTruncated !== undefined
                ? { fallbackMessagesTruncated: event.fallbackMessagesTruncated }
                : {}),
              ...(event.failureReason ? { failureReason: event.failureReason } : {}),
              ...(event.memory ? { memory: event.memory } : {}),
            }
          );
          break;
        case 'model_fallback':
          emit('model.fallback', {
            from: event.from,
            to: event.to,
            candidate: event.candidate,
            candidateCount: event.candidateCount,
            trigger: event.trigger,
          });
          break;
        case 'task_update':
          emit('task.updated', { tasks: event.tasks });
          break;
        case 'goal_frontier_updated':
          emit('goal.frontier.updated', {
            goalId: event.goal.goalId,
            goalStatus: event.goal.status,
            frontier: event.frontier,
            stall: event.goal.frontierStall,
          });
          break;
        default:
          break;
      }
    };
    const runFailure = (result: LoopResult): WebAgentRunFailure => {
      const toolCallsCount = result.metadata?.toolCallsCount;
      return new WebAgentRunFailure({
        taskFailure: toTaskFailure(
          result.error?.details ?? result.error?.message ?? 'Agent run failed'
        ),
        outputStarted,
        toolExecutionStarted,
        toolCallsCount:
          typeof toolCallsCount === 'number' && Number.isInteger(toolCallsCount)
            ? toolCallsCount
            : -1,
      });
    };

    let loopResult = await drainLoop(
      agent.chatStream(content, chatContext, {
        stream: true,
        pendingInputOnly: options.pendingInputOnly,
        preparedInputTurn: options.preparedInputTurn,
        goalContinuationOnly: options.goalContinuationOnly,
        outputSchema: options.outputSchema,
        taskAdmission: options.taskAdmission,
      }),
      handleLoopEvent
    );
    if (await settleRecoveryAttention(loopResult)) return;
    if (!loopResult.success) throw runFailure(loopResult);

    for (let followUpRun = 0; followUpRun < 20; followUpRun++) {
      const requested = run.pendingFollowUpRequested === true;
      run.pendingFollowUpRequested = false;
      if (runtimeOwner.getPendingSteeringCount() === 0) {
        if (!requested) break;
        continue;
      }
      if (abortController.signal.aborted) break;

      loopResult = await drainLoop(
        agent.chatStream('', chatContext, {
          stream: true,
          pendingInputOnly: true,
          taskAdmission: options.taskAdmission,
        }),
        handleLoopEvent
      );
      if (await settleRecoveryAttention(loopResult)) return;
      if (!loopResult.success) throw runFailure(loopResult);
    }

    await refreshSessionTaskMetadata(session);

    if (
      options.pendingResume &&
      abortController.signal.aborted &&
      abortController.signal.reason === WEB_PENDING_RESUME_DEADLINE_ABORT
    ) {
      throw new WebAgentRunFailure({
        taskFailure: taskFailureForCode('timeout'),
        outputStarted,
        toolExecutionStarted,
        toolCallsCount: Number.isInteger(loopResult.metadata?.toolCallsCount)
          ? (loopResult.metadata?.toolCallsCount ?? -1)
          : -1,
      });
    }

    if (abortController.signal.aborted || run.status === 'cancelled') {
      await finalizeCancellation();
      emit('session.status', { status: 'idle' });
      return;
    }
    if (options.pendingResume) {
      options.onPendingResumeSuccess?.(options.pendingResume);
    }

    if (assistantMessageId) {
      emit('message.complete', { messageId: assistantMessageId });
    }
    emit('thinking.completed', {});

    run.status = 'completed';
    session.taskStatus = 'completed';
    session.taskCompletedAt ??= new Date().toISOString();
    emit('session.completed', {
      runId,
      outputTruncated: loopResult.metadata?.outputTruncated ?? false,
    });
    emit('session.status', { status: 'idle' });
  } catch (error) {
    if (runtime && options.preparedInputTurn) {
      const recoveryAssessment = runtime.getTurnRecoveryAssessment();
      const cleanup =
        recoveryAssessment.state === 'requires_attention'
          ? runtime.finishTurn(options.preparedInputTurn.handle, {
              preserveStartupRecovery: true,
            })
          : runtime.finishTurn(options.preparedInputTurn.handle);
      await cleanup.catch(() => undefined);
    }
    const deadlineExceeded =
      options.pendingResume !== undefined &&
      abortController.signal.aborted &&
      abortController.signal.reason === WEB_PENDING_RESUME_DEADLINE_ABORT;
    if (
      (abortController.signal.aborted && !deadlineExceeded) ||
      run.status === 'cancelled'
    ) {
      if (options.pendingResume) {
        options.onPendingResumeCancelled?.(options.pendingResume);
      }
      cancelRun(run, 'runtime-abort');
      await finalizeCancellation();
      emit('session.status', { status: 'idle' });
      return;
    }
    const pendingResumeEvidence =
      error instanceof WebAgentRunFailure
        ? error.evidence
        : deadlineExceeded
          ? {
              taskFailure: taskFailureForCode('timeout'),
              outputStarted,
              toolExecutionStarted,
              toolCallsCount: -1,
            }
          : options.pendingResume
            ? {
                taskFailure: toTaskFailure(error),
                outputStarted: true,
                toolExecutionStarted: true,
                toolCallsCount: -1,
              }
            : undefined;
    const retryScheduled =
      options.pendingResume !== undefined &&
      pendingResumeEvidence !== undefined &&
      options.onPendingResumeFailure?.(
        options.pendingResume,
        pendingResumeEvidence,
        deadlineExceeded || (runtime?.getPendingSteeringCount() ?? 0) > 0,
        deadlineExceeded
      ) === true;
    run.status = 'failed';
    if (retryScheduled) {
      const runningMetadata = await runtime
        ?.setTaskStatus('running')
        .catch(() => undefined);
      if (runningMetadata) syncSessionTaskMetadata(session, runningMetadata);
      session.taskStatus = 'running';
      session.taskStatusReason = undefined;
      session.taskFailure = undefined;
      session.taskCompletedAt = undefined;
      emit('session.status', { status: 'running' });
      return;
    }
    await refreshSessionTaskMetadata(session).catch(() => undefined);
    logger.error('[SessionRoutes] Agent execution error:', error);
    session.taskStatus = 'failed';
    session.taskCompletedAt ??= new Date().toISOString();
    const taskFailure = pendingResumeEvidence?.taskFailure ?? toTaskFailure(error);
    if (!session.taskFailure) {
      const failedMetadata = runtime
        ? await runtime.setTaskStatus('failed', error).catch(() => undefined)
        : await SessionService.updateSessionMetadata(session.id, session.projectPath, {
            taskStatus: 'failed',
            taskStatusReason: taskFailure.message,
            taskFailure,
            taskCompletedAt: session.taskCompletedAt,
            taskOwnerPid: null,
            taskQueuePosition: null,
            taskQueueDepth: null,
          }).catch(() => undefined);
      if (failedMetadata) syncSessionTaskMetadata(session, failedMetadata);
    }
    session.taskStatusReason ??= taskFailure.message;
    session.taskFailure ??= taskFailure;
    emit('session.error', {
      error: session.taskFailure.message,
      taskFailure: session.taskFailure,
    });
    emit('session.status', { status: 'error' });
  } finally {
    if (pendingResumeDeadlineTimer) clearTimeout(pendingResumeDeadlineTimer);
    options.taskAdmission?.release();
    if (options.taskAdmission) {
      const stats = taskRunScheduler.getStats();
      emit('task.status', {
        taskStatus: session.taskStatus,
        ...(session.taskStatusReason
          ? { taskStatusReason: session.taskStatusReason }
          : {}),
        ...(session.taskFailure ? { taskFailure: session.taskFailure } : {}),
        ...(session.taskStartedAt ? { taskStartedAt: session.taskStartedAt } : {}),
        ...(session.taskCompletedAt
          ? { taskCompletedAt: session.taskCompletedAt }
          : {}),
        ...(session.taskDiffStat ? { taskDiffStat: session.taskDiffStat } : {}),
        taskQueueDepth: stats.queued,
        taskConcurrencyLimit: stats.maxConcurrent,
        taskInFlight: stats.inFlight,
        taskAdmissionPaused: stats.paused,
        updatedAt: new Date().toISOString(),
      });
    }
    await agent?.destroy().catch(() => undefined);
    runtimeLease?.release();
    projectionLease?.release();
    if (run.disposeRuntimeOnSettle && options.disposeRuntime) {
      await options.disposeRuntime(session, runtime).catch((error) => {
        logger.warn(
          `[SessionRoutes] Failed to dispose terminal task runtime ${session.id}:`,
          error
        );
      });
    }
    settleRun(run);
  }
}
