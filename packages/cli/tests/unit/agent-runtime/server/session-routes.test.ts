import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoopEvent } from '../../../../src/agent/loop/types.js';
import type {
  InputTurnPreparation,
  SteeringEnqueueResult,
} from '../../../../src/agent/runtime/ActiveTurnMailbox.js';
import {
  SessionRuntime,
  type SessionRuntimeOptions,
} from '../../../../src/agent/runtime/SessionRuntime.js';
import { taskRunScheduler } from '../../../../src/agent/runtime/TaskRunScheduler.js';
import { MAX_INLINE_ATTACHMENT_BYTES } from '../../../../src/api/attachmentLimits.js';
import { PermissionMode } from '../../../../src/config/types.js';
import type { SessionEvent } from '../../../../src/context/types.js';
import type { Message } from '../../../../src/services/ChatServiceInterface.js';
import type {
  SessionMetadata,
  SessionMetadataUpdate,
} from '../../../../src/services/SessionService.js';
import { SessionService } from '../../../../src/services/SessionService.js';

const DEFAULT_PROJECT_PATH =
  '/Users/bytedance/Documents/GitHub/Blade/.worktrees/session-discovery-fork/packages/cli';

type EventReplaySubscriber = {
  onCommitted(event: SessionEvent): void | Promise<void>;
};

type CreateMetadataInitial = Pick<
  SessionMetadataUpdate,
  | 'title'
  | 'taskStatus'
  | 'taskPromptSummary'
  | 'taskDispatch'
  | 'taskModelId'
  | 'taskRetriedFrom'
  | 'taskIsolation'
  | 'taskSourceProjectPath'
  | 'taskWorktree'
  | 'selectedModelId'
  | 'permissionMode'
  | 'reasoningEffort'
  | 'serviceTier'
  | 'responseVerbosity'
  | 'communicationStyle'
>;

const makePreparedInputTurn = (): InputTurnPreparation => ({
  accepted: true,
  handle: { id: 'prepared-turn' },
  messageId: 'prepared-input',
  queued: 1,
  mode: 'direct',
});

const makeSteeringEnqueueResult = (): SteeringEnqueueResult => ({
  accepted: true,
  messageId: 'steering-input',
  turnId: 'turn-1',
  queued: 1,
  delivery: 'current_turn',
});

const makeMessages = (...messages: Message[]): Message[] => messages;

const waitForGateOrAbort = (
  gate: Promise<void>,
  signal: AbortSignal
): Promise<void> => {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
    gate.then(
      () => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
  });
};

const makeSessionMetadata = (
  overrides: Pick<SessionMetadata, 'sessionId' | 'projectPath'> &
    Partial<
      Omit<SessionMetadata, 'sessionId' | 'projectPath' | 'rootId'> & {
        rootId: string;
      }
    >
): SessionMetadata => ({
  sessionId: overrides.sessionId,
  projectPath: overrides.projectPath,
  rootId: overrides.rootId ?? overrides.sessionId,
  title: overrides.title ?? `Session ${overrides.sessionId}`,
  taskStatus: overrides.taskStatus ?? 'completed',
  taskStatusReason: overrides.taskStatusReason,
  taskFailure: overrides.taskFailure,
  taskStartedAt: overrides.taskStartedAt,
  taskCompletedAt: overrides.taskCompletedAt,
  taskPromptSummary: overrides.taskPromptSummary,
  taskPriority: overrides.taskPriority,
  taskKind: overrides.taskKind,
  taskDueAt: overrides.taskDueAt,
  taskModelId: overrides.taskModelId,
  selectedModelId: overrides.selectedModelId,
  permissionMode: overrides.permissionMode,
  reasoningEffort: overrides.reasoningEffort,
  serviceTier: overrides.serviceTier,
  responseVerbosity: overrides.responseVerbosity,
  communicationStyle: overrides.communicationStyle,
  taskRetryAvailable: overrides.taskRetryAvailable,
  taskRetriedFrom: overrides.taskRetriedFrom,
  taskDelivery: overrides.taskDelivery,
  taskIsolation: overrides.taskIsolation,
  taskSourceProjectPath: overrides.taskSourceProjectPath,
  taskWorktreePath: overrides.taskWorktreePath,
  taskWorktreeBranch: overrides.taskWorktreeBranch,
  taskBaseCommit: overrides.taskBaseCommit,
  taskDiffStat: overrides.taskDiffStat,
  taskQueuePosition: overrides.taskQueuePosition,
  taskQueueDepth: overrides.taskQueueDepth,
  taskConcurrencyLimit: overrides.taskConcurrencyLimit,
  messageCount: overrides.messageCount ?? 0,
  firstMessageTime: overrides.firstMessageTime ?? new Date(0).toISOString(),
  lastMessageTime: overrides.lastMessageTime ?? new Date(1).toISOString(),
  hasErrors: overrides.hasErrors ?? false,
  ...(overrides.parentId ? { parentId: overrides.parentId } : {}),
  ...(overrides.relationType ? { relationType: overrides.relationType } : {}),
});

const runtimeState = vi.hoisted(() => ({
  runtime: {
    sessionId: 'session-1',
    dispose: vi.fn().mockResolvedValue(undefined),
    refresh: vi.fn().mockResolvedValue(undefined),
    getConfig: vi.fn(() => ({})),
    createToolExecutor: vi.fn(() => ({})),
    getChatService: vi.fn(),
    getExecutionEngine: vi.fn(),
    getAttachmentCollector: vi.fn(),
    getCurrentModelId: vi.fn(() => 'model-1'),
    getReasoningConfiguration: vi.fn(() => ({
      selection: 'off' as const,
      effective: 'off' as const,
      supported: ['off' as const],
    })),
    resolveReasoningConfiguration: vi.fn((selection: string) => ({
      selection,
      effective: selection === 'auto' ? 'high' : selection,
      supported: ['off', 'low', 'medium', 'high'],
    })),
    getServiceTierConfiguration: vi.fn(() => ({
      selection: 'auto' as const,
      effective: 'provider-default' as const,
      supported: ['standard', 'fast', 'flex'] as const,
    })),
    resolveServiceTierConfiguration: vi.fn((selection: string) => ({
      selection,
      effective: selection === 'auto' ? 'provider-default' : selection,
      supported: ['standard', 'fast', 'flex'],
    })),
    getResponseVerbosityConfiguration: vi.fn(() => ({
      selection: 'auto' as const,
      effective: 'provider-default' as const,
      supported: ['low', 'medium', 'high'] as const,
    })),
    resolveResponseVerbosityConfiguration: vi.fn((selection: string) => ({
      selection,
      effective: selection === 'auto' ? 'provider-default' : selection,
      supported: ['low', 'medium', 'high'],
    })),
    getCommunicationStyleConfiguration: vi.fn(() => ({
      selection: 'auto' as const,
      effective: 'blade-default' as const,
    })),
    resolveCommunicationStyleConfiguration: vi.fn((selection: string) => ({
      selection,
      effective: selection === 'auto' ? 'blade-default' : selection,
    })),
    getModelById: vi.fn((modelId: string) =>
      modelState.current?.id === modelId ? modelState.current : undefined
    ),
    getCurrentModelMaxContextTokens: vi.fn(() => 128000),
    getTaskAdmissionLimits: vi.fn(() => ({
      maxConcurrent: 3,
      maxQueued: 100,
      maxQueuedBytes: 64 * 1024 * 1024,
    })),
    setTaskAdmission: vi.fn().mockResolvedValue(undefined),
    setTaskStatus: vi.fn().mockResolvedValue(undefined),
    discardPendingInput: vi.fn().mockResolvedValue(undefined),
    prepareInputTurn: vi.fn(
      async (): Promise<InputTurnPreparation> => makePreparedInputTurn()
    ),
    enqueueSteering: vi.fn(
      async (): Promise<SteeringEnqueueResult> => makeSteeringEnqueueResult()
    ),
    finishTurn: vi.fn().mockResolvedValue(undefined),
    getPendingSteeringCount: vi.fn(() => 0),
    getPendingSteeringMessages: vi.fn(() => []),
    getRecoveredSteeringCount: vi.fn(() => 0),
    hasActiveTurn: vi.fn(() => false),
    hasTurnOwner: vi.fn(() => false),
    isIdleForResidency: vi.fn(() => true),
    getGoal: vi.fn().mockResolvedValue(null),
    createGoal: vi.fn(),
    editGoal: vi.fn(),
    pauseGoal: vi.fn(),
    resumeGoal: vi.fn(),
    clearGoal: vi.fn().mockResolvedValue(false),
    listRewindCheckpoints: vi.fn().mockResolvedValue([]),
    rewindSession: vi.fn(),
    listSubagents: vi.fn(() => []),
    resumeSubagent: vi.fn(),
    askSideQuestion: vi.fn().mockResolvedValue({
      response: 'Side answer',
      durationMs: 9,
    }),
    executeUserShellCommand: vi.fn(),
  },
}));

const agentState = vi.hoisted(() => ({
  chatStream: vi.fn(),
  destroy: vi.fn(async () => undefined),
}));

const modelState = vi.hoisted(() => ({
  current: {
    id: 'model-1',
    provider: 'openai',
    model: 'gpt-4',
  } as { id: string; provider: string; model: string } | undefined,
}));
const runtimeResidencyConfig = vi.hoisted(() => ({
  maxResident: 256,
  idleMs: 300_000,
}));

const busState = vi.hoisted(() => ({
  subscribers: new Set<
    (event: {
      sessionId: string;
      projectPath: string;
      type: string;
      seq?: number;
      properties: Record<string, unknown>;
    }) => void
  >(),
  publish: vi.fn(
    (
      ref: { sessionId: string; projectPath: string },
      type: string,
      properties: Record<string, unknown>,
      seq?: number
    ) => {
      const event = {
        sessionId: ref.sessionId,
        projectPath: ref.projectPath,
        type,
        ...(seq !== undefined ? { seq } : {}),
        properties,
      };
      for (const subscriber of busState.subscribers) {
        subscriber(event);
      }
    }
  ),
  subscribe: vi.fn(
    (
      callback: (event: {
        sessionId: string;
        projectPath: string;
        type: string;
        seq?: number;
        properties: Record<string, unknown>;
      }) => void
    ) => {
      busState.subscribers.add(callback);
      return vi.fn(() => {
        busState.subscribers.delete(callback);
      });
    }
  ),
}));

const eventLogState = vi.hoisted(() => ({
  replay: vi.fn<(subscriber: EventReplaySubscriber, fromSeq: number) => Promise<void>>(
    async () => undefined
  ),
}));

const reviewState = vi.hoisted(() => ({
  start: vi.fn(async () => ({
    reviewId: 'review-1',
    completion: Promise.resolve({
      reviewId: 'review-1',
      status: 'completed' as const,
      overallExplanation: 'Reviewed.',
      findings: [],
      completedAt: new Date(0).toISOString(),
    }),
  })),
  recoverInterrupted: vi.fn(async () => undefined),
  list: vi.fn(async () => []),
}));

const worktreeState = vi.hoisted(() => ({
  enter: vi.fn(),
  restoreSession: vi.fn(async (session) => session),
  apply: vi.fn(),
  exit: vi.fn().mockResolvedValue({
    action: 'remove',
    workspaceRoot: '/tmp/source',
    removed: true,
  }),
}));

vi.mock('../../../../src/agent/runtime/SessionRuntime.js', () => ({
  SessionRuntime: {
    create: vi.fn(async () => runtimeState.runtime),
    hasPendingInbox: vi.fn(async () => false),
    hasActiveGoal: vi.fn(async () => false),
  },
}));

vi.mock('../../../../src/agent/Agent.js', () => ({
  Agent: {
    createWithRuntime: vi.fn(async () => ({
      chatStream: agentState.chatStream,
      destroy: agentState.destroy,
    })),
  },
}));

vi.mock('../../../../src/server/bus.js', () => ({
  Bus: {
    publish: busState.publish,
    subscribe: busState.subscribe,
  },
}));

vi.mock('../../../../src/context/events/SessionEventLog.js', () => ({
  SessionEventLog: {
    for: vi.fn(() => ({
      replay: eventLogState.replay,
    })),
  },
}));

vi.mock('../../../../src/services/CodeReviewService.js', () => ({
  CodeReviewService: reviewState,
  renderCodeReview: vi.fn(() => '## Code Review'),
}));

vi.mock('../../../../src/store/vanilla.js', () => ({
  getConfig: () => ({
    currentModelId: modelState.current?.id ?? '',
    models: modelState.current ? [modelState.current] : [],
    modelProviders: {},
    maxResidentSessionRuntimes: runtimeResidencyConfig.maxResident,
    sessionRuntimeIdleMs: runtimeResidencyConfig.idleMs,
  }),
  getCurrentModel: () => modelState.current,
  getModelById: (modelId: string) =>
    modelState.current?.id === modelId ? modelState.current : undefined,
}));

vi.mock('../../../../src/agent/resources/WorkspaceModelResources.js', () => ({
  resolveWorkspaceModelResources: vi.fn(
    async (projectRoot: string, startupConfig: Record<string, unknown>) => ({
      projectRoot,
      config: startupConfig,
      catalog: {
        resolveConfig: (config: { model: string; provider: string }) => ({
          id: config.model,
          name: config.model,
          provider: config.provider,
          api: 'openai-completions',
          baseUrl: 'https://example.test/v1',
          reasoning: false,
          input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128_000,
          maxTokens: 16_000,
        }),
      },
    })
  ),
}));

vi.mock('../../../../src/agent/resources/WorkspaceAgentResources.js', () => ({
  resolveWorkspaceAgentResources: vi.fn(async () => ({
    communicationStyles: {
      resolve: (selection: string) => ({
        selection,
        effective: selection === 'auto' ? 'blade-default' : selection,
        name: selection,
        description: `Use ${selection}`,
        source: 'built-in',
        supported: [],
      }),
      list: () => [],
      snapshot() {
        return this;
      },
    },
  })),
}));

vi.mock('../../../../src/worktree/WorktreeManager.js', () => ({
  WorktreeDeliveryConflict: class WorktreeDeliveryConflict extends Error {
    constructor(
      public readonly reason: string,
      message: string
    ) {
      super(message);
    }
  },
  worktreeManager: worktreeState,
}));

vi.mock('../../../../src/services/SessionService.js', () => ({
  SessionArchivedError: class SessionArchivedError extends Error {},
  SessionArchiveConflictError: class SessionArchiveConflictError extends Error {},
  SessionMissingCreationError: class SessionMissingCreationError extends Error {},
  SessionService: {
    listSessions: vi.fn(async () => []),
    listSessionPage: vi.fn(async () => ({ sessions: [] })),
    findSessionMetadata: vi.fn(async () => undefined),
    findSessionTaskWorktree: vi.fn(async () => undefined),
    findSessionTaskDispatch: vi.fn(async () => undefined),
    loadSession: vi.fn(async () => []),
    loadSessionModelContext: vi.fn(async () => []),
    exportSessionMarkdown: vi.fn(async () => ({
      filename: 'blade-session-test.md',
      markdown: '# Blade conversation\n',
      contentSha256: 'a'.repeat(64),
      contentBytes: 20,
      messageCount: 1,
      activityCount: 0,
      reasoningIncluded: false,
      reasoningCount: 0,
      redactionCount: 0,
    })),
    assertSessionWritable: vi.fn(async () => undefined),
    listSessionArchiveMembers: vi.fn(async () => []),
    archiveSession: vi.fn(async () => undefined),
    unarchiveSession: vi.fn(async () => undefined),
    createSessionMetadata: vi.fn(
      async (sessionId: string, projectPath: string, initial?: CreateMetadataInitial) =>
        makeSessionMetadata({
          sessionId,
          projectPath,
          title: initial?.title,
          taskStatus: initial?.taskStatus ?? 'queued',
          taskPromptSummary: initial?.taskPromptSummary ?? undefined,
          taskModelId: initial?.taskModelId ?? undefined,
          selectedModelId:
            initial?.selectedModelId ?? initial?.taskModelId ?? undefined,
          reasoningEffort: initial?.reasoningEffort ?? undefined,
          serviceTier: initial?.serviceTier ?? undefined,
          responseVerbosity: initial?.responseVerbosity ?? undefined,
          communicationStyle: initial?.communicationStyle ?? undefined,
          taskRetryAvailable: initial?.taskDispatch !== undefined,
          taskRetriedFrom: initial?.taskRetriedFrom ?? undefined,
          taskIsolation: initial?.taskIsolation ?? undefined,
          taskSourceProjectPath: initial?.taskSourceProjectPath ?? undefined,
          taskWorktreePath: initial?.taskWorktree?.worktreeRoot,
          taskWorktreeBranch: initial?.taskWorktree?.branch,
          taskBaseCommit: initial?.taskWorktree?.baseCommit,
          lastMessageTime: new Date(0).toISOString(),
        })
    ),
    updateSessionMetadata: vi.fn(
      async (sessionId: string, projectPath: string, update: SessionMetadataUpdate) =>
        makeSessionMetadata({
          sessionId,
          projectPath,
          title: update.title,
          permissionMode: update.permissionMode ?? undefined,
          selectedModelId: update.selectedModelId ?? undefined,
          reasoningEffort: update.reasoningEffort ?? undefined,
          serviceTier: update.serviceTier ?? undefined,
          responseVerbosity: update.responseVerbosity ?? undefined,
          communicationStyle: update.communicationStyle ?? undefined,
        })
    ),
    setSessionPermissionMode: vi.fn(
      async (sessionId: string, projectPath: string, permissionMode: string) =>
        makeSessionMetadata({
          sessionId,
          projectPath,
          permissionMode: permissionMode as SessionMetadata['permissionMode'],
        })
    ),
    forkSession: vi.fn(
      async (
        sessionId: string,
        options: { sourceProjectPath: string; targetProjectPath: string }
      ) => ({
        sessionId: 'forked-session',
        parentSessionId: sessionId,
        projectPath: options.targetProjectPath,
        messages: makeMessages(),
        metadata: makeSessionMetadata({
          sessionId: 'forked-session',
          projectPath: options.targetProjectPath,
          parentId: sessionId,
          relationType: 'fork',
          rootId: sessionId,
          lastMessageTime: new Date(0).toISOString(),
        }),
      })
    ),
    deleteSession: vi.fn(async () => {
      /* noop */
    }),
  },
}));

vi.mock('../../../../src/logging/Logger.js', () => ({
  LogCategory: {
    SERVICE: 'service',
  },
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

function createSseCollector(response: Response) {
  if (!response.body) {
    throw new Error('Expected SSE response body');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  return {
    async next() {
      while (true) {
        const readResult = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => {
            setTimeout(
              () => reject(new Error('Timed out waiting for SSE event')),
              2000
            );
          }),
        ]);
        if (readResult.done) {
          throw new Error('SSE stream ended before the next event was received');
        }
        buffer += decoder.decode(readResult.value, { stream: true });
        const delimiterIndex = buffer.indexOf('\n\n');
        if (delimiterIndex === -1) {
          continue;
        }
        const rawEvent = buffer.slice(0, delimiterIndex);
        buffer = buffer.slice(delimiterIndex + 2);
        const data = rawEvent
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (!data) {
          continue;
        }
        return JSON.parse(data) as {
          type: string;
          seq?: number;
          properties: Record<string, unknown>;
        };
      }
    },
    async cancel() {
      await reader.cancel().catch(() => undefined);
    },
  };
}

describe('SessionRoutes runtime reuse', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    taskRunScheduler.resetForTests();
    busState.subscribers.clear();
    eventLogState.replay.mockReset().mockResolvedValue(undefined);
    reviewState.start.mockClear();
    reviewState.recoverInterrupted.mockClear();
    reviewState.list.mockClear();
    modelState.current = {
      id: 'model-1',
      provider: 'openai',
      model: 'gpt-4',
    };
    runtimeResidencyConfig.maxResident = 256;
    runtimeResidencyConfig.idleMs = 300_000;
    runtimeState.runtime.dispose.mockClear();
    runtimeState.runtime.refresh.mockClear();
    runtimeState.runtime.getResponseVerbosityConfiguration.mockClear();
    runtimeState.runtime.resolveResponseVerbosityConfiguration.mockClear();
    runtimeState.runtime.getCommunicationStyleConfiguration.mockClear();
    runtimeState.runtime.resolveCommunicationStyleConfiguration.mockClear();
    runtimeState.runtime.prepareInputTurn.mockReset();
    runtimeState.runtime.prepareInputTurn.mockImplementation(async () =>
      makePreparedInputTurn()
    );
    runtimeState.runtime.enqueueSteering.mockClear();
    runtimeState.runtime.setTaskAdmission.mockClear();
    runtimeState.runtime.setTaskStatus.mockClear();
    runtimeState.runtime.discardPendingInput.mockClear();
    runtimeState.runtime.getTaskAdmissionLimits.mockReturnValue({
      maxConcurrent: 3,
      maxQueued: 100,
      maxQueuedBytes: 64 * 1024 * 1024,
    });
    runtimeState.runtime.enqueueSteering.mockResolvedValue(makeSteeringEnqueueResult());
    runtimeState.runtime.finishTurn.mockClear();
    runtimeState.runtime.getPendingSteeringCount.mockReturnValue(0);
    runtimeState.runtime.getPendingSteeringMessages.mockReturnValue([]);
    runtimeState.runtime.getRecoveredSteeringCount.mockReturnValue(0);
    runtimeState.runtime.hasActiveTurn.mockReturnValue(false);
    runtimeState.runtime.hasTurnOwner.mockReturnValue(false);
    runtimeState.runtime.isIdleForResidency.mockReset();
    runtimeState.runtime.isIdleForResidency.mockReturnValue(true);
    runtimeState.runtime.listRewindCheckpoints.mockReset();
    runtimeState.runtime.listRewindCheckpoints.mockResolvedValue([]);
    runtimeState.runtime.rewindSession.mockReset();
    runtimeState.runtime.listSubagents.mockReset();
    runtimeState.runtime.listSubagents.mockReturnValue([]);
    runtimeState.runtime.resumeSubagent.mockReset();
    runtimeState.runtime.askSideQuestion.mockReset().mockResolvedValue({
      response: 'Side answer',
      durationMs: 9,
    });
    runtimeState.runtime.executeUserShellCommand.mockReset();
    worktreeState.enter.mockReset();
    worktreeState.restoreSession.mockReset();
    worktreeState.restoreSession.mockImplementation(async (session) => session);
    worktreeState.apply.mockReset();
    worktreeState.exit.mockReset().mockResolvedValue({
      action: 'remove',
      workspaceRoot: '/tmp/source',
      removed: true,
    });
    vi.mocked(SessionRuntime.create).mockImplementation(
      async (options: SessionRuntimeOptions) =>
        createRuntimeDouble({
          sessionId: options.sessionId,
          workspaceRoot: options.workspaceRoot,
        })
    );
    vi.mocked(SessionRuntime.hasPendingInbox).mockResolvedValue(false);
    vi.mocked(SessionRuntime.hasActiveGoal).mockResolvedValue(false);
    vi.mocked(SessionService.listSessions).mockResolvedValue([]);
    vi.mocked(SessionService.listSessionPage).mockResolvedValue({ sessions: [] });
    vi.mocked(SessionService.findSessionMetadata).mockResolvedValue(undefined);
    vi.mocked(SessionService.findSessionTaskWorktree).mockResolvedValue(undefined);
    vi.mocked(SessionService.findSessionTaskDispatch).mockResolvedValue(undefined);
    vi.mocked(SessionService.loadSession).mockResolvedValue(makeMessages());
    vi.mocked(SessionService.loadSessionModelContext).mockImplementation(
      (sessionId, projectPath) => SessionService.loadSession(sessionId, projectPath)
    );
    vi.mocked(SessionService.setSessionPermissionMode).mockImplementation(
      async (sessionId: string, projectPath: string, permissionMode) =>
        makeSessionMetadata({
          sessionId,
          projectPath,
          permissionMode,
        })
    );
    vi.mocked(SessionService.createSessionMetadata).mockImplementation(
      async (sessionId: string, projectPath: string, initial?: CreateMetadataInitial) =>
        makeSessionMetadata({
          sessionId,
          projectPath,
          title: initial?.title,
          taskStatus: initial?.taskStatus ?? 'queued',
          taskPromptSummary: initial?.taskPromptSummary ?? undefined,
          taskModelId: initial?.taskModelId ?? undefined,
          selectedModelId:
            initial?.selectedModelId ?? initial?.taskModelId ?? undefined,
          permissionMode: initial?.permissionMode ?? undefined,
          taskRetryAvailable: initial?.taskDispatch !== undefined,
          taskRetriedFrom: initial?.taskRetriedFrom ?? undefined,
          taskIsolation: initial?.taskIsolation ?? undefined,
          taskSourceProjectPath: initial?.taskSourceProjectPath ?? undefined,
          taskWorktreePath: initial?.taskWorktree?.worktreeRoot,
          taskWorktreeBranch: initial?.taskWorktree?.branch,
          taskBaseCommit: initial?.taskWorktree?.baseCommit,
          lastMessageTime: new Date(0).toISOString(),
        })
    );
    vi.mocked(SessionService.updateSessionMetadata).mockImplementation(
      async (sessionId: string, projectPath: string, update: SessionMetadataUpdate) =>
        makeSessionMetadata({
          sessionId,
          projectPath,
          title: update.title,
          permissionMode: update.permissionMode ?? undefined,
          selectedModelId: update.selectedModelId ?? undefined,
        })
    );
    agentState.chatStream.mockImplementation(async function* () {
      if (Date.now() < 0) {
        yield undefined;
      }
      return {
        success: true,
        finalMessage: 'assistant reply',
        metadata: { turnsCount: 1, toolCallsCount: 0, duration: 0 },
      };
    });
    agentState.destroy.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  const refFor = (sessionId: string) => ({
    sessionId,
    projectPath: DEFAULT_PROJECT_PATH,
  });

  it('projects terminal committed Bash results identically for replay and fresh load', async () => {
    const { projectClientMessages, projectCommittedSessionEvent } = await import(
      '../../../../src/server/routes/session.js'
    );
    const payload = {
      toolCallId: 'bash-replay-call',
      toolName: 'Bash',
      output: {
        stdout: 'STDOUT_TAIL',
        stderr: 'STDERR_TAIL',
        output_truncated: true,
        truncation_info: 'Output truncated: earliest bytes omitted',
      },
      error: null,
      metadata: {
        summary: 'Command completed',
        output_truncated: true,
        stdout_total_bytes: 1_100_000,
        stdout_omitted_bytes: 51_424,
        stdout: 'RAW_STDOUT_SENTINEL',
        stderr: 'RAW_STDERR_SENTINEL',
      },
    };
    const event: SessionEvent = {
      id: 'result-event',
      seq: 42,
      sessionId: 'replay-session',
      timestamp: '2026-08-13T00:00:00.000Z',
      type: 'part_created',
      cwd: DEFAULT_PROJECT_PATH,
      version: 'test',
      data: {
        partId: 'result-part',
        messageId: 'assistant-message',
        partType: 'tool_result',
        payload,
        createdAt: '2026-08-13T00:00:00.000Z',
      },
    };

    const replay = projectCommittedSessionEvent(event);
    const fresh = projectClientMessages([
      {
        role: 'tool',
        name: 'Bash',
        tool_call_id: payload.toolCallId,
        content: 'RAW_FRESH_LOAD_CONTENT',
        metadata: payload,
      },
    ]);

    expect(replay).toMatchObject({
      type: 'tool.result',
      seq: 42,
      properties: {
        messageId: 'assistant-message',
        toolCallId: payload.toolCallId,
        toolName: 'Bash',
        success: true,
        status: 'completed',
      },
    });
    expect(replay.properties.output).toBe(fresh[0]?.content);
    expect(replay.properties.output).toContain('STDOUT_TAIL');
    expect(replay.properties.output).toContain('STDERR_TAIL');
    expect(replay.properties.metadata).toMatchObject({
      summary: 'Command completed',
      stdout_total_bytes: 1_100_000,
      stdout_omitted_bytes: 51_424,
    });
    expect(JSON.stringify(replay)).not.toContain('RAW_');
    expect(JSON.stringify(fresh)).not.toContain('RAW_');
  });

  it('projects a committed failed null result as a self-contained terminal event', async () => {
    const { projectCommittedSessionEvent } = await import(
      '../../../../src/server/routes/session.js'
    );
    const event: SessionEvent = {
      id: 'failed-result-event',
      seq: 43,
      sessionId: 'replay-session',
      timestamp: '2026-08-13T00:00:00.000Z',
      type: 'part_created',
      cwd: DEFAULT_PROJECT_PATH,
      version: 'test',
      data: {
        partId: 'failed-result-part',
        messageId: 'failed-assistant-message',
        partType: 'tool_result',
        payload: {
          toolCallId: 'failed-call',
          toolName: 'Bash',
          output: null,
          error: 'Command interrupted because Blade restarted',
          metadata: { processRestartRecovery: true },
        },
        createdAt: '2026-08-13T00:00:00.000Z',
      },
    };

    const replay = projectCommittedSessionEvent(event);

    expect(replay).toMatchObject({
      type: 'tool.result',
      seq: 43,
      properties: {
        messageId: 'failed-assistant-message',
        toolCallId: 'failed-call',
        toolName: 'Bash',
        success: false,
        status: 'failed',
        output: expect.stringContaining('Blade restarted'),
      },
    });
    expect(JSON.stringify(replay)).not.toContain('"null"');
  });

  const createPermissionsApp = async () => {
    const { BladeServerError } = await import('../../../../src/server/error.js');
    const { PermissionRoutes } = await import(
      '../../../../src/server/routes/permission.js'
    );

    const app = new Hono();
    app.onError((error, c) => {
      if (error instanceof BladeServerError) {
        return c.json(error.toObject(), error.statusCode as 400 | 404 | 409 | 500);
      }
      throw error;
    });
    app.route('/permissions', PermissionRoutes());
    return app;
  };

  const createSessionAndPermissionApp = async () => {
    const { BladeServerError } = await import('../../../../src/server/error.js');
    const { PermissionRoutes } = await import(
      '../../../../src/server/routes/permission.js'
    );
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');

    const app = new Hono();
    app.onError((error, c) => {
      if (error instanceof BladeServerError) {
        return c.json(error.toObject(), error.statusCode as 400 | 404 | 409 | 500);
      }
      throw error;
    });
    app.route('/sessions', SessionRoutes());
    app.route('/permissions', PermissionRoutes());
    return app;
  };

  const createRuntimeDouble = async (
    overrides: Partial<typeof runtimeState.runtime> & { workspaceRoot?: string } = {}
  ): Promise<SessionRuntime> => {
    const runtime = {} as SessionRuntime;
    const sessionId = overrides.sessionId ?? runtimeState.runtime.sessionId;
    const workspaceRoot = overrides.workspaceRoot ?? DEFAULT_PROJECT_PATH;
    const {
      sessionId: _ignoredSessionId,
      workspaceRoot: _ignoredWorkspaceRoot,
      ...methods
    } = {
      ...runtimeState.runtime,
      ...overrides,
    };

    Object.defineProperties(runtime, {
      sessionId: {
        configurable: true,
        get: () => sessionId,
      },
      workspaceRoot: {
        configurable: true,
        get: () => workspaceRoot,
      },
    });
    Object.assign(runtime, methods);
    return runtime;
  };

  const metadataFor = (
    sessionId: string,
    projectPath = refFor(sessionId).projectPath,
    overrides: Partial<{
      title: string;
      messageCount: number;
      firstMessageTime: string;
      lastMessageTime: string;
      hasErrors: boolean;
      rootId: string;
      parentId: string;
      relationType: 'subagent' | 'fork';
      permissionMode: SessionMetadata['permissionMode'];
    }> = {}
  ): SessionMetadata =>
    makeSessionMetadata({
      sessionId,
      projectPath,
      ...overrides,
    });

  const mockResolvedSession = (
    sessionId: string,
    options: {
      projectPath?: string;
      messages?: Message[];
      permissionMode?: SessionMetadata['permissionMode'];
    } = {}
  ) => {
    const metadata = metadataFor(sessionId, options.projectPath, {
      permissionMode: options.permissionMode,
    });
    const messages = options.messages ?? makeMessages();
    vi.mocked(SessionService.listSessions).mockResolvedValue([metadata]);
    vi.mocked(SessionService.findSessionMetadata).mockImplementation(
      async (requestedSessionId: string, requestedProjectPath?: string) => {
        if (requestedSessionId !== sessionId) {
          return undefined;
        }
        if (
          requestedProjectPath !== undefined &&
          requestedProjectPath !== metadata.projectPath
        ) {
          return undefined;
        }
        return metadata;
      }
    );
    vi.mocked(SessionService.loadSession).mockImplementation(
      async (requestedSessionId: string, requestedProjectPath?: string) => {
        if (
          requestedSessionId === sessionId &&
          requestedProjectPath === metadata.projectPath
        ) {
          return messages;
        }
        return makeMessages();
      }
    );
    return metadata;
  };

  it('returns a cursor-based public session catalog page', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');
    const metadata = metadataFor('catalog-session', '/tmp/catalog-workspace');
    vi.mocked(SessionService.listSessionPage).mockResolvedValue({
      sessions: [metadata],
      nextCursor: 'next-cursor',
    });

    const app = SessionRoutes();
    const response = await app.request(
      `/catalog?limit=25&cursor=${encodeURIComponent('current-cursor')}`
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      sessions: [metadata],
      nextCursor: 'next-cursor',
    });
    expect(SessionService.listSessionPage).toHaveBeenCalledWith({
      cursor: 'current-cursor',
      limit: 25,
      includeSubagents: false,
      archived: false,
    });
  });

  it('rejects invalid session catalog pagination input', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');
    vi.mocked(SessionService.listSessionPage).mockRejectedValue(
      new Error('Session catalog limit must be an integer from 1 to 100')
    );

    const response = await SessionRoutes().request('/catalog?limit=0');

    expect(response.status).toBe(400);
  });

  it('lists archived sessions in an independently scoped catalog', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');
    vi.mocked(SessionService.listSessionPage).mockResolvedValue({
      sessions: [],
      nextCursor: 'archived-next',
    });

    const response = await SessionRoutes().request('/catalog?archived=true&limit=10');

    expect(response.status).toBe(200);
    expect(SessionService.listSessionPage).toHaveBeenCalledWith({
      archived: true,
      includeSubagents: false,
      limit: 10,
    });
  });

  it('exports an exact active or archived session as non-cacheable Markdown', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');
    const projectPath = '/tmp/export-workspace';
    const metadata = metadataFor('export-session', projectPath, {
      title: 'Export session',
    });
    vi.mocked(SessionService.findSessionMetadata).mockImplementation(
      async (sessionId, requestedProjectPath) =>
        sessionId === metadata.sessionId && requestedProjectPath === projectPath
          ? metadata
          : undefined
    );
    vi.mocked(SessionService.exportSessionMarkdown).mockResolvedValue({
      filename: 'blade-session-export-sessi.md',
      markdown: '# Blade conversation\n\n## User\n\nhello\n',
      contentSha256: 'b'.repeat(64),
      contentBytes: 16,
      messageCount: 1,
      activityCount: 2,
      reasoningIncluded: true,
      reasoningCount: 1,
      redactionCount: 3,
    });

    const response = await SessionRoutes().request(
      `/${metadata.sessionId}/export?projectPath=${encodeURIComponent(
        projectPath
      )}&includeReasoning=true`
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/markdown');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-disposition')).toContain(
      'blade-session-export-sessi.md'
    );
    expect(response.headers.get('x-blade-content-sha256')).toBe('b'.repeat(64));
    expect(response.headers.get('x-blade-export-redactions')).toBe('3');
    await expect(response.text()).resolves.toContain('## User');
    expect(SessionService.exportSessionMarkdown).toHaveBeenCalledWith(
      metadata.sessionId,
      projectPath,
      { includeReasoning: true }
    );
  });

  it('validates export visibility and maps empty conversations to conflict', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');
    const invalid = await SessionRoutes().request(
      '/missing/export?includeReasoning=maybe'
    );
    expect(invalid.status).toBe(400);

    const projectPath = '/tmp/export-empty';
    const metadata = metadataFor('export-empty', projectPath);
    vi.mocked(SessionService.findSessionMetadata).mockResolvedValue(metadata);
    vi.mocked(SessionService.exportSessionMarkdown).mockRejectedValueOnce(
      new Error('No conversation content to export')
    );
    const empty = await SessionRoutes().request(
      `/${metadata.sessionId}/export?projectPath=${encodeURIComponent(projectPath)}`
    );
    expect(empty.status).toBe(409);
  });

  it('archives and restores an inactive session tree through exact workspace routes', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');
    const projectPath = '/tmp/archive-workspace';
    const root = metadataFor('archive-root', projectPath);
    const child = metadataFor('archive-child', projectPath, {
      rootId: root.sessionId,
      parentId: root.sessionId,
      relationType: 'fork',
    });
    vi.mocked(SessionService.findSessionMetadata).mockImplementation(
      async (sessionId, requestedProjectPath) =>
        requestedProjectPath === projectPath && sessionId === root.sessionId
          ? root
          : undefined
    );
    vi.mocked(SessionService.listSessionArchiveMembers).mockResolvedValue([
      root,
      child,
    ]);
    vi.mocked(SessionService.archiveSession).mockResolvedValue({
      ...root,
      archivedAt: '2026-08-09T00:00:00.000Z',
      archivedBySessionId: root.sessionId,
    });
    vi.mocked(SessionService.unarchiveSession).mockResolvedValue(root);

    const app = SessionRoutes();
    const archiveResponse = await app.request(
      `/${root.sessionId}/archive?projectPath=${encodeURIComponent(projectPath)}`,
      { method: 'POST' }
    );
    expect(archiveResponse.status).toBe(200);
    await expect(archiveResponse.json()).resolves.toMatchObject({
      session: {
        sessionId: root.sessionId,
        archivedBySessionId: root.sessionId,
      },
      archivedSessionIds: [root.sessionId, child.sessionId],
    });
    expect(SessionService.archiveSession).toHaveBeenCalledWith(
      root.sessionId,
      projectPath
    );
    expect(busState.publish).toHaveBeenCalledWith(
      { sessionId: child.sessionId, projectPath },
      'session.archived',
      expect.objectContaining({ archiveRootId: root.sessionId })
    );

    const unarchiveResponse = await app.request(
      `/${root.sessionId}/unarchive?projectPath=${encodeURIComponent(projectPath)}`,
      { method: 'POST' }
    );
    expect(unarchiveResponse.status).toBe(200);
    expect(SessionService.unarchiveSession).toHaveBeenCalledWith(
      root.sessionId,
      projectPath
    );
  });

  it('reuses one SessionRuntime for repeated messages in the same session', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');
    const { SessionRuntime } = await import(
      '../../../../src/agent/runtime/SessionRuntime.js'
    );
    const { Agent } = await import('../../../../src/agent/Agent.js');
    mockResolvedSession('session-1');

    const app = SessionRoutes();

    const sendMessage = async (content: string) => {
      const response = await app.request('/session-1/message', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content }),
      });

      expect(response.status).toBe(202);
      await new Promise((resolve) => setTimeout(resolve, 0));
    };

    await sendMessage('first');
    await sendMessage('second');

    expect(SessionRuntime.create).toHaveBeenCalledTimes(1);
    expect(SessionRuntime.create).toHaveBeenCalledWith({
      sessionId: 'session-1',
      workspaceRoot: expect.any(String),
      permissionMode: PermissionMode.DEFAULT,
    });
    expect(runtimeState.runtime.prepareInputTurn).toHaveBeenNthCalledWith(1, 'first');
    expect(runtimeState.runtime.prepareInputTurn).toHaveBeenNthCalledWith(2, 'second');
    expect(Agent.createWithRuntime).toHaveBeenCalledTimes(2);
    expect(vi.mocked(Agent.createWithRuntime).mock.calls[0]?.[0]).toMatchObject({
      sessionId: 'session-1',
    });
    expect(vi.mocked(Agent.createWithRuntime).mock.calls[0]?.[1]).toEqual({
      sessionId: 'session-1',
    });
    expect(vi.mocked(Agent.createWithRuntime).mock.calls[1]?.[0]).toMatchObject({
      sessionId: 'session-1',
    });
    expect(vi.mocked(Agent.createWithRuntime).mock.calls[1]?.[1]).toEqual({
      sessionId: 'session-1',
    });
  });

  it('rejects a second Session while the only resident Runtime is active', async () => {
    const { createSessionRouteController } = await import(
      '../../../../src/server/routes/session.js'
    );
    runtimeResidencyConfig.maxResident = 1;
    const metadata = [
      metadataFor('resident-active-a', '/tmp/residency'),
      metadataFor('resident-active-b', '/tmp/residency'),
    ];
    vi.mocked(SessionService.listSessions).mockResolvedValue(metadata);
    vi.mocked(SessionService.findSessionMetadata).mockImplementation(
      async (sessionId, projectPath) =>
        metadata.find(
          (candidate) =>
            candidate.sessionId === sessionId && candidate.projectPath === projectPath
        )
    );
    let releaseRun!: () => void;
    const runGate = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    agentState.chatStream.mockImplementationOnce(async function* () {
      if (Date.now() < 0) yield undefined;
      await runGate;
      return {
        success: true,
        finalMessage: 'resident A complete',
        metadata: { turnsCount: 1, toolCallsCount: 0, duration: 0 },
      };
    });
    const controller = createSessionRouteController();

    const first = await controller.app.request(
      '/resident-active-a/message?projectPath=%2Ftmp%2Fresidency',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'hold resident A' }),
      }
    );
    expect(first.status).toBe(202);
    const second = await controller.app.request(
      '/resident-active-b/message?projectPath=%2Ftmp%2Fresidency',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'must not initialize B' }),
      }
    );

    expect(second.status).toBe(429);
    await expect(second.json()).resolves.toEqual({
      error: {
        code: 'TOO_MANY_REQUESTS',
        message: 'Session runtime capacity is full',
        details: {
          resource: 'resident_runtimes',
          limit: 1,
        },
      },
    });
    expect(SessionRuntime.create).toHaveBeenCalledTimes(1);
    expect(controller.getRuntimeResidencyStats()).toEqual({
      resident: 1,
      reserved: 0,
      pinned: 1,
      maxResident: 1,
    });

    releaseRun();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await controller.shutdown();
  });

  it('evicts the idle LRU Runtime and cold-rehydrates durable history', async () => {
    const { createSessionRouteController } = await import(
      '../../../../src/server/routes/session.js'
    );
    runtimeResidencyConfig.maxResident = 1;
    const metadata = [
      metadataFor('resident-idle-a', '/tmp/residency'),
      metadataFor('resident-idle-b', '/tmp/residency'),
    ];
    vi.mocked(SessionService.listSessions).mockResolvedValue(metadata);
    vi.mocked(SessionService.findSessionMetadata).mockImplementation(
      async (sessionId, projectPath) =>
        metadata.find(
          (candidate) =>
            candidate.sessionId === sessionId && candidate.projectPath === projectPath
        )
    );
    const controller = createSessionRouteController();
    const send = async (sessionId: string, content: string) => {
      const response = await controller.app.request(
        `/${sessionId}/message?projectPath=%2Ftmp%2Fresidency`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content }),
        }
      );
      expect(response.status).toBe(202);
      await new Promise((resolve) => setTimeout(resolve, 0));
    };

    await send('resident-idle-a', 'first A turn');
    await send('resident-idle-b', 'first B turn');
    await send('resident-idle-a', 'cold A follow-up');

    expect(SessionRuntime.create).toHaveBeenCalledTimes(3);
    expect(runtimeState.runtime.dispose).toHaveBeenCalledTimes(2);
    expect(SessionService.loadSession).toHaveBeenCalledWith(
      'resident-idle-a',
      '/tmp/residency'
    );
    expect(controller.getRuntimeResidencyStats()).toEqual({
      resident: 1,
      reserved: 0,
      pinned: 0,
      maxResident: 1,
    });
    expect(controller.getCoordinationStats()).toEqual({
      messageSubmissions: { keys: 0, operations: 0 },
      taskDeliveries: { keys: 0, operations: 0 },
    });
    await controller.shutdown();
  });

  it('reclaims high-cardinality message and task-delivery coordination keys', async () => {
    const { createSessionRouteController } = await import(
      '../../../../src/server/routes/session.js'
    );
    const projectPath = '/tmp/coordination-churn';
    const metadata = Array.from({ length: 32 }, (_, index) =>
      metadataFor(`coordination-${index}`, projectPath)
    );
    vi.mocked(SessionService.listSessions).mockResolvedValue(metadata);
    vi.mocked(SessionService.findSessionMetadata).mockImplementation(
      async (sessionId, requestedProjectPath) =>
        requestedProjectPath === projectPath
          ? metadata.find((candidate) => candidate.sessionId === sessionId)
          : undefined
    );
    const controller = createSessionRouteController();

    for (const session of metadata) {
      const response = await controller.app.request(
        `/${session.sessionId}/message?projectPath=${encodeURIComponent(projectPath)}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content: `message ${session.sessionId}` }),
        }
      );
      expect(response.status).toBe(202);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(controller.getCoordinationStats().messageSubmissions).toEqual({
        keys: 0,
        operations: 0,
      });
    }

    for (const session of metadata) {
      await expect(
        controller.deliverTask(session.sessionId, 'apply', projectPath)
      ).rejects.toMatchObject({
        code: 'CONFLICT',
        message: 'Task worktree is unavailable',
      });
      expect(controller.getCoordinationStats().taskDeliveries).toEqual({
        keys: 0,
        operations: 0,
      });
    }

    await controller.shutdown();
  });

  it('routes a second message into the active turn instead of starting a concurrent run', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');
    const { Agent } = await import('../../../../src/agent/Agent.js');
    const { Bus } = await import('../../../../src/server/bus.js');
    mockResolvedSession('steering-session');
    let releaseRun: () => void = () => undefined;
    const runGate = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    agentState.chatStream.mockImplementationOnce(async function* () {
      yield { kind: 'turn_start', turn: 1, maxTurns: 10 };
      await runGate;
      return {
        success: true,
        finalMessage: 'steered reply',
        metadata: { turnsCount: 1, toolCallsCount: 0, duration: 0 },
      };
    });

    const app = SessionRoutes();
    const first = await app.request('/steering-session/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'initial request' }),
    });
    expect(first.status).toBe(202);
    await vi.waitFor(() => {
      expect(Bus.publish).toHaveBeenCalledWith(
        refFor('steering-session'),
        'turn.started',
        expect.any(Object)
      );
    });

    const second = await app.request('/steering-session/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'updated requirement' }),
    });

    expect(second.status).toBe(202);
    expect(await second.json()).toMatchObject({
      status: 'steering_queued',
      queued: 1,
    });
    expect(runtimeState.runtime.enqueueSteering).toHaveBeenCalledWith(
      'updated requirement',
      { allowBeforeTurn: true }
    );
    expect(Agent.createWithRuntime).toHaveBeenCalledTimes(1);
    expect(Bus.publish).toHaveBeenCalledWith(
      refFor('steering-session'),
      'steering.queued',
      expect.objectContaining({ queued: 1 })
    );

    runtimeState.runtime.getPendingSteeringCount.mockReturnValue(1);
    runtimeState.runtime.hasActiveTurn.mockReturnValue(true);
    runtimeState.runtime.getRecoveredSteeringCount.mockReturnValue(1);
    const eventsAbort = new AbortController();
    const events = await app.request('/steering-session/events', {
      signal: eventsAbort.signal,
    });
    const collector = createSseCollector(events);
    expect(await collector.next()).toMatchObject({
      type: 'connected',
      properties: {
        status: 'running',
        runId: expect.any(String),
        queued: 1,
        pendingInputDelivery: 'current_turn',
        recovered: 1,
      },
    });
    eventsAbort.abort();
    await collector.cancel();

    releaseRun();
    await vi.waitFor(() => {
      expect(Bus.publish).toHaveBeenCalledWith(
        refFor('steering-session'),
        'session.completed',
        expect.any(Object)
      );
    });
  });

  it('rejects changing models while a turn is active', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');
    const { Bus } = await import('../../../../src/server/bus.js');
    mockResolvedSession('active-model-session');
    let releaseRun: () => void = () => undefined;
    const runGate = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    agentState.chatStream.mockImplementationOnce(async function* () {
      yield { kind: 'turn_start', turn: 1, maxTurns: 10 };
      await runGate;
      return {
        success: true,
        finalMessage: 'done',
        metadata: { turnsCount: 1, toolCallsCount: 0, duration: 0 },
      };
    });

    const app = SessionRoutes();
    const first = await app.request('/active-model-session/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'start with model one' }),
    });
    expect(first.status).toBe(202);
    await vi.waitFor(() => {
      expect(Bus.publish).toHaveBeenCalledWith(
        refFor('active-model-session'),
        'turn.started',
        expect.any(Object)
      );
    });

    modelState.current = {
      id: 'model-2',
      provider: 'openai',
      model: 'gpt-4.1',
    };
    runtimeState.runtime.getCurrentModelId.mockReturnValueOnce('model-1');
    const second = await app.request('/active-model-session/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: 'switch too early',
        modelId: 'model-2',
      }),
    });

    expect(second.status).toBe(409);
    await expect(second.json()).resolves.toMatchObject({
      error: {
        message: 'Wait for the active turn to finish before switching models',
      },
    });
    expect(runtimeState.runtime.enqueueSteering).not.toHaveBeenCalled();

    const effortSwitch = await app.request('/active-model-session/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: 'switch effort too early',
        reasoningEffort: 'low',
      }),
    });
    expect(effortSwitch.status).toBe(409);
    await expect(effortSwitch.json()).resolves.toMatchObject({
      error: {
        message: 'Wait for the active turn to finish before switching reasoning effort',
      },
    });

    const tierSwitch = await app.request('/active-model-session/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: 'switch service tier too early',
        serviceTier: 'fast',
      }),
    });
    expect(tierSwitch.status).toBe(409);
    await expect(tierSwitch.json()).resolves.toMatchObject({
      error: {
        message: 'Wait for the active turn to finish before switching service tier',
      },
    });

    const verbositySwitch = await app.request('/active-model-session/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: 'switch response verbosity too early',
        responseVerbosity: 'high',
      }),
    });
    expect(verbositySwitch.status).toBe(409);
    await expect(verbositySwitch.json()).resolves.toMatchObject({
      error: {
        message:
          'Wait for the active turn to finish before switching response verbosity',
      },
    });

    const styleSwitch = await app.request('/active-model-session/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: 'switch communication style too early',
        communicationStyle: 'friendly',
      }),
    });
    expect(styleSwitch.status).toBe(409);
    await expect(styleSwitch.json()).resolves.toMatchObject({
      error: {
        message:
          'Wait for the active turn to finish before switching communication style',
      },
    });

    releaseRun();
    await vi.waitFor(() => {
      expect(Bus.publish).toHaveBeenCalledWith(
        refFor('active-model-session'),
        'session.completed',
        expect.any(Object)
      );
    });
  });

  it('defers input submitted after the active turn seals', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');
    const { Bus } = await import('../../../../src/server/bus.js');
    mockResolvedSession('follow-up-session');
    let releaseRun: () => void = () => undefined;
    const runGate = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    agentState.chatStream.mockImplementationOnce(async function* () {
      yield { kind: 'turn_start', turn: 1, maxTurns: 10 };
      await runGate;
      return {
        success: true,
        finalMessage: 'first reply',
        metadata: { turnsCount: 1, toolCallsCount: 0, duration: 0 },
      };
    });

    const app = SessionRoutes();
    await app.request('/follow-up-session/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'initial request' }),
    });
    await vi.waitFor(() => {
      expect(Bus.publish).toHaveBeenCalledWith(
        refFor('follow-up-session'),
        'turn.started',
        expect.any(Object)
      );
    });
    runtimeState.runtime.enqueueSteering.mockResolvedValueOnce({
      accepted: true,
      turnId: 'turn-1',
      queued: 1,
      delivery: 'next_turn',
    });

    const response = await app.request('/follow-up-session/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'run after this answer' }),
    });

    expect(await response.json()).toMatchObject({
      status: 'follow_up_queued',
      queued: 1,
    });
    expect(Bus.publish).toHaveBeenCalledWith(
      refFor('follow-up-session'),
      'follow_up.queued',
      expect.objectContaining({ queued: 1 })
    );
    runtimeState.runtime.getPendingSteeringCount
      .mockReturnValueOnce(1)
      .mockReturnValue(0);
    releaseRun();
    await vi.waitFor(() => {
      expect(agentState.chatStream).toHaveBeenCalledTimes(2);
      expect(agentState.chatStream).toHaveBeenLastCalledWith(
        '',
        expect.any(Object),
        expect.objectContaining({ pendingInputOnly: true })
      );
    });
  });

  it('serializes concurrent startup input behind one durable runtime preparation', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');
    const { SessionRuntime } = await import(
      '../../../../src/agent/runtime/SessionRuntime.js'
    );
    mockResolvedSession('startup-steering');
    let releaseRuntime: () => void = () => undefined;
    vi.mocked(SessionRuntime.create).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseRuntime = async () => resolve(await createRuntimeDouble());
        })
    );
    let releaseRun: () => void = () => undefined;
    const runGate = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    agentState.chatStream.mockImplementationOnce(async function* () {
      yield { kind: 'turn_start', turn: 1, maxTurns: 10 };
      await runGate;
      return {
        success: true,
        finalMessage: 'started',
        metadata: { turnsCount: 1, toolCallsCount: 0, duration: 0 },
      };
    });

    const app = SessionRoutes();
    let firstSettled = false;
    const firstPromise = Promise.resolve(
      app.request('/startup-steering/message', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'initial request' }),
      })
    ).then((response) => {
      firstSettled = true;
      return response;
    });

    let secondSettled = false;
    const secondPromise = Promise.resolve(
      app.request('/startup-steering/message', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'guidance during startup' }),
      })
    ).then((response) => {
      secondSettled = true;
      return response;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(firstSettled).toBe(false);
    expect(secondSettled).toBe(false);

    releaseRuntime();
    const first = await firstPromise;
    const second = await secondPromise;
    expect(first.status).toBe(202);
    expect(await first.json()).toMatchObject({
      status: 'running',
      messageId: 'prepared-input',
    });
    expect(second.status).toBe(202);
    expect(await second.json()).toMatchObject({
      status: 'steering_queued',
      queued: 1,
    });
    expect(SessionRuntime.create).toHaveBeenCalledTimes(1);
    expect(runtimeState.runtime.enqueueSteering).toHaveBeenCalledWith(
      'guidance during startup',
      { allowBeforeTurn: true }
    );
    releaseRun();
  });

  it('does not return 202 until the initial input has been durably prepared', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');
    const { SessionRuntime } = await import(
      '../../../../src/agent/runtime/SessionRuntime.js'
    );
    mockResolvedSession('durable-accept');
    vi.mocked(SessionRuntime.create).mockResolvedValueOnce(
      await createRuntimeDouble({ sessionId: 'durable-accept' })
    );
    let releasePreparation: () => void = () => undefined;
    runtimeState.runtime.prepareInputTurn.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releasePreparation = () =>
            resolve({
              accepted: true,
              handle: { id: 'fsynced-turn' },
              messageId: 'fsynced-input',
              queued: 1,
              mode: 'direct',
            } satisfies InputTurnPreparation);
        })
    );

    const app = SessionRoutes();
    let settled = false;
    const responsePromise = Promise.resolve(
      app.request('/durable-accept/message', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'persist before accepting' }),
      })
    ).then((response) => {
      settled = true;
      return response;
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);
    expect(agentState.chatStream).not.toHaveBeenCalled();

    releasePreparation();
    const response = await responsePromise;
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      status: 'running',
      messageId: 'fsynced-input',
    });
  });

  it('wakes a persisted durable follow-up when Web SSE reconnects', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');
    const { Agent } = await import('../../../../src/agent/Agent.js');
    const { SessionService } = await import(
      '../../../../src/services/SessionService.js'
    );
    const recoveredMetadata = metadataFor(
      'recovered-web-session',
      '/persisted-workspace',
      { permissionMode: 'yolo' }
    );
    vi.mocked(SessionService.listSessions).mockResolvedValue([recoveredMetadata]);
    vi.mocked(SessionService.findSessionMetadata).mockImplementation(
      async (sessionId: string, projectPath?: string) => {
        if (
          sessionId === 'recovered-web-session' &&
          projectPath === '/persisted-workspace'
        ) {
          return recoveredMetadata;
        }
        return undefined;
      }
    );
    vi.mocked(SessionRuntime.hasPendingInbox).mockResolvedValue(true);
    runtimeState.runtime.getPendingSteeringCount.mockReturnValue(1);
    let releaseRun: () => void = () => undefined;
    const runGate = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    agentState.chatStream.mockImplementationOnce(async function* () {
      yield { kind: 'turn_start', turn: 1, maxTurns: 10 };
      await runGate;
      return {
        success: true,
        finalMessage: 'recovered',
        metadata: { turnsCount: 1, toolCallsCount: 0, duration: 0 },
      };
    });

    const firstController = new AbortController();
    const secondController = new AbortController();
    const app = SessionRoutes();
    const [firstResponse, secondResponse] = await Promise.all([
      app.request('/recovered-web-session/events', {
        signal: firstController.signal,
      }),
      app.request('/recovered-web-session/events', {
        signal: secondController.signal,
      }),
    ]);
    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);

    await vi.waitFor(() => {
      expect(agentState.chatStream).toHaveBeenCalledWith(
        '',
        expect.objectContaining({
          sessionId: 'recovered-web-session',
          workspaceRoot: '/persisted-workspace',
          permissionMode: PermissionMode.YOLO,
        }),
        expect.objectContaining({ pendingInputOnly: true })
      );
    });
    expect(Agent.createWithRuntime).toHaveBeenCalledTimes(1);

    releaseRun();
    firstController.abort();
    secondController.abort();
    await Promise.all([
      firstResponse.body?.cancel().catch(() => undefined),
      secondResponse.body?.cancel().catch(() => undefined),
    ]);
  });

  it('wakes an idle Web parent when a background completion is durably queued', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');
    const { Bus } = await import('../../../../src/server/bus.js');
    const recoveredMetadata = metadataFor(
      'background-web-session',
      '/background-workspace',
      { permissionMode: 'yolo' }
    );
    vi.mocked(SessionService.listSessions).mockResolvedValue([recoveredMetadata]);
    vi.mocked(SessionService.findSessionMetadata).mockImplementation(
      async (sessionId: string, projectPath?: string) =>
        sessionId === 'background-web-session' &&
        projectPath === '/background-workspace'
          ? recoveredMetadata
          : undefined
    );
    vi.mocked(SessionRuntime.hasPendingInbox).mockResolvedValue(false);
    runtimeState.runtime.getPendingSteeringCount.mockReturnValue(0);

    const controller = new AbortController();
    const app = SessionRoutes();
    const response = await app.request('/background-web-session/events', {
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    await Promise.resolve();
    expect(agentState.chatStream).not.toHaveBeenCalled();

    vi.mocked(SessionRuntime.hasPendingInbox).mockResolvedValue(true);
    runtimeState.runtime.getPendingSteeringCount.mockReturnValue(1);
    Bus.publish(
      {
        sessionId: 'background-web-session',
        projectPath: '/background-workspace',
      },
      'subagent.completion.queued',
      {
        childSessionId: 'agent-background-web',
        inboxMessageId: 'background-subagent-completion:agent-background-web',
        status: 'completed',
        queued: 1,
        delivery: 'next_turn',
      }
    );

    await vi.waitFor(() => {
      expect(agentState.chatStream).toHaveBeenCalledWith(
        '',
        expect.objectContaining({
          sessionId: 'background-web-session',
          workspaceRoot: '/background-workspace',
          permissionMode: PermissionMode.YOLO,
        }),
        expect.objectContaining({ pendingInputOnly: true })
      );
    });

    controller.abort();
    await response.body?.cancel().catch(() => undefined);
  });

  it('does not start a Goal run after Runtime startup finalizes its durable handoff', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');
    const { SessionService } = await import(
      '../../../../src/services/SessionService.js'
    );
    const recoveredMetadata = metadataFor(
      'goal-handoff-web-session',
      '/goal-handoff-workspace',
      { permissionMode: 'yolo' }
    );
    vi.mocked(SessionService.listSessions).mockResolvedValue([recoveredMetadata]);
    vi.mocked(SessionService.findSessionMetadata).mockImplementation(
      async (sessionId: string, projectPath?: string) =>
        sessionId === recoveredMetadata.sessionId &&
        projectPath === recoveredMetadata.projectPath
          ? recoveredMetadata
          : undefined
    );
    vi.mocked(SessionRuntime.hasPendingInbox).mockResolvedValue(false);
    vi.mocked(SessionRuntime.hasActiveGoal).mockResolvedValue(true);
    runtimeState.runtime.getPendingSteeringCount.mockReturnValue(0);
    runtimeState.runtime.getGoal.mockResolvedValue({
      status: 'complete',
      goalId: 'goal-handoff-complete',
    });

    const controller = new AbortController();
    const app = SessionRoutes();
    const response = await app.request(
      `/goal-handoff-web-session/events?projectPath=${encodeURIComponent(
        recoveredMetadata.projectPath
      )}`,
      { signal: controller.signal }
    );
    expect(response.status).toBe(200);
    await vi.waitFor(() => {
      expect(SessionRuntime.create).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: recoveredMetadata.sessionId,
          workspaceRoot: recoveredMetadata.projectPath,
        })
      );
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(agentState.chatStream).not.toHaveBeenCalled();
    controller.abort();
    await response.body?.cancel().catch(() => undefined);
  });

  it('does not wake residual inbox input for a terminal task on Web SSE reconnect', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');
    const terminalMetadata = makeSessionMetadata({
      sessionId: 'cancelled-web-task',
      projectPath: '/cancelled-task-workspace',
      taskStatus: 'cancelled',
      taskStatusReason: 'user-cancel',
      taskCompletedAt: new Date().toISOString(),
      taskIsolation: 'local',
      taskSourceProjectPath: '/task-source',
    });
    vi.mocked(SessionService.listSessions).mockResolvedValue([terminalMetadata]);
    vi.mocked(SessionService.findSessionMetadata).mockResolvedValue(terminalMetadata);
    runtimeState.runtime.getPendingSteeringCount.mockReturnValue(1);

    const controller = new AbortController();
    const response = await SessionRoutes().request('/cancelled-web-task/events', {
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(agentState.chatStream).not.toHaveBeenCalled();

    controller.abort();
    await response.body?.cancel().catch(() => undefined);
  });

  it('builds multimodal user content from image attachments', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');
    mockResolvedSession('session-2');

    const app = SessionRoutes();

    const response = await app.request('/session-2/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: 'describe this image',
        attachments: [{ type: 'image', content: 'data:image/png;base64,abc' }],
      }),
    });

    expect(response.status).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(agentState.chatStream).toHaveBeenCalledWith(
      [
        { type: 'text', text: 'describe this image' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
      ],
      expect.any(Object),
      expect.any(Object)
    );
  });

  it('builds image-only user content when the request only contains image attachments', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');
    mockResolvedSession('session-3');

    const app = SessionRoutes();

    const response = await app.request('/session-3/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: '',
        attachments: [{ type: 'image', content: 'data:image/png;base64,image-only' }],
      }),
    });

    expect(response.status).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(agentState.chatStream).toHaveBeenCalledWith(
      [{ type: 'image_url', image_url: { url: 'data:image/png;base64,image-only' } }],
      expect.any(Object),
      expect.any(Object)
    );
  });

  it('validates and durably prepares a turn-scoped output schema', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');
    mockResolvedSession('structured-session');
    const outputSchema = {
      type: 'object',
      properties: { answer: { type: 'string' } },
      required: ['answer'],
      additionalProperties: false,
    };

    const response = await SessionRoutes().request('/structured-session/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: 'return a structured answer',
        outputSchema,
      }),
    });

    expect(response.status).toBe(202);
    expect(runtimeState.runtime.prepareInputTurn).toHaveBeenCalledWith(
      'return a structured answer',
      { outputSchema }
    );
    await vi.waitFor(() => {
      expect(agentState.chatStream).toHaveBeenCalledWith(
        'return a structured answer',
        expect.any(Object),
        expect.objectContaining({ outputSchema })
      );
    });
  });

  it('rejects an invalid output schema before preparing durable input', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');
    mockResolvedSession('invalid-structured-session');

    const response = await SessionRoutes().request(
      '/invalid-structured-session/message',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          content: 'return a structured answer',
          outputSchema: {
            type: 'object',
            properties: {
              answer: { $ref: 'https://example.com/remote.json' },
            },
          },
        }),
      }
    );

    expect(response.status).toBe(400);
    expect(runtimeState.runtime.prepareInputTurn).not.toHaveBeenCalled();
    expect(agentState.chatStream).not.toHaveBeenCalled();
  });

  it('hides the reserved structured-output tool from client history', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');
    mockResolvedSession('structured-history-session');
    vi.mocked(SessionService.loadSession).mockResolvedValue([
      {
        role: 'user',
        content: 'hidden control',
        metadata: { clientVisible: false },
      },
      {
        role: 'user',
        content:
          'This turn made a non-trivial implementation. Before finishing, call Task ' +
          'with subagent_type="verification". Only a fresh structured PASS verdict ' +
          'allows completion.',
      },
      { role: 'user', content: 'return structured output' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'structured-call',
            type: 'function',
            function: {
              name: 'StructuredOutput',
              arguments: '{"answer":"done"}',
            },
          },
        ],
      },
      {
        role: 'tool',
        name: 'StructuredOutput',
        tool_call_id: 'structured-call',
        content: 'Structured output accepted.',
      },
      {
        role: 'assistant',
        content: '{"answer":"done"}',
        metadata: {
          structuredOutput: {
            output: { answer: 'done' },
            schemaDigest: 'a'.repeat(64),
          },
        },
      },
    ]);

    const response = await SessionRoutes().request(
      '/structured-history-session/message'
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([
      { role: 'user', content: 'return structured output' },
      {
        role: 'assistant',
        content: '{"answer":"done"}',
        metadata: {
          structuredOutput: {
            output: { answer: 'done' },
            schemaDigest: 'a'.repeat(64),
          },
        },
      },
    ]);
  });

  it('refreshes an idle session runtime to the model selected for the message', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');
    mockResolvedSession('model-selected-session');
    modelState.current = {
      id: 'model-2',
      provider: 'openai',
      model: 'gpt-4.1',
    };

    const app = SessionRoutes();
    const response = await app.request('/model-selected-session/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: 'use the selected model',
        modelId: 'model-2',
      }),
    });

    expect(response.status).toBe(202);
    expect(runtimeState.runtime.refresh).toHaveBeenCalledWith({
      modelId: 'model-2',
    });
    expect(SessionService.updateSessionMetadata).toHaveBeenCalledWith(
      'model-selected-session',
      expect.any(String),
      { selectedModelId: 'model-2' }
    );
    expect(runtimeState.runtime.prepareInputTurn).toHaveBeenCalledWith(
      'use the selected model'
    );
  });

  it('validates, persists, and publishes an idle Session reasoning switch', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');
    mockResolvedSession('reasoning-selected-session');

    const response = await SessionRoutes().request(
      '/reasoning-selected-session/message',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          content: 'use low reasoning',
          reasoningEffort: 'low',
        }),
      }
    );

    expect(response.status).toBe(202);
    expect(runtimeState.runtime.resolveReasoningConfiguration).toHaveBeenCalledWith(
      'low',
      undefined
    );
    expect(runtimeState.runtime.refresh).toHaveBeenCalledWith({
      reasoningEffort: 'low',
    });
    expect(SessionService.updateSessionMetadata).toHaveBeenCalledWith(
      'reasoning-selected-session',
      expect.any(String),
      { reasoningEffort: 'low' }
    );
    expect(busState.publish).toHaveBeenCalledWith(
      refFor('reasoning-selected-session'),
      'session.updated',
      { reasoningEffort: 'low' }
    );
  });

  it('validates, persists, and publishes an idle Session service-tier switch', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');
    mockResolvedSession('tier-selected-session');

    const response = await SessionRoutes().request('/tier-selected-session/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: 'use the priority provider tier',
        serviceTier: 'fast',
      }),
    });

    expect(response.status).toBe(202);
    expect(runtimeState.runtime.resolveServiceTierConfiguration).toHaveBeenCalledWith(
      'fast',
      undefined
    );
    expect(runtimeState.runtime.refresh).toHaveBeenCalledWith({
      serviceTier: 'fast',
    });
    expect(SessionService.updateSessionMetadata).toHaveBeenCalledWith(
      'tier-selected-session',
      expect.any(String),
      { serviceTier: 'fast' }
    );
    expect(busState.publish).toHaveBeenCalledWith(
      refFor('tier-selected-session'),
      'session.updated',
      { serviceTier: 'fast' }
    );
  });

  it('validates, persists, and publishes an idle Session response-verbosity switch', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');
    mockResolvedSession('verbosity-selected-session');

    const response = await SessionRoutes().request(
      '/verbosity-selected-session/message',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          content: 'use detailed responses',
          responseVerbosity: 'high',
        }),
      }
    );

    expect(response.status).toBe(202);
    expect(
      runtimeState.runtime.resolveResponseVerbosityConfiguration
    ).toHaveBeenCalledWith('high', undefined);
    expect(runtimeState.runtime.refresh).toHaveBeenCalledWith({
      responseVerbosity: 'high',
    });
    expect(SessionService.updateSessionMetadata).toHaveBeenCalledWith(
      'verbosity-selected-session',
      expect.any(String),
      { responseVerbosity: 'high' }
    );
    expect(busState.publish).toHaveBeenCalledWith(
      refFor('verbosity-selected-session'),
      'session.updated',
      { responseVerbosity: 'high' }
    );
  });

  it('validates, persists, and publishes an idle Session communication-style switch', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');
    mockResolvedSession('style-selected-session');

    const response = await SessionRoutes().request('/style-selected-session/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: 'use an explanatory communication style',
        communicationStyle: 'explanatory',
      }),
    });

    expect(response.status).toBe(202);
    expect(
      runtimeState.runtime.resolveCommunicationStyleConfiguration
    ).toHaveBeenCalledWith('explanatory');
    expect(runtimeState.runtime.refresh).toHaveBeenCalledWith({
      communicationStyle: 'explanatory',
    });
    expect(SessionService.updateSessionMetadata).toHaveBeenCalledWith(
      'style-selected-session',
      expect.any(String),
      { communicationStyle: 'explanatory' }
    );
    expect(busState.publish).toHaveBeenCalledWith(
      refFor('style-selected-session'),
      'session.updated',
      { communicationStyle: 'explanatory' }
    );
  });

  it('rolls back an idle runtime switch when the selected model cannot be persisted', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');
    mockResolvedSession('model-persistence-failure');
    modelState.current = {
      id: 'model-2',
      provider: 'openai',
      model: 'gpt-4.1',
    };
    runtimeState.runtime.getCurrentModelId.mockReturnValueOnce('model-1');
    vi.mocked(SessionService.updateSessionMetadata).mockRejectedValueOnce(
      new Error('disk unavailable')
    );

    const response = await SessionRoutes().request(
      '/model-persistence-failure/message',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          content: 'do not accept a volatile model switch',
          modelId: 'model-2',
        }),
      }
    );

    expect(response.status).toBe(500);
    expect(runtimeState.runtime.refresh).toHaveBeenNthCalledWith(1, {
      modelId: 'model-2',
    });
    expect(runtimeState.runtime.refresh).toHaveBeenNthCalledWith(2, {
      modelId: 'model-1',
      reasoningEffort: 'off',
      serviceTier: 'auto',
      responseVerbosity: 'auto',
      communicationStyle: 'auto',
    });
    expect(runtimeState.runtime.prepareInputTurn).not.toHaveBeenCalled();
  });

  it('rejects message attachments above the shared inline budget', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');
    mockResolvedSession('oversized-message-session');
    const halfBudget = 'x'.repeat(Math.floor(MAX_INLINE_ATTACHMENT_BYTES / 2) + 1);

    const response = await SessionRoutes().request(
      '/oversized-message-session/message',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          content: 'inspect these screenshots',
          attachments: [
            { type: 'image', content: halfBudget },
            { type: 'image', content: halfBudget },
          ],
        }),
      }
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        message: 'Message attachments exceed the 5 MiB limit',
      },
    });
    expect(agentState.chatStream).not.toHaveBeenCalled();
  });

  it('hydrates persisted session history before sending a follow-up message', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');
    mockResolvedSession('persisted-session', {
      projectPath: '/persisted-workspace',
      messages: makeMessages(
        { role: 'user', content: 'earlier question' },
        { role: 'assistant', content: 'earlier answer' }
      ),
    });
    vi.mocked(SessionService.loadSession).mockResolvedValue(
      makeMessages(
        { role: 'user', content: 'earlier question' },
        { role: 'assistant', content: 'earlier answer' }
      )
    );

    const app = SessionRoutes();

    const response = await app.request('/persisted-session/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'follow up' }),
    });

    expect(response.status).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(SessionService.loadSession).toHaveBeenCalledWith(
      'persisted-session',
      '/persisted-workspace'
    );
    expect(agentState.chatStream.mock.calls[0]?.[1]).toMatchObject({
      messages: [
        { role: 'user', content: 'earlier question' },
        { role: 'assistant', content: 'earlier answer' },
      ],
    });
  });

  it('restores the persisted permission mode when a cold follow-up omits it', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');
    mockResolvedSession('persisted-mode', {
      projectPath: '/persisted-mode-workspace',
      permissionMode: 'yolo',
    });

    const response = await SessionRoutes().request('/persisted-mode/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'continue with the frozen policy' }),
    });

    expect(response.status).toBe(202);
    await vi.waitFor(() => {
      expect(agentState.chatStream).toHaveBeenCalledWith(
        'continue with the frozen policy',
        expect.objectContaining({
          permissionMode: PermissionMode.YOLO,
        }),
        expect.any(Object)
      );
    });
    expect(SessionService.updateSessionMetadata).not.toHaveBeenCalledWith(
      'persisted-mode',
      '/persisted-mode-workspace',
      expect.objectContaining({ permissionMode: expect.anything() })
    );
  });

  it('persists an explicit permission override before preparing the next turn', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');
    mockResolvedSession('override-mode', {
      projectPath: '/override-mode-workspace',
      permissionMode: 'yolo',
    });

    const response = await SessionRoutes().request('/override-mode/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: 'continue under automatic edits only',
        permissionMode: 'autoEdit',
      }),
    });

    expect(response.status).toBe(202);
    expect(SessionService.setSessionPermissionMode).toHaveBeenCalledWith(
      'override-mode',
      '/override-mode-workspace',
      'autoEdit'
    );
    expect(
      vi.mocked(SessionService.setSessionPermissionMode).mock.invocationCallOrder.at(-1)
    ).toBeLessThan(
      runtimeState.runtime.prepareInputTurn.mock.invocationCallOrder.at(-1)!
    );
    await vi.waitFor(() => {
      expect(agentState.chatStream).toHaveBeenCalledWith(
        'continue under automatic edits only',
        expect.objectContaining({
          permissionMode: PermissionMode.AUTO_EDIT,
        }),
        expect.any(Object)
      );
    });
  });

  it('does not start a turn when an explicit permission override cannot persist', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');
    mockResolvedSession('failed-mode', {
      projectPath: '/failed-mode-workspace',
      permissionMode: 'default',
    });
    vi.mocked(SessionService.setSessionPermissionMode).mockRejectedValueOnce(
      new Error('permission mode fsync failed')
    );

    const response = await SessionRoutes().request('/failed-mode/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: 'do not run with a volatile policy',
        permissionMode: 'yolo',
      }),
    });

    expect(response.status).toBe(500);
    expect(runtimeState.runtime.prepareInputTurn).not.toHaveBeenCalled();
    expect(agentState.chatStream).not.toHaveBeenCalled();
  });

  it('publishes a run error and releases a prepared owner on loop failure', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');
    const { Bus } = await import('../../../../src/server/bus.js');
    mockResolvedSession('failed-prepared-run');
    agentState.chatStream.mockImplementationOnce(async function* () {
      if (Date.now() < 0) yield undefined;
      return {
        success: false,
        error: { type: 'api_error', message: 'upstream unavailable' },
        metadata: { turnsCount: 0, toolCallsCount: 0, duration: 0 },
      };
    });

    const app = SessionRoutes();
    const response = await app.request('/failed-prepared-run/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'durable request' }),
    });

    expect(response.status).toBe(202);
    await vi.waitFor(() => {
      expect(Bus.publish).toHaveBeenCalledWith(
        refFor('failed-prepared-run'),
        'session.error',
        {
          error: 'Agent execution failed.',
          taskFailure: {
            code: 'runtime',
            message: 'Agent execution failed.',
            retryable: true,
          },
        }
      );
    });
    expect(runtimeState.runtime.finishTurn).toHaveBeenCalledWith({
      id: 'prepared-turn',
    });
    expect(Bus.publish).not.toHaveBeenCalledWith(
      refFor('failed-prepared-run'),
      'session.completed',
      expect.any(Object)
    );
  });

  it('publishes loop lifecycle events and preserves canonical tool failure state', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');
    const { Bus } = await import('../../../../src/server/bus.js');
    mockResolvedSession('surface-events');

    agentState.chatStream.mockImplementationOnce(async function* () {
      yield { kind: 'turn_start', turn: 2, maxTurns: 8 };
      yield {
        kind: 'compaction',
        phase: 'start',
        reason: 'context_limit',
      };
      yield {
        kind: 'compaction',
        phase: 'end',
        reason: 'context_limit',
        strategy: 'fallback',
        outcome: 'fallback',
        preTokens: 120_000,
        postTokens: 2_000,
        sampleAttempts: 2,
        inputReductions: 1,
        messagesOmitted: 2,
        filesOmitted: 0,
        imagesOmitted: 1,
        fallbackTargetTokens: 64_000,
        fallbackMessagesOmitted: 8,
        fallbackMessagesTruncated: 1,
        failureReason: 'insufficient_reduction',
      };
      yield { kind: 'model_fallback' };
      yield {
        kind: 'provider_admission',
        phase: 'queued',
        requestClass: 'foreground',
        resource: 'stream',
        scope: 'domain',
        reason: 'capacity',
        queuePosition: 1,
        queueDepth: 1,
        inFlight: 4,
        limit: 4,
        waitMs: 15_000,
        maxWaitMs: 180_000,
        recoveryRemainingMs: 585_000,
      };
      yield {
        kind: 'provider_retry',
        phase: 'scheduled',
        attempt: 1,
        maxRetries: 2,
        reason: 'server_error',
        statusCode: 503,
        delayMs: 750,
        nextRetryAt: 1_750,
      };
      yield {
        kind: 'provider_circuit',
        phase: 'waiting',
        reason: 'server_error',
        statusCode: 503,
        retryAfterMs: 2_000,
        nextProbeAt: 3_000,
        openDurationMs: 2_000,
        sampleCount: 4,
        failureCount: 4,
        recoveryRemainingMs: 598_000,
      };
      yield {
        kind: 'provider_stall',
        phase: 'detected',
        stallCount: 1,
        durationMs: 30_000,
        warningAfterMs: 30_000,
        timeoutMs: 300_000,
        outputStarted: false,
      };
      yield { kind: 'thinking_delta', delta: 'inspect the failure' };
      yield {
        kind: 'follow_up_started',
        queued: 2,
        recovered: 2,
        messages: [
          {
            id: 'already-persisted',
            content: 'persisted',
            queuedAt: Date.now(),
            recovered: true,
            persisted: true,
          },
          {
            id: 'not-yet-persisted',
            content: 'not persisted',
            queuedAt: Date.now(),
            recovered: true,
            persisted: false,
          },
        ],
      };
      yield {
        kind: 'steering_applied',
        messageIds: ['recovered-steer'],
        count: 1,
        recovered: 1,
        delivery: 'next_turn',
      };
      yield {
        kind: 'goal_continuation_started',
        goal: {
          version: 1,
          sessionId: 'surface-events',
          goalId: 'goal-recovery',
          objective: 'finish the migration',
          status: 'active',
          tokensUsed: 100,
          timeUsedSeconds: 2,
          continuationCount: 2,
          prematureStop: {
            pattern: 'internal_wait',
            consecutiveCount: 2,
            detectedAt: '2026-08-22T00:00:00.000Z',
          },
          createdAt: '2026-08-22T00:00:00.000Z',
          updatedAt: '2026-08-22T00:00:00.000Z',
        },
        continuation: 2,
        prematureStopPattern: 'internal_wait',
        prematureStopCount: 2,
      };
      yield {
        kind: 'tool_result',
        toolCall: {
          id: 'tool-failed-without-error-payload',
          type: 'function',
          function: { name: 'Bash', arguments: '{"command":"false"}' },
        },
        result: {
          success: false,
          llmContent: 'Command exited with code 1',
          metadata: { summary: 'Command failed' },
        },
      };
      return {
        success: true,
        finalMessage: 'recovered',
        metadata: { turnsCount: 2, toolCallsCount: 1, duration: 0 },
      };
    });

    const app = SessionRoutes();
    const response = await app.request('/surface-events/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'recover from the failed command' }),
    });

    expect(response.status).toBe(202);
    await vi.waitFor(() => {
      expect(Bus.publish).toHaveBeenCalledWith(
        refFor('surface-events'),
        'session.completed',
        expect.any(Object)
      );
    });

    expect(Bus.publish).toHaveBeenCalledWith(refFor('surface-events'), 'turn.started', {
      turn: 2,
      maxTurns: 8,
    });
    expect(Bus.publish).toHaveBeenCalledWith(
      refFor('surface-events'),
      'compaction.started',
      { reason: 'context_limit' }
    );
    expect(Bus.publish).toHaveBeenCalledWith(
      refFor('surface-events'),
      'compaction.completed',
      {
        reason: 'context_limit',
        strategy: 'fallback',
        outcome: 'fallback',
        preTokens: 120_000,
        postTokens: 2_000,
        sampleAttempts: 2,
        inputReductions: 1,
        messagesOmitted: 2,
        filesOmitted: 0,
        imagesOmitted: 1,
        fallbackTargetTokens: 64_000,
        fallbackMessagesOmitted: 8,
        fallbackMessagesTruncated: 1,
        failureReason: 'insufficient_reduction',
      }
    );
    expect(Bus.publish).toHaveBeenCalledWith(
      refFor('surface-events'),
      'model.fallback',
      {}
    );
    expect(Bus.publish).toHaveBeenCalledWith(
      refFor('surface-events'),
      'provider.admission',
      {
        phase: 'queued',
        requestClass: 'foreground',
        resource: 'stream',
        scope: 'domain',
        reason: 'capacity',
        queuePosition: 1,
        queueDepth: 1,
        inFlight: 4,
        limit: 4,
        waitMs: 15_000,
        maxWaitMs: 180_000,
        recoveryRemainingMs: 585_000,
      }
    );
    expect(Bus.publish).toHaveBeenCalledWith(
      refFor('surface-events'),
      'provider.retry',
      {
        phase: 'scheduled',
        attempt: 1,
        maxRetries: 2,
        reason: 'server_error',
        statusCode: 503,
        delayMs: 750,
        nextRetryAt: 1_750,
      }
    );
    expect(Bus.publish).toHaveBeenCalledWith(
      refFor('surface-events'),
      'provider.stall',
      {
        phase: 'detected',
        stallCount: 1,
        durationMs: 30_000,
        warningAfterMs: 30_000,
        timeoutMs: 300_000,
        outputStarted: false,
      }
    );
    expect(Bus.publish).toHaveBeenCalledWith(
      refFor('surface-events'),
      'provider.circuit',
      {
        phase: 'waiting',
        reason: 'server_error',
        statusCode: 503,
        retryAfterMs: 2_000,
        nextProbeAt: 3_000,
        openDurationMs: 2_000,
        sampleCount: 4,
        failureCount: 4,
        recoveryRemainingMs: 598_000,
      }
    );
    expect(Bus.publish).toHaveBeenCalledWith(
      refFor('surface-events'),
      'thinking.delta',
      expect.objectContaining({
        messageId: expect.any(String),
        delta: 'inspect the failure',
      })
    );
    expect(Bus.publish).not.toHaveBeenCalledWith(
      refFor('surface-events'),
      'message.created',
      expect.objectContaining({ messageId: 'already-persisted' })
    );
    expect(Bus.publish).toHaveBeenCalledWith(
      refFor('surface-events'),
      'message.created',
      expect.objectContaining({
        messageId: 'not-yet-persisted',
        recovered: true,
      })
    );
    expect(Bus.publish).toHaveBeenCalledWith(
      refFor('surface-events'),
      'steering.applied',
      expect.objectContaining({
        messageIds: ['recovered-steer'],
        count: 1,
        recovered: 1,
      })
    );
    expect(Bus.publish).toHaveBeenCalledWith(
      refFor('surface-events'),
      'goal.continuation.started',
      expect.objectContaining({
        continuation: 2,
        prematureStopPattern: 'internal_wait',
        prematureStopCount: 2,
      })
    );
    expect(Bus.publish).toHaveBeenCalledWith(
      refFor('surface-events'),
      'tool.result',
      expect.objectContaining({
        toolCallId: 'tool-failed-without-error-payload',
        success: false,
      })
    );
  });

  it('creates durable metadata before inserting an active session', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');
    const { Bus } = await import('../../../../src/server/bus.js');
    const { SessionService } = await import(
      '../../../../src/services/SessionService.js'
    );

    const app = SessionRoutes();
    const response = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Created from web',
        projectPath: '/tmp/task4-create-workspace',
      }),
    });

    expect(response.status).toBe(200);
    expect(SessionService.createSessionMetadata).toHaveBeenCalledTimes(1);
    expect(SessionService.createSessionMetadata).toHaveBeenCalledWith(
      expect.any(String),
      '/tmp/task4-create-workspace',
      { title: 'Created from web', taskStatus: 'completed' }
    );
    const body = await response.json();
    expect(body).toMatchObject({
      sessionId: expect.any(String),
      projectPath: '/tmp/task4-create-workspace',
      rootId: expect.any(String),
      taskStatus: 'completed',
    });
    expect(Bus.publish).toHaveBeenCalledWith(
      {
        sessionId: body.sessionId,
        projectPath: '/tmp/task4-create-workspace',
      },
      'session.created',
      {}
    );
  });

  it('starts a native read-only review for an exact Session workspace', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');
    const app = SessionRoutes();
    const projectPath = '/tmp/native-review-workspace';
    const created = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Review', projectPath }),
    });
    const session = (await created.json()) as { sessionId: string };

    const response = await app.request(`/${session.sessionId}/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectPath,
        kind: 'base',
        ref: 'main',
        modelId: 'model-1',
      }),
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      reviewId: 'review-1',
      status: 'running',
    });
    expect(reviewState.start).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: session.sessionId,
        projectPath,
        request: { kind: 'base', ref: 'main' },
        signal: expect.any(AbortSignal),
      })
    );
    expect(reviewState.recoverInterrupted).toHaveBeenCalledWith(
      projectPath,
      session.sessionId,
      expect.objectContaining({
        sessionId: session.sessionId,
        workspaceRoot: projectPath,
      })
    );
  });

  it.each([
    { isolation: 'local' as const, executionPath: '/tmp/task-source' },
    { isolation: 'worktree' as const, executionPath: '/tmp/task-worktree' },
  ])(
    'dispatches a durable $isolation task after prompt fsync',
    async ({ isolation, executionPath }) => {
      const { createSessionRouteController } = await import(
        '../../../../src/server/routes/session.js'
      );
      if (isolation === 'worktree') {
        worktreeState.enter.mockImplementationOnce(
          async (input: {
            sessionId: string;
            workspaceRoot: string;
            name: string;
          }) => ({
            sessionId: input.sessionId,
            name: input.name,
            branch: `blade-worktree-${input.sessionId}`,
            baseCommit: 'abc123',
            originalBranch: 'main',
            repositoryRoot: '/tmp/repo',
            originalWorkspaceRoot: input.workspaceRoot,
            worktreeRoot: '/tmp/task-worktree',
            workspaceRoot: '/tmp/task-worktree',
            sourceHadChanges: false,
          })
        );
      }
      const controller = createSessionRouteController();

      const result = await controller.dispatchTask({
        prompt: 'Implement the durable task dispatcher',
        sourceProjectPath: '/tmp/task-source',
        isolation,
        permissionMode: PermissionMode.DEFAULT,
      });

      expect(result).toMatchObject({
        session: {
          sessionId: expect.any(String),
          projectPath: executionPath,
          taskStatus: 'running',
          taskIsolation: isolation,
          taskSourceProjectPath: '/tmp/task-source',
        },
        runId: expect.any(String),
        messageId: 'prepared-input',
        status: 'running',
      });
      const sessionId = result.session.sessionId;
      expect(SessionService.createSessionMetadata).toHaveBeenCalledWith(
        sessionId,
        executionPath,
        expect.objectContaining({
          taskPromptSummary: 'Implement the durable task dispatcher',
          taskIsolation: isolation,
          taskSourceProjectPath: '/tmp/task-source',
          reasoningEffort: 'off',
          ...(isolation === 'worktree'
            ? {
                taskWorktree: expect.objectContaining({
                  sessionId,
                  workspaceRoot: executionPath,
                }),
              }
            : { taskWorktree: undefined }),
        })
      );
      expect(runtimeState.runtime.prepareInputTurn).toHaveBeenCalledWith(
        'Implement the durable task dispatcher'
      );
      expect(SessionRuntime.create).toHaveBeenCalledWith({
        sessionId,
        workspaceRoot: executionPath,
        modelId: 'model-1',
        permissionMode: PermissionMode.DEFAULT,
        taskIsolation: isolation,
        ...(isolation === 'worktree'
          ? {
              taskWorktree: expect.objectContaining({
                sessionId,
                workspaceRoot: executionPath,
              }),
            }
          : {}),
      });
      expect(worktreeState.enter).toHaveBeenCalledTimes(
        isolation === 'worktree' ? 1 : 0
      );
      if (isolation === 'worktree') {
        const { Agent } = await import('../../../../src/agent/Agent.js');
        await vi.waitFor(() => {
          expect(Agent.createWithRuntime).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
              toolBlacklist: ['EnterWorktree', 'ExitWorktree'],
            })
          );
          expect(agentState.chatStream).toHaveBeenCalledWith(
            'Implement the durable task dispatcher',
            expect.objectContaining({
              workspaceRoot: executionPath,
              worktreeActive: true,
            }),
            expect.any(Object)
          );
        });
      }
    }
  );

  it('disposes a terminal task runtime after completion', async () => {
    const { createSessionRouteController } = await import(
      '../../../../src/server/routes/session.js'
    );
    const controller = createSessionRouteController();

    const dispatched = await controller.dispatchTask({
      prompt: 'Complete and release the runtime',
      sourceProjectPath: '/tmp/terminal-runtime',
      isolation: 'local',
      permissionMode: PermissionMode.DEFAULT,
    });

    expect(dispatched.session.taskIsolation).toBe('local');
    await vi.waitFor(
      () => {
        expect(agentState.chatStream).toHaveBeenCalled();
        expect(busState.publish).toHaveBeenCalledWith(
          expect.objectContaining({ sessionId: dispatched.session.sessionId }),
          'session.completed',
          expect.any(Object)
        );
        expect(runtimeState.runtime.dispose).toHaveBeenCalledTimes(1);
      },
      { timeout: 3_000 }
    );
  });

  it('rejects task dispatch before durable creation when no model is configured', async () => {
    const { createSessionRouteController } = await import(
      '../../../../src/server/routes/session.js'
    );
    modelState.current = undefined;
    const controller = createSessionRouteController();

    await expect(
      controller.dispatchTask({
        prompt: 'Do not persist this task',
        sourceProjectPath: '/tmp/task-source',
        isolation: 'worktree',
        permissionMode: PermissionMode.DEFAULT,
      })
    ).rejects.toThrow(
      'No model is configured. Add or select a model before dispatching a task.'
    );

    expect(SessionService.createSessionMetadata).not.toHaveBeenCalled();
    expect(worktreeState.enter).not.toHaveBeenCalled();
    expect(SessionRuntime.create).not.toHaveBeenCalled();
  });

  it('retries from the exact durable dispatch into a new linked session', async () => {
    const { createSessionRouteController } = await import(
      '../../../../src/server/routes/session.js'
    );
    const source = makeSessionMetadata({
      sessionId: 'retry-source',
      projectPath: '/tmp/retry-source',
      title: 'Edited retry source',
      taskStatus: 'failed',
      taskRetryAvailable: true,
      taskPriority: 'high',
      taskKind: 'bug',
      taskDueAt: '2026-08-21T09:30:00.000Z',
    });
    const dispatch = {
      version: 1 as const,
      prompt: 'Retry this exact prompt',
      title: 'Retry source',
      sourceProjectPath: '/tmp/retry-source',
      isolation: 'local' as const,
      permissionMode: 'autoEdit' as const,
      attachments: [
        {
          type: 'image' as const,
          content: 'data:image/png;base64,retry-exact',
          mimeType: 'image/png',
          name: 'retry.png',
        },
      ],
    };
    vi.mocked(SessionService.listSessions).mockResolvedValue([source]);
    vi.mocked(SessionService.findSessionMetadata).mockResolvedValue(source);
    vi.mocked(SessionService.findSessionTaskDispatch).mockResolvedValue(dispatch);
    const controller = createSessionRouteController();

    const result = await controller.retryTask(source.sessionId, source.projectPath);

    expect(result.session).toMatchObject({
      sessionId: expect.not.stringMatching(source.sessionId),
      taskStatus: 'running',
      taskRetryAvailable: true,
      taskRetriedFrom: {
        sessionId: source.sessionId,
        projectPath: source.projectPath,
      },
    });
    expect(SessionService.createSessionMetadata).toHaveBeenLastCalledWith(
      result.session.sessionId,
      '/tmp/retry-source',
      expect.objectContaining({
        title: 'Edited retry source',
        taskPriority: 'high',
        taskKind: 'bug',
        taskDueAt: '2026-08-21T09:30:00.000Z',
        taskDispatch: {
          ...dispatch,
          title: 'Edited retry source',
          taskPriority: 'high',
          taskKind: 'bug',
          taskDueAt: '2026-08-21T09:30:00.000Z',
          modelId: 'model-1',
          reasoningEffort: 'off',
          serviceTier: 'auto',
          responseVerbosity: 'auto',
          communicationStyle: 'auto',
        },
        taskRetriedFrom: {
          sessionId: source.sessionId,
          projectPath: source.projectPath,
        },
      })
    );
    expect(runtimeState.runtime.prepareInputTurn).toHaveBeenCalledWith([
      { type: 'text', text: 'Retry this exact prompt' },
      {
        type: 'image_url',
        image_url: { url: 'data:image/png;base64,retry-exact' },
      },
    ]);
  });

  it('persists a task failure when the agent cannot be created after admission', async () => {
    const { Agent } = await import('../../../../src/agent/Agent.js');
    const { createSessionRouteController } = await import(
      '../../../../src/server/routes/session.js'
    );
    vi.mocked(Agent.createWithRuntime).mockRejectedValueOnce(
      new Error('agent initialization failed')
    );
    const controller = createSessionRouteController();
    const dispatched = await controller.dispatchTask({
      prompt: 'Fail after admission',
      sourceProjectPath: '/tmp/task-source',
      isolation: 'local',
      permissionMode: PermissionMode.YOLO,
    });

    expect(dispatched.status).toBe('running');
    await vi.waitFor(() =>
      expect(runtimeState.runtime.setTaskStatus).toHaveBeenCalledWith(
        'failed',
        expect.objectContaining({ message: 'agent initialization failed' })
      )
    );
    await vi.waitFor(() =>
      expect(
        busState.publish.mock.calls.some(
          ([ref, type, properties]) =>
            ref.sessionId === dispatched.session.sessionId &&
            type === 'task.status' &&
            properties.taskStatus === 'failed' &&
            properties.taskInFlight === 0 &&
            properties.taskQueueDepth === 0
        )
      ).toBe(true)
    );
    await vi.waitFor(async () => {
      const response = await controller.app.request('/');
      const projected = (await response.json()) as Array<{
        sessionId: string;
        taskQueuePosition?: number;
        taskQueueDepth?: number;
      }>;
      const failed = projected.find(
        (session) => session.sessionId === dispatched.session.sessionId
      );
      expect(failed?.taskQueuePosition).toBeUndefined();
      expect(failed?.taskQueueDepth).toBeUndefined();
    });
  });

  it('admits task runs through the process-wide FIFO limit', async () => {
    const { createSessionRouteController } = await import(
      '../../../../src/server/routes/session.js'
    );
    runtimeState.runtime.getTaskAdmissionLimits.mockReturnValue({
      maxConcurrent: 1,
      maxQueued: 10,
      maxQueuedBytes: 64 * 1024 * 1024,
    });
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const started: string[] = [];
    agentState.chatStream.mockImplementation(async function* (
      _content: unknown,
      context: { sessionId: string }
    ) {
      if (Date.now() < 0) yield undefined;
      started.push(context.sessionId);
      if (started.length === 1) await firstGate;
      return {
        success: true,
        finalMessage: 'done',
        metadata: { turnsCount: 1, toolCallsCount: 0, duration: 0 },
      };
    });
    const controller = createSessionRouteController();

    const first = await controller.dispatchTask({
      prompt: 'First task',
      sourceProjectPath: '/tmp/task-source',
      isolation: 'local',
      permissionMode: PermissionMode.YOLO,
    });
    await vi.waitFor(() => expect(started).toHaveLength(1));
    const second = await controller.dispatchTask({
      prompt: 'Second task',
      sourceProjectPath: '/tmp/task-source',
      isolation: 'local',
      permissionMode: PermissionMode.YOLO,
    });

    expect(first.status).toBe('running');
    expect(second).toMatchObject({
      status: 'queued',
      queuePosition: 1,
      queueDepth: 1,
      maxConcurrentTasks: 1,
      session: {
        taskStatus: 'queued',
        taskQueuePosition: 1,
        taskConcurrencyLimit: 1,
      },
    });
    expect(started).toHaveLength(1);
    expect(
      busState.publish.mock.calls.some(
        ([ref, type, properties]) =>
          ref.sessionId === second.session.sessionId &&
          type === 'session.status' &&
          properties.status === 'running'
      )
    ).toBe(false);

    releaseFirst();
    await vi.waitFor(() => expect(started).toHaveLength(2));
    expect(runtimeState.runtime.setTaskAdmission).toHaveBeenCalledWith(
      expect.objectContaining({
        state: 'queued',
        queuePosition: 1,
        maxConcurrent: 1,
      })
    );
    expect(runtimeState.runtime.setTaskAdmission).toHaveBeenCalledWith(
      expect.objectContaining({
        state: 'running',
        maxConcurrent: 1,
      })
    );
    await vi.waitFor(() =>
      expect(
        busState.publish.mock.calls.some(
          ([ref, type, properties]) =>
            ref.sessionId === second.session.sessionId &&
            type === 'session.status' &&
            properties.status === 'running'
        )
      ).toBe(true)
    );
    await vi.waitFor(() =>
      expect(
        busState.publish.mock.calls.some(
          ([ref, type, properties]) =>
            ref.sessionId === second.session.sessionId &&
            type === 'task.status' &&
            properties.taskInFlight === 0 &&
            properties.taskQueueDepth === 0
        )
      ).toBe(true)
    );
  });

  it('closes admission and drains active work before disposing runtimes', async () => {
    const { createSessionRouteController } = await import(
      '../../../../src/server/routes/session.js'
    );
    let observeAbort!: (reason: unknown) => void;
    const aborted = new Promise<unknown>((resolve) => {
      observeAbort = resolve;
    });
    let releaseCompletion!: () => void;
    const completionBarrier = new Promise<void>((resolve) => {
      releaseCompletion = resolve;
    });
    agentState.chatStream.mockImplementationOnce(async function* (
      _content: unknown,
      context: { signal?: AbortSignal }
    ) {
      yield { kind: 'turn_start', turn: 1, maxTurns: 10 };
      await new Promise<void>((resolve) => {
        const finish = () => {
          observeAbort(context.signal?.reason);
          resolve();
        };
        context.signal?.addEventListener('abort', finish, { once: true });
        if (context.signal?.aborted) finish();
      });
      await completionBarrier;
      return {
        success: false,
        error: { type: 'aborted' as const, message: 'server-shutdown' },
        metadata: { turnsCount: 1, toolCallsCount: 0, duration: 0 },
      };
    });
    const controller = createSessionRouteController();
    const dispatched = await controller.dispatchTask({
      prompt: 'Hold an active shutdown turn',
      sourceProjectPath: '/tmp/task-source',
      isolation: 'local',
      permissionMode: PermissionMode.YOLO,
    });
    await vi.waitFor(() => {
      expect(agentState.chatStream).toHaveBeenCalledOnce();
    });
    const runtime = await vi.mocked(SessionRuntime.create).mock.results.at(-1)!.value;

    let shutdownSettled = false;
    const shutdown = controller.shutdown('server-shutdown').then(() => {
      shutdownSettled = true;
    });

    await expect(aborted).resolves.toBe('server-shutdown');
    expect(shutdownSettled).toBe(false);
    expect(runtime.dispose).not.toHaveBeenCalled();
    await expect(
      controller.dispatchTask({
        prompt: 'Must not be admitted',
        sourceProjectPath: '/tmp/task-source',
        isolation: 'local',
        permissionMode: PermissionMode.YOLO,
      })
    ).rejects.toMatchObject({
      statusCode: 503,
    });

    releaseCompletion();
    await expect(shutdown).resolves.toBeUndefined();
    expect(runtime.dispose).toHaveBeenCalledOnce();
    expect(busState.publish).toHaveBeenCalledWith(
      {
        sessionId: dispatched.session.sessionId,
        projectPath: dispatched.session.projectPath,
      },
      'run.cancelled',
      expect.objectContaining({ runId: dispatched.runId })
    );

    await expect(controller.shutdown('duplicate')).resolves.toBeUndefined();
    expect(runtime.dispose).toHaveBeenCalledOnce();
  });

  it('keeps every admitted run active beyond the recent-run retention limit', async () => {
    const { createSessionRouteController } = await import(
      '../../../../src/server/routes/session.js'
    );
    runtimeState.runtime.getTaskAdmissionLimits.mockReturnValue({
      maxConcurrent: 1,
      maxQueued: 101,
      maxQueuedBytes: 64 * 1024 * 1024,
    });
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const started: string[] = [];
    agentState.chatStream.mockImplementation(async function* (
      _content: unknown,
      context: { sessionId: string }
    ) {
      if (Date.now() < 0) yield undefined;
      started.push(context.sessionId);
      if (started.length === 1) await firstGate;
      return {
        success: true,
        finalMessage: 'done',
        metadata: { turnsCount: 1, toolCallsCount: 0, duration: 0 },
      };
    });
    const controller = createSessionRouteController();

    const dispatches = [];
    for (let index = 0; index < 102; index++) {
      dispatches.push(
        await controller.dispatchTask({
          prompt: `Task ${index}`,
          sourceProjectPath: '/tmp/task-source',
          isolation: 'local',
          permissionMode: PermissionMode.YOLO,
        })
      );
    }

    expect(dispatches[0]?.status).toBe('running');
    expect(dispatches.at(-1)).toMatchObject({
      status: 'queued',
      queuePosition: 101,
      queueDepth: 101,
    });
    expect(started).toHaveLength(1);

    releaseFirst();
    await vi.waitFor(
      () => {
        expect(started).toHaveLength(102);
        expect(
          busState.publish.mock.calls.some(
            ([, type, properties]) =>
              type === 'task.status' &&
              properties.taskInFlight === 0 &&
              properties.taskQueueDepth === 0
          )
        ).toBe(true);
      },
      { timeout: 5000 }
    );
  });

  it('cancels a queued run durably and immediately reuses its queue slot', async () => {
    const { createSessionRouteController } = await import(
      '../../../../src/server/routes/session.js'
    );
    runtimeState.runtime.getTaskAdmissionLimits.mockReturnValue({
      maxConcurrent: 1,
      maxQueued: 1,
      maxQueuedBytes: 64 * 1024 * 1024,
    });
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const started: string[] = [];
    agentState.chatStream.mockImplementation(async function* (
      _content: unknown,
      context: { sessionId: string }
    ) {
      if (Date.now() < 0) yield undefined;
      started.push(context.sessionId);
      if (started.length === 1) await firstGate;
      return {
        success: true,
        finalMessage: 'done',
        metadata: { turnsCount: 1, toolCallsCount: 0, duration: 0 },
      };
    });
    const controller = createSessionRouteController();
    const first = await controller.dispatchTask({
      prompt: 'Hold the only execution slot',
      sourceProjectPath: '/tmp/task-source',
      isolation: 'local',
      permissionMode: PermissionMode.YOLO,
    });
    const cancelled = await controller.dispatchTask({
      prompt: 'Cancel this queued task',
      sourceProjectPath: '/tmp/task-source',
      isolation: 'local',
      permissionMode: PermissionMode.YOLO,
    });

    expect(cancelled.status).toBe('queued');
    const response = await controller.app.request(
      `/${cancelled.session.sessionId}/abort?projectPath=${encodeURIComponent(cancelled.session.projectPath)}`,
      { method: 'POST' }
    );
    expect(response.status).toBe(200);
    expect(runtimeState.runtime.setTaskStatus).toHaveBeenCalledWith(
      'cancelled',
      'user-cancel'
    );

    const replacement = await controller.dispatchTask({
      prompt: 'Reuse the released queue slot',
      sourceProjectPath: '/tmp/task-source',
      isolation: 'local',
      permissionMode: PermissionMode.YOLO,
    });
    expect(replacement).toMatchObject({
      status: 'queued',
      queuePosition: 1,
      queueDepth: 1,
    });

    releaseFirst();
    await vi.waitFor(() => {
      expect(started).toContain(first.session.sessionId);
      expect(started).toContain(replacement.session.sessionId);
      expect(started).not.toContain(cancelled.session.sessionId);
    });
  });

  it('discards durable input when a running task ends normally after user abort', async () => {
    const { createSessionRouteController } = await import(
      '../../../../src/server/routes/session.js'
    );
    agentState.chatStream.mockImplementationOnce(async function* (
      _content: unknown,
      context: { signal: AbortSignal }
    ) {
      if (Date.now() < 0) yield undefined;
      await waitForGateOrAbort(new Promise<void>(() => undefined), context.signal);
      return {
        success: true,
        finalMessage: 'cancelled cleanly',
        metadata: { turnsCount: 1, toolCallsCount: 0, duration: 0 },
      };
    });

    const controller = createSessionRouteController();
    const dispatched = await controller.dispatchTask({
      prompt: 'Cancel without replaying this input',
      sourceProjectPath: '/tmp/task-source',
      isolation: 'local',
      permissionMode: PermissionMode.YOLO,
    });
    expect(dispatched.status).toBe('running');

    const response = await controller.app.request(
      `/${dispatched.session.sessionId}/abort?projectPath=${encodeURIComponent(dispatched.session.projectPath)}`,
      { method: 'POST' }
    );
    expect(response.status).toBe(200);
    expect(runtimeState.runtime.discardPendingInput).toHaveBeenCalledOnce();
    expect(runtimeState.runtime.setTaskStatus).toHaveBeenCalledWith(
      'cancelled',
      'user-cancel'
    );
  });

  it('rejects overflow with 429 semantics and removes the unaccepted task', async () => {
    const { createSessionRouteController } = await import(
      '../../../../src/server/routes/session.js'
    );
    runtimeState.runtime.getTaskAdmissionLimits.mockReturnValue({
      maxConcurrent: 1,
      maxQueued: 1,
      maxQueuedBytes: 64 * 1024 * 1024,
    });
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    agentState.chatStream.mockImplementation(async function* () {
      if (Date.now() < 0) yield undefined;
      await firstGate;
      return {
        success: true,
        finalMessage: 'done',
        metadata: { turnsCount: 1, toolCallsCount: 0, duration: 0 },
      };
    });
    const controller = createSessionRouteController();
    const first = await controller.dispatchTask({
      prompt: 'Hold the only slot',
      sourceProjectPath: '/tmp/task-source',
      isolation: 'local',
      permissionMode: PermissionMode.YOLO,
    });
    const second = await controller.dispatchTask({
      prompt: 'Fill the queue',
      sourceProjectPath: '/tmp/task-source',
      isolation: 'local',
      permissionMode: PermissionMode.YOLO,
    });

    await expect(
      controller.dispatchTask({
        prompt: 'Overflow',
        sourceProjectPath: '/tmp/task-source',
        isolation: 'local',
        permissionMode: PermissionMode.YOLO,
      })
    ).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
      statusCode: 429,
    });
    expect(second.status).toBe('queued');
    const deleted = vi.mocked(SessionService.deleteSession).mock.calls.at(-1);
    expect(deleted?.[0]).not.toBe(first.session.sessionId);
    expect(deleted?.[0]).not.toBe(second.session.sessionId);

    releaseFirst();
    await vi.waitFor(() =>
      expect(taskRunScheduler.getStats()).toMatchObject({
        inFlight: 0,
        queued: 0,
      })
    );
  });

  it('rejects pending task byte overflow and immediately reuses capacity', async () => {
    const { createSessionRouteController } = await import(
      '../../../../src/server/routes/session.js'
    );
    runtimeState.runtime.getTaskAdmissionLimits.mockReturnValue({
      maxConcurrent: 1,
      maxQueued: 10,
      maxQueuedBytes: 64 * 1024,
    });
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const started: string[] = [];
    agentState.chatStream.mockImplementation(async function* (
      _content: unknown,
      context: { sessionId: string }
    ) {
      if (Date.now() < 0) yield undefined;
      started.push(context.sessionId);
      if (started.length === 1) await firstGate;
      return {
        success: true,
        finalMessage: 'done',
        metadata: { turnsCount: 1, toolCallsCount: 0, duration: 0 },
      };
    });
    const controller = createSessionRouteController();
    const first = await controller.dispatchTask({
      prompt: 'Hold the only execution slot',
      sourceProjectPath: '/tmp/task-source',
      isolation: 'local',
      permissionMode: PermissionMode.YOLO,
    });
    await vi.waitFor(() => expect(started).toEqual([first.session.sessionId]));

    await expect(
      controller.dispatchTask({
        prompt: `BYTE_OVERFLOW_MARKER ${'界'.repeat(30_000)}`,
        sourceProjectPath: '/tmp/task-source',
        isolation: 'local',
        permissionMode: PermissionMode.YOLO,
      })
    ).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
      statusCode: 429,
      details: {
        resource: 'pending_bytes',
      },
    });
    expect(started).toEqual([first.session.sessionId]);
    expect(taskRunScheduler.getStats()).toMatchObject({
      queued: 0,
      pendingBytes: 0,
    });

    const replacement = await controller.dispatchTask({
      prompt: 'Run after the rejected large task',
      sourceProjectPath: '/tmp/task-source',
      isolation: 'local',
      permissionMode: PermissionMode.YOLO,
    });
    expect(replacement).toMatchObject({
      status: 'queued',
      queuePosition: 1,
    });

    releaseFirst();
    await vi.waitFor(() => {
      expect(started).toContain(replacement.session.sessionId);
      expect(taskRunScheduler.getStats().pendingBytes).toBe(0);
    });
  });

  it('recovers durable queued tasks and fails half-created entries without input', async () => {
    const { createSessionRouteController } = await import(
      '../../../../src/server/routes/session.js'
    );
    const recoverable = makeSessionMetadata({
      sessionId: 'task-recoverable',
      projectPath: '/tmp/recoverable',
      taskStatus: 'queued',
      taskIsolation: 'local',
      taskSourceProjectPath: '/tmp/recoverable',
      firstMessageTime: '2026-08-06T00:00:01.000Z',
    });
    const missingInput = makeSessionMetadata({
      sessionId: 'task-missing-input',
      projectPath: '/tmp/missing-input',
      taskStatus: 'queued',
      taskIsolation: 'local',
      taskSourceProjectPath: '/tmp/missing-input',
      firstMessageTime: '2026-08-06T00:00:00.000Z',
    });
    vi.mocked(SessionService.listSessions).mockResolvedValueOnce([
      recoverable,
      missingInput,
    ]);
    vi.mocked(SessionRuntime.hasPendingInbox).mockImplementation(
      async (_workspaceRoot, sessionId) => sessionId === recoverable.sessionId
    );
    vi.mocked(SessionService.findSessionMetadata).mockImplementation(
      async (sessionId) =>
        sessionId === recoverable.sessionId ? recoverable : undefined
    );
    runtimeState.runtime.getPendingSteeringCount.mockReturnValue(1);
    const controller = createSessionRouteController();

    const result = await controller.recoverQueuedTasks();

    expect(result).toEqual({ scheduled: 1, failed: 1, deferred: 0 });
    expect(SessionService.updateSessionMetadata).toHaveBeenCalledWith(
      missingInput.sessionId,
      missingInput.projectPath,
      expect.objectContaining({
        taskStatus: 'failed',
        taskStatusReason: 'Agent execution failed.',
        taskFailure: {
          code: 'runtime',
          message: 'Agent execution failed.',
          retryable: true,
        },
        taskQueuePosition: null,
        taskQueueDepth: null,
      })
    );
    await vi.waitFor(() =>
      expect(agentState.chatStream).toHaveBeenCalledWith(
        '',
        expect.objectContaining({
          sessionId: recoverable.sessionId,
          workspaceRoot: recoverable.projectPath,
        }),
        expect.objectContaining({
          pendingInputOnly: true,
          taskAdmission: expect.any(Object),
        })
      )
    );
  });

  it('counts only the unvisited suffix when recovery reaches a full queue', async () => {
    const { createSessionRouteController } = await import(
      '../../../../src/server/routes/session.js'
    );
    const metadata = ['broken', 'running', 'queued', 'overflow'].map((suffix, index) =>
      makeSessionMetadata({
        sessionId: `task-${suffix}`,
        projectPath: `/tmp/${suffix}`,
        taskStatus: 'queued',
        taskIsolation: 'local',
        taskSourceProjectPath: `/tmp/${suffix}`,
        firstMessageTime: `2026-08-06T00:00:0${index}.000Z`,
      })
    );
    vi.mocked(SessionService.listSessions).mockResolvedValueOnce(metadata);
    vi.mocked(SessionRuntime.hasPendingInbox).mockResolvedValue(true);
    vi.mocked(SessionService.findSessionMetadata).mockImplementation(
      async (sessionId) => {
        if (sessionId === 'task-broken') {
          throw new Error('transcript temporarily unavailable');
        }
        return metadata.find((entry) => entry.sessionId === sessionId);
      }
    );
    runtimeState.runtime.getPendingSteeringCount.mockReturnValue(1);
    runtimeState.runtime.getTaskAdmissionLimits.mockReturnValue({
      maxConcurrent: 1,
      maxQueued: 1,
      maxQueuedBytes: 64 * 1024 * 1024,
    });
    let releaseRunning!: () => void;
    const runningGate = new Promise<void>((resolve) => {
      releaseRunning = resolve;
    });
    agentState.chatStream.mockImplementation(async function* (
      _content: unknown,
      context: { sessionId: string }
    ) {
      if (Date.now() < 0) yield undefined;
      if (context.sessionId === 'task-running') await runningGate;
      return {
        success: true,
        finalMessage: 'done',
        metadata: { turnsCount: 1, toolCallsCount: 0, duration: 0 },
      };
    });
    const controller = createSessionRouteController();

    try {
      await expect(controller.recoverQueuedTasks()).resolves.toEqual({
        scheduled: 2,
        failed: 0,
        deferred: 2,
      });
    } finally {
      releaseRunning();
    }
  });

  it('rolls back a clean worktree when durable task creation fails', async () => {
    const { createSessionRouteController } = await import(
      '../../../../src/server/routes/session.js'
    );
    worktreeState.enter.mockImplementationOnce(
      async (input: { sessionId: string; workspaceRoot: string; name: string }) => ({
        sessionId: input.sessionId,
        name: input.name,
        branch: `blade-worktree-${input.sessionId}`,
        baseCommit: 'abc123',
        originalBranch: 'main',
        repositoryRoot: '/tmp/repo',
        originalWorkspaceRoot: input.workspaceRoot,
        worktreeRoot: '/tmp/task-worktree',
        workspaceRoot: '/tmp/task-worktree',
        sourceHadChanges: false,
      })
    );
    vi.mocked(SessionService.createSessionMetadata).mockRejectedValueOnce(
      new Error('durable creation failed')
    );
    const controller = createSessionRouteController();

    await expect(
      controller.dispatchTask({
        prompt: 'Dispatch atomically',
        sourceProjectPath: '/tmp/task-source',
        isolation: 'worktree',
        permissionMode: PermissionMode.DEFAULT,
      })
    ).rejects.toThrow('durable creation failed');

    const sessionId = worktreeState.enter.mock.calls[0]?.[0].sessionId;
    expect(worktreeState.exit).toHaveBeenCalledWith({
      sessionId,
      action: 'remove',
      discardChanges: true,
    });
    expect(SessionRuntime.create).not.toHaveBeenCalled();
  });

  it('keeps an active session visible when another workspace persists the same id as a subagent', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');

    const app = SessionRoutes();
    const createResponse = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Workspace B active session',
        projectPath: '/tmp/workspace-b',
      }),
    });
    const activeSession = await createResponse.json();
    vi.mocked(SessionService.listSessions).mockResolvedValue([
      makeSessionMetadata({
        sessionId: activeSession.sessionId,
        projectPath: '/tmp/workspace-a',
        relationType: 'subagent',
      }),
    ]);

    const listResponse = await app.request('/');

    expect(listResponse.status).toBe(200);
    expect(await listResponse.json()).toEqual([
      expect.objectContaining({
        sessionId: activeSession.sessionId,
        projectPath: '/tmp/workspace-b',
        isActive: true,
      }),
    ]);
  });

  it('isolates module-global session state between SessionRoutes instances and aborts ghost runs', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');

    const metadata = metadataFor('ghost-session', '/tmp/ghost-workspace', {
      title: 'Ghost session',
    });
    let observedSignal: AbortSignal | undefined;
    let releaseRun: () => void = () => undefined;
    const runGate = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });

    vi.mocked(SessionService.findSessionMetadata).mockResolvedValue(metadata);
    vi.mocked(SessionService.listSessions).mockResolvedValue([metadata]);
    agentState.chatStream.mockImplementationOnce(async function* (
      _content,
      chatContext: { signal: AbortSignal }
    ) {
      observedSignal = chatContext.signal;
      yield { kind: 'turn_start', turn: 1, maxTurns: 10 };
      await runGate;
      return {
        success: true,
        finalMessage: 'ghost session reply',
        metadata: { turnsCount: 1, toolCallsCount: 0, duration: 0 },
      };
    });

    const app1 = SessionRoutes();
    const startResponse = await app1.request(
      `/ghost-session/message?projectPath=${encodeURIComponent('/tmp/ghost-workspace')}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'leave a ghost run behind' }),
      }
    );
    expect(startResponse.status).toBe(202);
    expect(observedSignal?.aborted).toBe(false);

    vi.clearAllMocks();
    busState.subscribers.clear();
    vi.mocked(SessionService.listSessions).mockResolvedValue([]);
    vi.mocked(SessionService.findSessionMetadata).mockResolvedValue(undefined);

    const app2 = SessionRoutes();
    expect(observedSignal?.aborted).toBe(true);

    const listResponse = await app2.request('/');
    expect(listResponse.status).toBe(200);
    expect(await listResponse.json()).toEqual([]);

    const getResponse = await app2.request(
      `/ghost-session?projectPath=${encodeURIComponent('/tmp/ghost-workspace')}`
    );
    expect(getResponse.status).toBe(404);

    releaseRun();
  });

  it('does not keep an in-memory session when durable creation fails', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');
    const { SessionService } = await import(
      '../../../../src/services/SessionService.js'
    );
    vi.mocked(SessionService.createSessionMetadata).mockRejectedValueOnce(
      new Error('disk full')
    );

    const app = SessionRoutes();
    const createResponse = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Unpersisted',
        projectPath: '/tmp/task4-create-fail',
      }),
    });

    expect(createResponse.status).toBe(500);

    const listResponse = await app.request('/');
    expect(listResponse.status).toBe(200);
    expect(await listResponse.json()).toEqual([]);
  });

  it('updates durable metadata before mutating the active session title', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');
    const { SessionService } = await import(
      '../../../../src/services/SessionService.js'
    );

    const app = SessionRoutes();
    const createResponse = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Before rename',
        projectPath: '/tmp/task4-rename-workspace',
      }),
    });
    const created = await createResponse.json();

    vi.mocked(SessionService.updateSessionMetadata).mockResolvedValueOnce(
      makeSessionMetadata({
        sessionId: created.sessionId,
        projectPath: '/tmp/task4-rename-workspace',
        title: 'Renamed durably',
        lastMessageTime: new Date(2).toISOString(),
      })
    );

    const patchResponse = await app.request(`/${created.sessionId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Renamed durably',
        projectPath: '/tmp/task4-rename-workspace',
      }),
    });

    expect(patchResponse.status).toBe(200);
    expect(SessionService.updateSessionMetadata).toHaveBeenCalledWith(
      created.sessionId,
      '/tmp/task4-rename-workspace',
      { title: 'Renamed durably' }
    );
    expect(await patchResponse.json()).toMatchObject({
      success: true,
      title: 'Renamed durably',
    });
  });

  it('does not mutate the active title when durable rename fails', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');
    const { SessionService } = await import(
      '../../../../src/services/SessionService.js'
    );
    const metadata = metadataFor('stable-title-session', '/tmp/task4-stable-title', {
      title: 'Stable title',
    });
    vi.mocked(SessionService.findSessionMetadata).mockImplementation(
      async (sessionId: string, projectPath?: string) => {
        if (
          sessionId === 'stable-title-session' &&
          projectPath === '/tmp/task4-stable-title'
        ) {
          return metadata;
        }
        return undefined;
      }
    );

    const app = SessionRoutes();
    vi.mocked(SessionService.updateSessionMetadata).mockRejectedValueOnce(
      new Error('rename failed')
    );
    const patchResponse = await app.request('/stable-title-session', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Should not stick',
        projectPath: '/tmp/task4-stable-title',
      }),
    });

    expect(patchResponse.status).toBe(500);

    const getResponse = await app.request(
      `/stable-title-session?projectPath=${encodeURIComponent('/tmp/task4-stable-title')}`
    );
    expect(getResponse.status).toBe(200);
    expect(await getResponse.json()).toMatchObject({
      title: 'Stable title',
    });
  });

  it('requires projectPath when duplicate session ids exist across workspaces', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');
    const { SessionService } = await import(
      '../../../../src/services/SessionService.js'
    );

    vi.mocked(SessionService.listSessions).mockResolvedValue([
      makeSessionMetadata({
        sessionId: 'shared-session',
        projectPath: '/tmp/workspace-a',
        title: 'Workspace A',
        messageCount: 1,
      }),
      makeSessionMetadata({
        sessionId: 'shared-session',
        projectPath: '/tmp/workspace-b',
        title: 'Workspace B',
        messageCount: 2,
        lastMessageTime: new Date(2).toISOString(),
      }),
    ]);

    const app = SessionRoutes();
    const response = await app.request('/shared-session');

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'AMBIGUOUS_SESSION' },
    });
  });

  it('resolves duplicate ids to the exact workspace for get and message history', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');
    const { SessionService } = await import(
      '../../../../src/services/SessionService.js'
    );

    vi.mocked(SessionService.findSessionMetadata).mockImplementation(
      async (sessionId: string, projectPath?: string) => {
        if (sessionId === 'shared-session' && projectPath === '/tmp/workspace-b') {
          return makeSessionMetadata({
            sessionId,
            projectPath,
            title: 'Workspace B',
            messageCount: 2,
            lastMessageTime: new Date(2).toISOString(),
          });
        }
        return undefined;
      }
    );
    vi.mocked(SessionService.loadSession).mockImplementation(
      async (sessionId: string, projectPath?: string) => {
        if (sessionId === 'shared-session' && projectPath === '/tmp/workspace-b') {
          return [
            {
              role: 'system',
              content: 'internal-contextual-project-rule',
              metadata: { contextualProjectRules: true },
            },
            ...makeMessages({
              role: 'assistant',
              content: 'workspace-b-history',
            }),
          ];
        }
        return makeMessages();
      }
    );

    const app = SessionRoutes();
    const getResponse = await app.request(
      `/shared-session?projectPath=${encodeURIComponent('/tmp/workspace-b')}`
    );
    expect(getResponse.status).toBe(200);
    expect(await getResponse.json()).toMatchObject({
      sessionId: 'shared-session',
      projectPath: '/tmp/workspace-b',
      title: 'Workspace B',
    });

    const messagesResponse = await app.request(
      `/shared-session/message?projectPath=${encodeURIComponent('/tmp/workspace-b')}`
    );
    expect(messagesResponse.status).toBe(200);
    expect(await messagesResponse.json()).toEqual([
      { role: 'assistant', content: 'workspace-b-history' },
    ]);
    expect(SessionService.loadSession).toHaveBeenCalledWith(
      'shared-session',
      '/tmp/workspace-b'
    );
  });

  it('returns exact lookup errors for SSE instead of falling back to the request directory', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');

    const app = SessionRoutes();

    const explicitMissing = await app.request(
      `/missing-session/events?projectPath=${encodeURIComponent('/tmp/workspace-a')}`
    );
    expect(explicitMissing.status).toBe(404);
    await expect(explicitMissing.json()).resolves.toMatchObject({
      error: { code: 'NOT_FOUND' },
    });

    const missingWithoutPath = await app.request('/missing-session/events');
    expect(missingWithoutPath.status).toBe(404);
    await expect(missingWithoutPath.json()).resolves.toMatchObject({
      error: { code: 'NOT_FOUND' },
    });

    vi.mocked(SessionService.listSessions).mockResolvedValue([
      makeSessionMetadata({
        sessionId: 'shared-session',
        projectPath: '/tmp/workspace-a',
        title: 'Workspace A',
        messageCount: 1,
      }),
      makeSessionMetadata({
        sessionId: 'shared-session',
        projectPath: '/tmp/workspace-b',
        title: 'Workspace B',
        messageCount: 1,
      }),
    ]);

    const ambiguous = await app.request('/shared-session/events');
    expect(ambiguous.status).toBe(409);
    await expect(ambiguous.json()).resolves.toMatchObject({
      error: { code: 'AMBIGUOUS_SESSION' },
    });
  });

  it('delivers SSE events only to the collector for the exact session workspace', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');
    const { Bus } = await import('../../../../src/server/bus.js');
    vi.mocked(SessionService.findSessionMetadata).mockImplementation(
      async (sessionId: string, projectPath?: string) => {
        if (
          sessionId === 'shared-session' &&
          (projectPath === '/tmp/workspace-a' || projectPath === '/tmp/workspace-b')
        ) {
          return makeSessionMetadata({
            sessionId,
            projectPath,
            title: `Session ${projectPath?.slice(-1)}`,
          });
        }
        return undefined;
      }
    );

    const app = SessionRoutes();
    const firstAbortController = new AbortController();
    const secondAbortController = new AbortController();

    const [firstResponse, secondResponse] = await Promise.all([
      app.request(
        `/shared-session/events?projectPath=${encodeURIComponent('/tmp/workspace-a')}`,
        {
          signal: firstAbortController.signal,
        }
      ),
      app.request(
        `/shared-session/events?projectPath=${encodeURIComponent('/tmp/workspace-b')}`,
        {
          signal: secondAbortController.signal,
        }
      ),
    ]);

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);

    const firstCollector = createSseCollector(firstResponse);
    const secondCollector = createSseCollector(secondResponse);

    expect(await firstCollector.next()).toMatchObject({
      type: 'connected',
      properties: {
        sessionId: 'shared-session',
        projectPath: '/tmp/workspace-a',
        status: 'idle',
        queued: 0,
      },
    });
    expect(await secondCollector.next()).toMatchObject({
      type: 'connected',
      properties: {
        sessionId: 'shared-session',
        projectPath: '/tmp/workspace-b',
        status: 'idle',
        queued: 0,
      },
    });

    Bus.publish(
      { sessionId: 'shared-session', projectPath: '/tmp/workspace-a' },
      'session.status',
      { status: 'running' }
    );
    Bus.publish(
      { sessionId: 'shared-session', projectPath: '/tmp/workspace-b' },
      'session.status',
      { status: 'idle' }
    );

    expect(await firstCollector.next()).toMatchObject({
      type: 'session.status',
      properties: {
        sessionId: 'shared-session',
        projectPath: '/tmp/workspace-a',
        status: 'running',
      },
    });
    expect(await secondCollector.next()).toMatchObject({
      type: 'session.status',
      properties: {
        sessionId: 'shared-session',
        projectPath: '/tmp/workspace-b',
        status: 'idle',
      },
    });

    firstAbortController.abort();
    secondAbortController.abort();
    await Promise.all([firstCollector.cancel(), secondCollector.cancel()]);
  });

  it('subscribes before connected is consumable and cleans up when that write is aborted', async () => {
    const NativeTransformStream = globalThis.TransformStream;
    let releaseConnectedWrite: () => void = () => undefined;
    vi.stubGlobal(
      'TransformStream',
      class extends NativeTransformStream<Uint8Array, Uint8Array> {
        constructor() {
          super({
            transform: () =>
              new Promise<void>((resolve) => {
                releaseConnectedWrite = resolve;
              }),
          });
        }
      }
    );
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');
    mockResolvedSession('readiness-session', { projectPath: '/tmp/workspace-a' });

    const controller = new AbortController();
    const response = await SessionRoutes().request(
      `/readiness-session/events?projectPath=${encodeURIComponent('/tmp/workspace-a')}`,
      { signal: controller.signal }
    );

    expect(response.status).toBe(200);
    expect(busState.subscribers.size).toBe(1);
    const unsubscribe = busState.subscribe.mock.results.at(-1)?.value;

    controller.abort();
    await response.body?.cancel().catch(() => undefined);
    releaseConnectedWrite();
    await vi.waitFor(() => {
      expect(busState.subscribers.size).toBe(0);
    });
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('cleans up the listener when the connected write rejects', async () => {
    const { SSEStreamingApi } = await import('hono/streaming');
    const writeSse = vi
      .spyOn(SSEStreamingApi.prototype, 'writeSSE')
      .mockRejectedValueOnce(new Error('connected write failed'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');
    mockResolvedSession('write-failure-session', {
      projectPath: '/tmp/workspace-a',
    });

    const response = await SessionRoutes().request(
      `/write-failure-session/events?projectPath=${encodeURIComponent('/tmp/workspace-a')}`
    );
    await response.text();

    expect(response.status).toBe(200);
    expect(busState.subscribers.size).toBe(0);
    expect(busState.subscribe.mock.results.at(-1)?.value).toHaveBeenCalledTimes(1);

    writeSse.mockRestore();
    consoleError.mockRestore();
  });

  it('terminates without abort when a post-connected Bus event write rejects', async () => {
    vi.useFakeTimers();
    const { SSEStreamingApi } = await import('hono/streaming');
    const originalWriteSse = SSEStreamingApi.prototype.writeSSE;
    const writeSse = vi.spyOn(SSEStreamingApi.prototype, 'writeSSE');
    writeSse
      .mockImplementationOnce(function (message) {
        return originalWriteSse.call(this, message);
      })
      .mockRejectedValueOnce(new Error('Bus event write failed'));
    const { Bus } = await import('../../../../src/server/bus.js');
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');
    mockResolvedSession('bus-write-failure', { projectPath: '/tmp/workspace-a' });

    let readSettled = false;
    let observed:
      | {
          subscribers: number;
          unsubscribeCalls: number;
          timers: number;
          ended: boolean;
        }
      | undefined;
    const response = await SessionRoutes().request(
      `/bus-write-failure/events?projectPath=${encodeURIComponent('/tmp/workspace-a')}`
    );
    if (!response.body) {
      throw new Error('Expected SSE response body');
    }
    const reader = response.body.getReader();

    try {
      const connected = await reader.read();
      expect(new TextDecoder().decode(connected.value)).toContain('connected');
      const unsubscribe = busState.subscribe.mock.results.at(-1)?.value;

      Bus.publish(
        { sessionId: 'bus-write-failure', projectPath: '/tmp/workspace-a' },
        'message.created',
        { messageId: 'failed-write' }
      );
      const completion = reader.read().then((result) => {
        readSettled = true;
        return result;
      });
      await vi.advanceTimersByTimeAsync(1000);

      observed = {
        subscribers: busState.subscribers.size,
        unsubscribeCalls: unsubscribe.mock.calls.length,
        timers: vi.getTimerCount(),
        ended: readSettled && (await completion).done,
      };
    } finally {
      if (!readSettled) {
        await reader.cancel();
        await vi.advanceTimersByTimeAsync(1000);
      }
      writeSse.mockRestore();
      vi.useRealTimers();
    }

    expect(observed).toEqual({
      subscribers: 0,
      unsubscribeCalls: 1,
      timers: 1,
      ended: true,
    });
  });

  it('terminates without abort when a heartbeat write rejects', async () => {
    vi.useFakeTimers();
    const { SSEStreamingApi } = await import('hono/streaming');
    const originalWriteSse = SSEStreamingApi.prototype.writeSSE;
    const writeSse = vi.spyOn(SSEStreamingApi.prototype, 'writeSSE');
    writeSse
      .mockImplementationOnce(function (message) {
        return originalWriteSse.call(this, message);
      })
      .mockRejectedValueOnce(new Error('heartbeat write failed'));
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');
    mockResolvedSession('heartbeat-write-failure', {
      projectPath: '/tmp/workspace-a',
    });

    let readSettled = false;
    let observed:
      | {
          subscribers: number;
          unsubscribeCalls: number;
          timers: number;
          ended: boolean;
        }
      | undefined;
    const response = await SessionRoutes().request(
      `/heartbeat-write-failure/events?projectPath=${encodeURIComponent('/tmp/workspace-a')}`
    );
    if (!response.body) {
      throw new Error('Expected SSE response body');
    }
    const reader = response.body.getReader();

    try {
      const connected = await reader.read();
      expect(new TextDecoder().decode(connected.value)).toContain('connected');
      const unsubscribe = busState.subscribe.mock.results.at(-1)?.value;
      const completion = reader.read().then((result) => {
        readSettled = true;
        return result;
      });

      await vi.advanceTimersByTimeAsync(15000);

      observed = {
        subscribers: busState.subscribers.size,
        unsubscribeCalls: unsubscribe.mock.calls.length,
        timers: vi.getTimerCount(),
        ended: readSettled && (await completion).done,
      };
    } finally {
      if (!readSettled) {
        await reader.cancel();
        await vi.advanceTimersByTimeAsync(1000);
      }
      writeSse.mockRestore();
      vi.useRealTimers();
    }

    expect(observed).toEqual({
      subscribers: 0,
      unsubscribeCalls: 1,
      timers: 1,
      ended: true,
    });
  });

  it('does not lose an exact Bus event published as soon as connected is consumed', async () => {
    const { Bus } = await import('../../../../src/server/bus.js');
    const NativeTransformStream = globalThis.TransformStream;
    let publishedAtConnectedWrite = false;
    vi.stubGlobal(
      'TransformStream',
      class extends NativeTransformStream<Uint8Array, Uint8Array> {
        constructor() {
          super({
            transform(chunk, streamController) {
              const payload = new TextDecoder().decode(chunk);
              if (!publishedAtConnectedWrite && payload.includes('connected')) {
                publishedAtConnectedWrite = true;
                Bus.publish(
                  {
                    sessionId: 'readiness-session',
                    projectPath: '/tmp/workspace-a',
                  },
                  'message.created',
                  { messageId: 'first-after-connected' }
                );
              }
              streamController.enqueue(chunk);
            },
          });
        }
      }
    );
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');
    mockResolvedSession('readiness-session', { projectPath: '/tmp/workspace-a' });

    const controller = new AbortController();
    const response = await SessionRoutes().request(
      `/readiness-session/events?projectPath=${encodeURIComponent('/tmp/workspace-a')}`,
      { signal: controller.signal }
    );
    const collector = createSseCollector(response);
    await expect(collector.next()).resolves.toMatchObject({ type: 'connected' });

    await vi.waitFor(() => {
      expect(busState.subscribers.size).toBe(1);
    });
    Bus.publish(
      { sessionId: 'readiness-session', projectPath: '/tmp/workspace-a' },
      'test.sentinel',
      {}
    );

    await expect(collector.next()).resolves.toMatchObject({
      type: 'message.created',
      properties: { messageId: 'first-after-connected' },
    });

    controller.abort();
    await collector.cancel();
  });

  it('cuts replay over to live committed events without duplicates or cursor regression', async () => {
    const { Bus } = await import('../../../../src/server/bus.js');
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');
    const ref = {
      sessionId: 'replay-cutover-session',
      projectPath: '/tmp/workspace-a',
    };
    mockResolvedSession(ref.sessionId, { projectPath: ref.projectPath });
    const committed = (seq: number): SessionEvent => ({
      id: `event-${seq}`,
      seq,
      sessionId: ref.sessionId,
      projectPath: ref.projectPath,
      timestamp: `2026-08-14T00:00:${String(seq).padStart(2, '0')}.000Z`,
      type: 'turn_started',
      cwd: ref.projectPath,
      version: 'test',
      data: {
        turnId: `turn-${seq}`,
        kind: 'user',
        startedAt: '2026-08-14T00:00:00.000Z',
      },
    });
    eventLogState.replay.mockImplementationOnce(
      async (
        subscriber: {
          onCommitted(event: SessionEvent): void | Promise<void>;
        },
        fromSeq: number
      ) => {
        expect(fromSeq).toBe(11);
        await subscriber.onCommitted(committed(11));
        Bus.publish(ref, 'live.duplicate', { marker: 'duplicate-11' }, 11);
        Bus.publish(ref, 'live.buffered', { marker: 'buffered-12' }, 12);
        Bus.publish(ref, 'content.delta', { delta: 'replay-window-ephemeral' });
        await subscriber.onCommitted(committed(12));
        Bus.publish(ref, 'live.buffered', { marker: 'buffered-13' }, 13);
      }
    );

    const controller = new AbortController();
    const response = await SessionRoutes().request(
      `/${ref.sessionId}/events?projectPath=${encodeURIComponent(ref.projectPath)}`,
      {
        headers: { 'Last-Event-ID': '10' },
        signal: controller.signal,
      }
    );
    const collector = createSseCollector(response);

    expect(await collector.next()).toMatchObject({ type: 'connected' });
    const replayedEleven = await collector.next();
    const replayedTwelve = await collector.next();
    const bufferedThirteen = await collector.next();
    Bus.publish(ref, 'live.after-cutover', { marker: 'live-14' }, 14);
    const liveFourteen = await collector.next();

    expect([
      replayedEleven.seq,
      replayedTwelve.seq,
      bufferedThirteen.seq,
      liveFourteen.seq,
    ]).toEqual([11, 12, 13, 14]);
    expect(bufferedThirteen).toMatchObject({
      type: 'live.buffered',
      properties: { marker: 'buffered-13' },
    });
    expect(liveFourteen).toMatchObject({
      type: 'live.after-cutover',
      properties: { marker: 'live-14' },
    });

    controller.abort();
    await collector.cancel();
  });

  it('evicts only a slow SSE subscriber without aborting the server-owned turn', async () => {
    const { SSEStreamingApi } = await import('hono/streaming');
    const originalWriteSse = SSEStreamingApi.prototype.writeSSE;
    let slowWriter: unknown;
    let releaseSlowWrite!: () => void;
    const slowWrite = new Promise<void>((resolve) => {
      releaseSlowWrite = resolve;
    });
    const writeSse = vi
      .spyOn(SSEStreamingApi.prototype, 'writeSSE')
      .mockImplementation(function (message) {
        const connected =
          typeof message.data === 'string' &&
          message.data.includes('"type":"connected"');
        if (slowWriter === undefined && connected) slowWriter = this;
        if (this === slowWriter && !connected) return slowWrite;
        return originalWriteSse.call(this, message);
      });
    const { Bus } = await import('../../../../src/server/bus.js');
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');
    const ref = {
      sessionId: 'slow-subscriber-session',
      projectPath: '/tmp/workspace-a',
    };
    mockResolvedSession(ref.sessionId, { projectPath: ref.projectPath });
    let turnSignal: AbortSignal | undefined;
    let releaseRun!: () => void;
    const runGate = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    agentState.chatStream.mockImplementationOnce(async function* (
      _content,
      context: { signal: AbortSignal }
    ) {
      turnSignal = context.signal;
      yield { kind: 'turn_start', turn: 1, maxTurns: 10 };
      await waitForGateOrAbort(runGate, context.signal);
      return {
        success: true,
        finalMessage: 'slow subscriber did not cancel this run',
        metadata: { turnsCount: 1, toolCallsCount: 0, duration: 0 },
      };
    });

    const app = SessionRoutes();
    const start = await app.request(
      `/${ref.sessionId}/message?projectPath=${encodeURIComponent(ref.projectPath)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'keep running' }),
      }
    );
    expect(start.status).toBe(202);
    await vi.waitFor(() => expect(turnSignal).toBeDefined());

    const slowAbort = new AbortController();
    const fastAbort = new AbortController();
    const slowResponse = await app.request(
      `/${ref.sessionId}/events?projectPath=${encodeURIComponent(ref.projectPath)}`,
      { signal: slowAbort.signal }
    );
    const slowCollector = createSseCollector(slowResponse);
    expect(await slowCollector.next()).toMatchObject({ type: 'connected' });
    const fastResponse = await app.request(
      `/${ref.sessionId}/events?projectPath=${encodeURIComponent(ref.projectPath)}`,
      { signal: fastAbort.signal }
    );
    const fastCollector = createSseCollector(fastResponse);
    expect(await fastCollector.next()).toMatchObject({ type: 'connected' });

    try {
      for (let index = 0; index < 257; index += 1) {
        Bus.publish(ref, 'slow-consumer.probe', { index });
        await expect(fastCollector.next()).resolves.toMatchObject({
          type: 'slow-consumer.probe',
          properties: { index },
        });
      }

      await vi.waitFor(() => expect(busState.subscribers.size).toBe(1));
      expect(turnSignal?.aborted).toBe(false);
      await expect(slowCollector.next()).rejects.toThrow(
        'SSE stream ended before the next event was received'
      );

      Bus.publish(ref, 'fast-subscriber.sentinel', { delivered: true });
      await expect(fastCollector.next()).resolves.toMatchObject({
        type: 'fast-subscriber.sentinel',
        properties: { delivered: true },
      });
      expect(turnSignal?.aborted).toBe(false);
    } finally {
      releaseSlowWrite();
      releaseRun();
      slowAbort.abort();
      fastAbort.abort();
      await Promise.all([slowCollector.cancel(), fastCollector.cancel()]);
      writeSse.mockRestore();
    }
  });

  it('rejects message posts for an explicit missing workspace without creating runtime state', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');
    const { Bus } = await import('../../../../src/server/bus.js');

    const app = SessionRoutes();
    const response = await app.request(
      `/missing-session/message?projectPath=${encodeURIComponent('/tmp/workspace-a')}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'hello from nowhere' }),
      }
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'NOT_FOUND' },
    });
    expect(SessionRuntime.create).not.toHaveBeenCalled();
    expect(runtimeState.runtime.prepareInputTurn).not.toHaveBeenCalled();
    expect(Bus.publish).not.toHaveBeenCalled();
  });

  it('requires projectPath for duplicate session ids before accepting a message', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');
    vi.mocked(SessionService.listSessions).mockResolvedValue([
      makeSessionMetadata({
        sessionId: 'shared-session',
        projectPath: '/tmp/workspace-a',
        title: 'Workspace A',
        messageCount: 1,
      }),
      makeSessionMetadata({
        sessionId: 'shared-session',
        projectPath: '/tmp/workspace-b',
        title: 'Workspace B',
        messageCount: 1,
      }),
    ]);

    const app = SessionRoutes();
    const response = await app.request('/shared-session/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'ambiguous' }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'AMBIGUOUS_SESSION' },
    });
  });

  it('creates isolated runtimes for the same session id in different explicit workspaces', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');
    vi.mocked(SessionService.findSessionMetadata).mockImplementation(
      async (sessionId: string, projectPath?: string) => {
        if (
          sessionId === 'shared-session' &&
          (projectPath === '/tmp/workspace-a' || projectPath === '/tmp/workspace-b')
        ) {
          return makeSessionMetadata({
            sessionId,
            projectPath,
            title: `Session ${projectPath?.slice(-1)}`,
          });
        }
        return undefined;
      }
    );

    const app = SessionRoutes();
    const firstResponse = await app.request(
      `/shared-session/message?projectPath=${encodeURIComponent('/tmp/workspace-a')}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'workspace a' }),
      }
    );
    const secondResponse = await app.request(
      `/shared-session/message?projectPath=${encodeURIComponent('/tmp/workspace-b')}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'workspace b' }),
      }
    );

    expect(firstResponse.status).toBe(202);
    expect(secondResponse.status).toBe(202);
    expect(SessionRuntime.create).toHaveBeenCalledTimes(2);
    expect(SessionRuntime.create).toHaveBeenNthCalledWith(1, {
      sessionId: 'shared-session',
      workspaceRoot: '/tmp/workspace-a',
      permissionMode: PermissionMode.DEFAULT,
    });
    expect(SessionRuntime.create).toHaveBeenNthCalledWith(2, {
      sessionId: 'shared-session',
      workspaceRoot: '/tmp/workspace-b',
      permissionMode: PermissionMode.DEFAULT,
    });
  });

  it('routes a same-id message by projectPath in the shared request payload', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');
    vi.mocked(SessionService.findSessionMetadata).mockImplementation(
      async (sessionId: string, projectPath?: string) => {
        if (sessionId === 'shared-session' && projectPath === '/tmp/workspace-b') {
          return makeSessionMetadata({ sessionId, projectPath });
        }
        return undefined;
      }
    );

    const response = await SessionRoutes().request('/shared-session/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: 'workspace b',
        projectPath: '/tmp/workspace-b',
      }),
    });

    expect(response.status).toBe(202);
    expect(SessionRuntime.create).toHaveBeenCalledWith({
      sessionId: 'shared-session',
      workspaceRoot: '/tmp/workspace-b',
      permissionMode: PermissionMode.DEFAULT,
    });
  });

  it('patches only the exact same-id workspace and rejects duplicate no-path patch requests', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');

    const metadataA = metadataFor('shared-session', '/tmp/workspace-a', {
      title: 'Workspace A',
    });
    const metadataB = metadataFor('shared-session', '/tmp/workspace-b', {
      title: 'Workspace B',
    });

    vi.mocked(SessionService.listSessions).mockResolvedValue([metadataA, metadataB]);
    vi.mocked(SessionService.findSessionMetadata).mockImplementation(
      async (sessionId: string, projectPath?: string) => {
        if (sessionId !== 'shared-session') {
          return undefined;
        }
        if (projectPath === '/tmp/workspace-a') {
          return metadataA;
        }
        if (projectPath === '/tmp/workspace-b') {
          return metadataB;
        }
        return undefined;
      }
    );

    vi.mocked(SessionService.updateSessionMetadata).mockImplementation(
      async (sessionId: string, projectPath: string, update: { title?: string }) => {
        if (sessionId === 'shared-session' && projectPath === '/tmp/workspace-a') {
          return {
            ...metadataA,
            title: update.title,
            lastMessageTime: new Date(2).toISOString(),
          };
        }
        if (sessionId === 'shared-session' && projectPath === '/tmp/workspace-b') {
          return {
            ...metadataB,
            title: update.title,
            lastMessageTime: new Date(2).toISOString(),
          };
        }
        throw new Error(`Unexpected update target: ${sessionId} ${projectPath}`);
      }
    );

    const app = SessionRoutes();
    const controllerA = new AbortController();
    const controllerB = new AbortController();
    const responseA = await app.request(
      `/shared-session/events?projectPath=${encodeURIComponent('/tmp/workspace-a')}`,
      {
        signal: controllerA.signal,
      }
    );
    const responseB = await app.request(
      `/shared-session/events?projectPath=${encodeURIComponent('/tmp/workspace-b')}`,
      {
        signal: controllerB.signal,
      }
    );
    expect(responseA.status).toBe(200);
    expect(responseB.status).toBe(200);
    const collectorA = createSseCollector(responseA);
    const collectorB = createSseCollector(responseB);
    await expect(collectorA.next()).resolves.toMatchObject({
      type: 'connected',
      properties: {
        sessionId: 'shared-session',
        projectPath: '/tmp/workspace-a',
      },
    });
    await expect(collectorB.next()).resolves.toMatchObject({
      type: 'connected',
      properties: {
        sessionId: 'shared-session',
        projectPath: '/tmp/workspace-b',
      },
    });
    controllerA.abort();
    controllerB.abort();
    await Promise.all([collectorA.cancel(), collectorB.cancel()]);

    const patchA = await app.request(
      `/shared-session?projectPath=${encodeURIComponent('/tmp/workspace-a')}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          projectPath: '/tmp/workspace-a',
          title: 'Workspace A2',
        }),
      }
    );

    expect(patchA.status).toBe(200);
    expect(SessionService.updateSessionMetadata).toHaveBeenCalledTimes(1);
    expect(SessionService.updateSessionMetadata).toHaveBeenCalledWith(
      'shared-session',
      '/tmp/workspace-a',
      { title: 'Workspace A2' }
    );

    const getA = await app.request(
      `/shared-session?projectPath=${encodeURIComponent('/tmp/workspace-a')}`
    );
    const getB = await app.request(
      `/shared-session?projectPath=${encodeURIComponent('/tmp/workspace-b')}`
    );

    expect(getA.status).toBe(200);
    expect(await getA.json()).toMatchObject({
      sessionId: 'shared-session',
      projectPath: '/tmp/workspace-a',
      title: 'Workspace A2',
    });
    expect(getB.status).toBe(200);
    expect(await getB.json()).toMatchObject({
      sessionId: 'shared-session',
      projectPath: '/tmp/workspace-b',
      title: 'Workspace B',
    });

    vi.clearAllMocks();
    busState.subscribers.clear();
    vi.mocked(SessionService.listSessions).mockResolvedValue([metadataA, metadataB]);

    const ambiguousPatch = await app.request('/shared-session', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Should fail without path' }),
    });

    expect(ambiguousPatch.status).toBe(409);
    await expect(ambiguousPatch.json()).resolves.toMatchObject({
      error: { code: 'AMBIGUOUS_SESSION' },
    });
    expect(SessionService.updateSessionMetadata).not.toHaveBeenCalled();
  });

  it('removes a deleted task worktree after durable session deletion', async () => {
    const { createSessionRouteController } = await import(
      '../../../../src/server/routes/session.js'
    );
    const taskWorktree = {
      sessionId: '',
      name: 'delete-task-worktree',
      branch: '',
      baseCommit: 'abc123',
      originalBranch: 'main',
      repositoryRoot: '/tmp/repo',
      originalWorkspaceRoot: '/tmp/task-source',
      worktreeRoot: '/tmp/task-delete-worktree',
      workspaceRoot: '/tmp/task-delete-worktree',
      sourceHadChanges: false,
    };
    worktreeState.enter.mockImplementationOnce(
      async (input: { sessionId: string; name: string }) => ({
        ...taskWorktree,
        sessionId: input.sessionId,
        name: input.name,
        branch: `blade-worktree-${input.sessionId}`,
      })
    );
    const controller = createSessionRouteController();
    const dispatched = await controller.dispatchTask({
      prompt: 'Create an isolated disposable task',
      sourceProjectPath: '/tmp/task-source',
      isolation: 'worktree',
      permissionMode: PermissionMode.YOLO,
    });
    const expectedWorktree = expect.objectContaining({
      sessionId: dispatched.session.sessionId,
      workspaceRoot: '/tmp/task-delete-worktree',
    });

    const response = await controller.app.request(
      `/${dispatched.session.sessionId}?projectPath=${encodeURIComponent(dispatched.session.projectPath)}`,
      { method: 'DELETE' }
    );

    expect(response.status).toBe(200);
    expect(SessionService.deleteSession).toHaveBeenCalledWith(
      dispatched.session.sessionId,
      dispatched.session.projectPath
    );
    expect(busState.publish).toHaveBeenCalledWith(
      {
        sessionId: dispatched.session.sessionId,
        projectPath: dispatched.session.projectPath,
      },
      'session.deleted',
      {}
    );
    expect(worktreeState.restoreSession).toHaveBeenCalledWith(expectedWorktree);
    expect(worktreeState.exit).toHaveBeenCalledWith({
      sessionId: dispatched.session.sessionId,
      action: 'remove',
      discardChanges: true,
    });
    expect(
      vi.mocked(SessionService.deleteSession).mock.invocationCallOrder.at(-1)
    ).toBeLessThan(worktreeState.restoreSession.mock.invocationCallOrder.at(-1)!);
  });

  it('applies a terminal task once and persists its delivery projection', async () => {
    const { createSessionRouteController } = await import(
      '../../../../src/server/routes/session.js'
    );
    const taskWorktree = {
      sessionId: 'delivery-task',
      name: 'task/delivery-task',
      branch: 'blade-worktree-delivery-task',
      baseCommit: 'a'.repeat(40),
      originalBranch: 'main',
      repositoryRoot: '/tmp/repo',
      originalWorkspaceRoot: '/tmp/source',
      worktreeRoot: '/tmp/delivery-task',
      workspaceRoot: '/tmp/delivery-task',
      sourceHadChanges: false,
      sourceStateFingerprint: 'b'.repeat(64),
    };
    let metadata = makeSessionMetadata({
      sessionId: 'delivery-task',
      projectPath: '/tmp/delivery-task',
      taskStatus: 'completed',
      taskIsolation: 'worktree',
      taskSourceProjectPath: '/tmp/source',
      taskWorktreePath: taskWorktree.worktreeRoot,
      taskWorktreeBranch: taskWorktree.branch,
      taskBaseCommit: taskWorktree.baseCommit,
      taskDiffStat: {
        changedFiles: 2,
        additions: 4,
        deletions: 1,
        commits: 1,
      },
    });
    vi.mocked(SessionService.findSessionMetadata).mockResolvedValue(metadata);
    vi.mocked(SessionService.findSessionTaskWorktree).mockResolvedValue(taskWorktree);
    vi.mocked(SessionService.updateSessionMetadata).mockImplementation(
      async (_sessionId, _projectPath, update) => {
        metadata = makeSessionMetadata({
          ...metadata,
          taskDelivery: update.taskDelivery ?? metadata.taskDelivery,
        });
        return metadata;
      }
    );
    worktreeState.apply.mockResolvedValueOnce({
      action: 'apply',
      workspaceRoot: '/tmp/source',
      worktreeRoot: taskWorktree.worktreeRoot,
      branch: taskWorktree.branch,
      sourceCommit: taskWorktree.baseCommit,
      changedFiles: 2,
      additions: 4,
      deletions: 1,
    });
    const controller = createSessionRouteController();

    const delivered = await controller.deliverTask(
      'delivery-task',
      'apply',
      '/tmp/delivery-task'
    );

    expect(worktreeState.restoreSession).toHaveBeenCalledWith(taskWorktree);
    expect(worktreeState.apply).toHaveBeenCalledWith('delivery-task');
    expect(delivered.taskDelivery).toMatchObject({
      status: 'applied',
      sourceCommit: taskWorktree.baseCommit,
      changedFiles: 2,
    });
    await expect(
      controller.deliverTask('delivery-task', 'apply', '/tmp/delivery-task')
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'Task changes have already been applied',
    });
    expect(worktreeState.apply).toHaveBeenCalledTimes(1);
    expect(controller.getCoordinationStats()).toEqual({
      messageSubmissions: { keys: 0, operations: 0 },
      taskDeliveries: { keys: 0, operations: 0 },
    });
    await controller.shutdown();
  });

  it('persists a safe conflict reason without removing the task worktree', async () => {
    const { createSessionRouteController } = await import(
      '../../../../src/server/routes/session.js'
    );
    const { WorktreeDeliveryConflict } = await import(
      '../../../../src/worktree/WorktreeManager.js'
    );
    const taskWorktree = {
      sessionId: 'conflicted-task',
      name: 'task/conflicted-task',
      branch: 'blade-worktree-conflicted-task',
      baseCommit: 'a'.repeat(40),
      originalBranch: 'main',
      repositoryRoot: '/tmp/repo',
      originalWorkspaceRoot: '/tmp/source',
      worktreeRoot: '/tmp/conflicted-task',
      workspaceRoot: '/tmp/conflicted-task',
      sourceHadChanges: false,
      sourceStateFingerprint: 'b'.repeat(64),
    };
    let metadata = makeSessionMetadata({
      sessionId: 'conflicted-task',
      projectPath: '/tmp/conflicted-task',
      taskStatus: 'completed',
      taskIsolation: 'worktree',
      taskWorktreePath: taskWorktree.worktreeRoot,
    });
    vi.mocked(SessionService.findSessionMetadata).mockResolvedValue(metadata);
    vi.mocked(SessionService.findSessionTaskWorktree).mockResolvedValue(taskWorktree);
    vi.mocked(SessionService.updateSessionMetadata).mockImplementation(
      async (_sessionId, _projectPath, update) => {
        metadata = makeSessionMetadata({
          ...metadata,
          taskDelivery: update.taskDelivery ?? metadata.taskDelivery,
        });
        return metadata;
      }
    );
    worktreeState.apply.mockRejectedValueOnce(
      new WorktreeDeliveryConflict(
        'source_state_changed',
        'Source workspace changed after this task started'
      )
    );
    const controller = createSessionRouteController();

    await expect(
      controller.deliverTask('conflicted-task', 'apply', '/tmp/conflicted-task')
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'Source workspace changed after this task started',
    });
    expect(metadata.taskDelivery).toMatchObject({
      status: 'conflicted',
      message: 'Source workspace changed after this task started',
    });
    expect(worktreeState.exit).not.toHaveBeenCalled();
  });

  it('lets an explicit discard abandon an unavailable task worktree', async () => {
    const { createSessionRouteController } = await import(
      '../../../../src/server/routes/session.js'
    );
    const taskWorktree = {
      sessionId: 'missing-artifact-task',
      name: 'task/missing-artifact-task',
      branch: 'blade-worktree-missing-artifact-task',
      baseCommit: 'a'.repeat(40),
      originalBranch: 'main',
      repositoryRoot: '/tmp/repo',
      originalWorkspaceRoot: '/tmp/source',
      worktreeRoot: '/tmp/missing-artifact-task',
      workspaceRoot: '/tmp/missing-artifact-task',
      sourceHadChanges: false,
      sourceStateFingerprint: 'b'.repeat(64),
    };
    let metadata = makeSessionMetadata({
      sessionId: 'missing-artifact-task',
      projectPath: '/tmp/missing-artifact-task',
      taskStatus: 'completed',
      taskIsolation: 'worktree',
      taskWorktreePath: taskWorktree.worktreeRoot,
      taskDiffStat: {
        changedFiles: 2,
        additions: 4,
        deletions: 1,
        commits: 0,
      },
    });
    vi.mocked(SessionService.findSessionMetadata).mockResolvedValue(metadata);
    vi.mocked(SessionService.findSessionTaskWorktree).mockResolvedValue(taskWorktree);
    vi.mocked(SessionService.updateSessionMetadata).mockImplementation(
      async (_sessionId, _projectPath, update) => {
        metadata = makeSessionMetadata({
          ...metadata,
          taskDelivery: update.taskDelivery ?? metadata.taskDelivery,
          taskWorktreePath:
            update.taskWorktree === null ? undefined : metadata.taskWorktreePath,
        });
        return metadata;
      }
    );
    worktreeState.restoreSession.mockRejectedValueOnce(
      new Error('Persisted worktree is missing')
    );
    const controller = createSessionRouteController();

    const discarded = await controller.deliverTask(
      'missing-artifact-task',
      'discard',
      '/tmp/missing-artifact-task'
    );

    expect(worktreeState.exit).not.toHaveBeenCalled();
    expect(discarded.taskDelivery).toMatchObject({
      status: 'discarded',
      changedFiles: 2,
      message: 'Task artifact discarded; worktree was unavailable',
    });
    expect(SessionService.updateSessionMetadata).toHaveBeenCalledWith(
      'missing-artifact-task',
      '/tmp/missing-artifact-task',
      expect.objectContaining({ taskWorktree: null })
    );
    expect(busState.publish).toHaveBeenCalledWith(
      {
        sessionId: 'missing-artifact-task',
        projectPath: '/tmp/missing-artifact-task',
      },
      'task.delivery',
      expect.objectContaining({
        taskWorktreeRemoved: true,
        taskDelivery: expect.objectContaining({ status: 'discarded' }),
      })
    );
  });

  it('deletes only the exact same-id workspace and rejects duplicate no-path delete requests', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');

    const metadataA = metadataFor('shared-session', '/tmp/workspace-a', {
      title: 'Workspace A',
    });
    const metadataB = metadataFor('shared-session', '/tmp/workspace-b', {
      title: 'Workspace B',
    });
    const historyB: Message[] = [{ role: 'assistant', content: 'workspace-b-history' }];
    const deletedProjectPaths = new Set<string>();
    const disposeA = vi.fn().mockResolvedValue(undefined);
    const disposeB = vi.fn().mockResolvedValue(undefined);
    const runtimeA = await createRuntimeDouble({ dispose: disposeA });
    const runtimeB = await createRuntimeDouble({ dispose: disposeB });

    vi.mocked(SessionService.listSessions).mockResolvedValue([metadataA, metadataB]);
    vi.mocked(SessionService.findSessionMetadata).mockImplementation(
      async (sessionId: string, projectPath?: string) => {
        if (sessionId !== 'shared-session') {
          return undefined;
        }
        if (projectPath && deletedProjectPaths.has(projectPath)) {
          return undefined;
        }
        if (projectPath === '/tmp/workspace-a') {
          return metadataA;
        }
        if (projectPath === '/tmp/workspace-b') {
          return metadataB;
        }
        return undefined;
      }
    );
    vi.mocked(SessionService.loadSession).mockImplementation(
      async (sessionId: string, projectPath?: string) => {
        if (sessionId === 'shared-session' && projectPath === '/tmp/workspace-b') {
          return historyB;
        }
        return [];
      }
    );

    vi.mocked(SessionRuntime.create).mockImplementation(
      async ({ workspaceRoot }: SessionRuntimeOptions) => {
        if (workspaceRoot === '/tmp/workspace-a') {
          return runtimeA;
        }
        if (workspaceRoot === '/tmp/workspace-b') {
          return runtimeB;
        }
        return createRuntimeDouble();
      }
    );

    let releaseRunA: () => void = () => undefined;
    let releaseRunB: () => void = () => undefined;
    let signalA: AbortSignal | undefined;
    let signalB: AbortSignal | undefined;
    const runGateA = new Promise<void>((resolve) => {
      releaseRunA = resolve;
    });
    const runGateB = new Promise<void>((resolve) => {
      releaseRunB = resolve;
    });
    agentState.chatStream
      .mockImplementationOnce(async function* (
        _content,
        chatContext: { signal: AbortSignal }
      ) {
        signalA = chatContext.signal;
        yield { kind: 'turn_start', turn: 1, maxTurns: 10 };
        await waitForGateOrAbort(runGateA, chatContext.signal);
        return {
          success: true,
          finalMessage: 'workspace-a',
          metadata: { turnsCount: 1, toolCallsCount: 0, duration: 0 },
        };
      })
      .mockImplementationOnce(async function* (
        _content,
        chatContext: { signal: AbortSignal }
      ) {
        signalB = chatContext.signal;
        yield { kind: 'turn_start', turn: 1, maxTurns: 10 };
        await runGateB;
        return {
          success: true,
          finalMessage: 'workspace-b',
          metadata: { turnsCount: 1, toolCallsCount: 0, duration: 0 },
        };
      });

    const app = SessionRoutes();
    const sendMessage = (projectPath: string, content: string) =>
      app.request(
        `/shared-session/message?projectPath=${encodeURIComponent(projectPath)}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content }),
        }
      );

    const [messageA, messageB] = await Promise.all([
      sendMessage('/tmp/workspace-a', 'run a'),
      sendMessage('/tmp/workspace-b', 'run b'),
    ]);
    expect(messageA.status).toBe(202);
    expect(messageB.status).toBe(202);

    const deleteA = await app.request(
      `/shared-session?projectPath=${encodeURIComponent('/tmp/workspace-a')}`,
      {
        method: 'DELETE',
      }
    );

    expect(deleteA.status).toBe(200);
    deletedProjectPaths.add('/tmp/workspace-a');
    expect(SessionService.deleteSession).toHaveBeenCalledWith(
      'shared-session',
      '/tmp/workspace-a'
    );
    expect(signalA?.aborted).toBe(true);
    expect(signalB?.aborted).toBe(false);
    expect(disposeA).toHaveBeenCalledTimes(1);
    expect(disposeB).not.toHaveBeenCalled();

    const getA = await app.request(
      `/shared-session?projectPath=${encodeURIComponent('/tmp/workspace-a')}`
    );
    const getB = await app.request(
      `/shared-session?projectPath=${encodeURIComponent('/tmp/workspace-b')}`
    );
    const historyAfterDeleteB = await app.request(
      `/shared-session/message?projectPath=${encodeURIComponent('/tmp/workspace-b')}`
    );

    expect(getA.status).toBe(404);
    expect(getB.status).toBe(200);
    expect(await getB.json()).toMatchObject({
      sessionId: 'shared-session',
      projectPath: '/tmp/workspace-b',
      title: 'Workspace B',
    });
    expect(historyAfterDeleteB.status).toBe(200);
    expect(await historyAfterDeleteB.json()).toEqual(historyB);

    releaseRunA();
    releaseRunB();

    vi.clearAllMocks();
    busState.subscribers.clear();
    vi.mocked(SessionService.listSessions).mockResolvedValue([metadataA, metadataB]);

    const ambiguousDelete = await app.request('/shared-session', {
      method: 'DELETE',
    });

    expect(ambiguousDelete.status).toBe(409);
    await expect(ambiguousDelete.json()).resolves.toMatchObject({
      error: { code: 'AMBIGUOUS_SESSION' },
    });
    expect(SessionService.deleteSession).not.toHaveBeenCalled();
  });

  it('keeps volatile session state after durable delete failure while marking the run cancelled', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');

    const metadata = metadataFor(
      'delete-failure-session',
      '/tmp/delete-failure-workspace',
      {
        title: 'Delete failure session',
      }
    );
    let deleted = false;
    const dispose = vi.fn().mockResolvedValue(undefined);
    const runtime = await createRuntimeDouble({ dispose });
    let observedSignal: AbortSignal | undefined;
    let releaseRun: () => void = () => undefined;
    const runGate = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });

    vi.mocked(SessionService.findSessionMetadata).mockImplementation(
      async (sessionId: string, projectPath?: string) => {
        if (
          deleted ||
          sessionId !== 'delete-failure-session' ||
          projectPath !== '/tmp/delete-failure-workspace'
        ) {
          return undefined;
        }
        return metadata;
      }
    );
    vi.mocked(SessionService.listSessions).mockResolvedValue([metadata]);
    vi.mocked(SessionRuntime.create).mockResolvedValue(runtime);
    agentState.chatStream.mockImplementationOnce(async function* (
      _content,
      chatContext: { signal: AbortSignal }
    ) {
      observedSignal = chatContext.signal;
      yield { kind: 'turn_start', turn: 1, maxTurns: 10 };
      await waitForGateOrAbort(runGate, chatContext.signal);
      return {
        success: true,
        finalMessage: 'delete failure reply',
        metadata: { turnsCount: 1, toolCallsCount: 0, duration: 0 },
      };
    });

    const app = SessionRoutes();
    const startResponse = await app.request(
      `/delete-failure-session/message?projectPath=${encodeURIComponent('/tmp/delete-failure-workspace')}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'start delete failure run' }),
      }
    );
    expect(startResponse.status).toBe(202);

    vi.mocked(SessionService.deleteSession).mockRejectedValueOnce(
      new Error('failed to delete /tmp/delete-failure-workspace/secret.jsonl')
    );

    const deleteResponse = await app.request(
      `/delete-failure-session?projectPath=${encodeURIComponent('/tmp/delete-failure-workspace')}`,
      {
        method: 'DELETE',
      }
    );
    expect(deleteResponse.status).toBe(500);
    expect(observedSignal?.aborted).toBe(true);
    expect(dispose).not.toHaveBeenCalled();

    const statusAfterFailure = await app.request(
      `/delete-failure-session/status?projectPath=${encodeURIComponent('/tmp/delete-failure-workspace')}`
    );
    expect(statusAfterFailure.status).toBe(200);
    expect(await statusAfterFailure.json()).toMatchObject({
      sessionId: 'delete-failure-session',
      projectPath: '/tmp/delete-failure-workspace',
      status: 'cancelled',
    });

    const getAfterFailure = await app.request(
      `/delete-failure-session?projectPath=${encodeURIComponent('/tmp/delete-failure-workspace')}`
    );
    expect(getAfterFailure.status).toBe(200);
    expect(await getAfterFailure.json()).toMatchObject({
      sessionId: 'delete-failure-session',
      projectPath: '/tmp/delete-failure-workspace',
      title: 'Delete failure session',
    });

    vi.mocked(SessionService.deleteSession).mockResolvedValueOnce(1);
    const retryDelete = await app.request(
      `/delete-failure-session?projectPath=${encodeURIComponent('/tmp/delete-failure-workspace')}`,
      {
        method: 'DELETE',
      }
    );
    expect(retryDelete.status).toBe(200);
    deleted = true;
    expect(dispose).toHaveBeenCalledTimes(1);

    const statusAfterSuccess = await app.request(
      `/delete-failure-session/status?projectPath=${encodeURIComponent('/tmp/delete-failure-workspace')}`
    );
    expect(statusAfterSuccess.status).toBe(404);

    releaseRun();
  });

  it('aborts only the exact same-id workspace run and rejects duplicate no-path abort requests', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');

    const metadataA = metadataFor('shared-session', '/tmp/workspace-a');
    const metadataB = metadataFor('shared-session', '/tmp/workspace-b');

    vi.mocked(SessionService.findSessionMetadata).mockImplementation(
      async (sessionId: string, projectPath?: string) => {
        if (sessionId !== 'shared-session') {
          return undefined;
        }
        if (projectPath === '/tmp/workspace-a') {
          return metadataA;
        }
        if (projectPath === '/tmp/workspace-b') {
          return metadataB;
        }
        return undefined;
      }
    );
    vi.mocked(SessionService.listSessions).mockResolvedValue([metadataA, metadataB]);

    let signalA: AbortSignal | undefined;
    let signalB: AbortSignal | undefined;
    let releaseRunA: () => void = () => undefined;
    let releaseRunB: () => void = () => undefined;
    const runGateA = new Promise<void>((resolve) => {
      releaseRunA = resolve;
    });
    const runGateB = new Promise<void>((resolve) => {
      releaseRunB = resolve;
    });

    agentState.chatStream
      .mockImplementationOnce(async function* (
        _content,
        chatContext: { signal: AbortSignal }
      ) {
        if (Date.now() < 0) {
          yield undefined;
        }
        signalA = chatContext.signal;
        await waitForGateOrAbort(runGateA, chatContext.signal);
        return {
          success: true,
          finalMessage: 'workspace-a',
          metadata: { turnsCount: 1, toolCallsCount: 0, duration: 0 },
        };
      })
      .mockImplementationOnce(async function* (
        _content,
        chatContext: { signal: AbortSignal }
      ) {
        if (Date.now() < 0) {
          yield undefined;
        }
        signalB = chatContext.signal;
        await runGateB;
        return {
          success: true,
          finalMessage: 'workspace-b',
          metadata: { turnsCount: 1, toolCallsCount: 0, duration: 0 },
        };
      });

    const app = SessionRoutes();
    const startRun = (projectPath: string) =>
      app.request(
        `/shared-session/message?projectPath=${encodeURIComponent(projectPath)}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content: `start ${projectPath}` }),
        }
      );

    const [runA, runB] = await Promise.all([
      startRun('/tmp/workspace-a'),
      startRun('/tmp/workspace-b'),
    ]);
    expect(runA.status).toBe(202);
    expect(runB.status).toBe(202);

    const abortA = await app.request(
      `/shared-session/abort?projectPath=${encodeURIComponent('/tmp/workspace-a')}`,
      {
        method: 'POST',
      }
    );

    expect(abortA.status).toBe(200);

    const statusA = await app.request(
      `/shared-session/status?projectPath=${encodeURIComponent('/tmp/workspace-a')}`
    );
    const statusB = await app.request(
      `/shared-session/status?projectPath=${encodeURIComponent('/tmp/workspace-b')}`
    );

    expect(statusA.status).toBe(200);
    expect(await statusA.json()).toMatchObject({
      sessionId: 'shared-session',
      projectPath: '/tmp/workspace-a',
      status: 'cancelled',
    });
    expect(statusB.status).toBe(200);
    expect(await statusB.json()).toMatchObject({
      sessionId: 'shared-session',
      projectPath: '/tmp/workspace-b',
      status: 'running',
    });

    expect(signalA?.aborted).toBe(true);
    expect(signalB?.aborted).toBe(false);

    const ambiguousAbort = await app.request('/shared-session/abort', {
      method: 'POST',
    });

    expect(ambiguousAbort.status).toBe(409);
    await expect(ambiguousAbort.json()).resolves.toMatchObject({
      error: { code: 'AMBIGUOUS_SESSION' },
    });

    releaseRunA();
    releaseRunB();
  });

  it('returns exact same-id workspace status and rejects duplicate no-path status requests', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');

    const metadataA = metadataFor('shared-session', '/tmp/workspace-a');
    const metadataB = metadataFor('shared-session', '/tmp/workspace-b');

    vi.mocked(SessionService.findSessionMetadata).mockImplementation(
      async (sessionId: string, projectPath?: string) => {
        if (sessionId !== 'shared-session') {
          return undefined;
        }
        if (projectPath === '/tmp/workspace-a') {
          return metadataA;
        }
        if (projectPath === '/tmp/workspace-b') {
          return metadataB;
        }
        return undefined;
      }
    );
    vi.mocked(SessionService.listSessions).mockResolvedValue([metadataA, metadataB]);

    let releaseRunA: () => void = () => undefined;
    let releaseRunB: () => void = () => undefined;
    const runGateA = new Promise<void>((resolve) => {
      releaseRunA = resolve;
    });
    const runGateB = new Promise<void>((resolve) => {
      releaseRunB = resolve;
    });
    const runtimeA = await createRuntimeDouble();
    const runtimeB = await createRuntimeDouble();
    vi.mocked(SessionRuntime.create).mockImplementation(
      async ({ workspaceRoot }: SessionRuntimeOptions) => {
        if (workspaceRoot === '/tmp/workspace-a') {
          return runtimeA;
        }
        if (workspaceRoot === '/tmp/workspace-b') {
          return runtimeB;
        }
        return createRuntimeDouble();
      }
    );

    agentState.chatStream
      .mockImplementationOnce(async function* () {
        yield { kind: 'turn_start', turn: 1, maxTurns: 10 };
        await runGateA;
        return {
          success: true,
          finalMessage: 'workspace-a',
          metadata: { turnsCount: 1, toolCallsCount: 0, duration: 0 },
        };
      })
      .mockImplementationOnce(async function* () {
        yield { kind: 'turn_start', turn: 1, maxTurns: 10 };
        await runGateB;
        return {
          success: true,
          finalMessage: 'workspace-b',
          metadata: { turnsCount: 1, toolCallsCount: 0, duration: 0 },
        };
      });

    const app = SessionRoutes();
    const runA = await app.request(
      `/shared-session/message?projectPath=${encodeURIComponent('/tmp/workspace-a')}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'start a' }),
      }
    );
    expect(runA.status).toBe(202);

    const runB = await app.request(
      `/shared-session/message?projectPath=${encodeURIComponent('/tmp/workspace-b')}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'start b' }),
      }
    );
    expect(runB.status).toBe(202);

    const statusA = await app.request(
      `/shared-session/status?projectPath=${encodeURIComponent('/tmp/workspace-a')}`
    );
    const statusB = await app.request(
      `/shared-session/status?projectPath=${encodeURIComponent('/tmp/workspace-b')}`
    );

    expect(statusA.status).toBe(200);
    expect(await statusA.json()).toMatchObject({
      sessionId: 'shared-session',
      projectPath: '/tmp/workspace-a',
      runId: expect.any(String),
      status: 'running',
    });
    expect(statusB.status).toBe(200);
    expect(await statusB.json()).toMatchObject({
      sessionId: 'shared-session',
      projectPath: '/tmp/workspace-b',
      runId: expect.any(String),
      status: 'running',
    });

    const ambiguousStatus = await app.request('/shared-session/status');
    expect(ambiguousStatus.status).toBe(409);
    await expect(ambiguousStatus.json()).resolves.toMatchObject({
      error: { code: 'AMBIGUOUS_SESSION' },
    });

    releaseRunA();
    releaseRunB();
  });

  it('routes permission responses through the unified exact session resolver', async () => {
    const permissionApp = await createPermissionsApp();

    const relativeProjectPath = await permissionApp.request(
      '/permissions/perm-1?sessionId=shared-session&projectPath=relative-path',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ approved: true }),
      }
    );
    expect(relativeProjectPath.status).toBe(400);
    await expect(relativeProjectPath.json()).resolves.toMatchObject({
      error: { code: 'BAD_REQUEST' },
    });

    const explicitMissing = await permissionApp.request(
      `/permissions/perm-1?sessionId=shared-session&projectPath=${encodeURIComponent('/tmp/workspace-a')}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ approved: true }),
      }
    );
    expect(explicitMissing.status).toBe(404);
    expect(SessionService.findSessionMetadata).toHaveBeenCalledWith(
      'shared-session',
      '/tmp/workspace-a'
    );

    vi.mocked(SessionService.listSessions).mockResolvedValue([
      makeSessionMetadata({
        sessionId: 'shared-session',
        projectPath: '/tmp/workspace-a',
        title: 'Workspace A',
        messageCount: 1,
      }),
      makeSessionMetadata({
        sessionId: 'shared-session',
        projectPath: '/tmp/workspace-b',
        title: 'Workspace B',
        messageCount: 1,
      }),
    ]);

    const ambiguous = await permissionApp.request(
      '/permissions/perm-1?sessionId=shared-session',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ approved: true }),
      }
    );
    expect(ambiguous.status).toBe(409);
    await expect(ambiguous.json()).resolves.toMatchObject({
      error: { code: 'AMBIGUOUS_SESSION' },
    });
  });

  it('applies permission responses only to the exact matching same-id workspace run', async () => {
    const app = await createSessionAndPermissionApp();
    const resolvedPermissions: string[] = [];

    agentState.chatStream.mockImplementation(async function* (
      _content,
      chatContext: {
        workspaceRoot: string;
        confirmationHandler: {
          requestConfirmation: (details: {
            toolName: string;
            message: string;
            args?: Record<string, unknown>;
          }) => Promise<{ approved: boolean }>;
        };
      }
    ) {
      await chatContext.confirmationHandler.requestConfirmation({
        toolName: 'Read',
        message: `Need approval for ${chatContext.workspaceRoot}`,
        args: {},
      });
      if (Date.now() < 0) {
        yield undefined;
      }
      resolvedPermissions.push(chatContext.workspaceRoot);
      return {
        success: true,
        finalMessage: `approved ${chatContext.workspaceRoot}`,
        metadata: { turnsCount: 1, toolCallsCount: 0, duration: 0 },
      };
    });

    vi.mocked(SessionService.findSessionMetadata).mockImplementation(
      async (sessionId: string, projectPath?: string) => {
        if (
          sessionId === 'shared-session' &&
          (projectPath === '/tmp/workspace-a' || projectPath === '/tmp/workspace-b')
        ) {
          return makeSessionMetadata({
            sessionId,
            projectPath,
            title: `Session ${projectPath?.slice(-1)}`,
          });
        }
        return undefined;
      }
    );

    const messageRequest = (projectPath: string) =>
      app.request(
        `/sessions/shared-session/message?projectPath=${encodeURIComponent(projectPath)}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content: `run in ${projectPath}` }),
        }
      );

    const [firstMessageResponse, secondMessageResponse] = await Promise.all([
      messageRequest('/tmp/workspace-a'),
      messageRequest('/tmp/workspace-b'),
    ]);
    expect(firstMessageResponse.status).toBe(202);
    expect(secondMessageResponse.status).toBe(202);

    await vi.waitFor(() => {
      const permissionCalls = vi
        .mocked(busState.publish)
        .mock.calls.filter(([, type]) => type === 'permission.asked');
      expect(permissionCalls).toHaveLength(2);
    });

    const permissionCalls = vi
      .mocked(busState.publish)
      .mock.calls.filter(([, type]) => type === 'permission.asked');
    const firstPermissionCall = permissionCalls.find(
      ([ref]) => ref.projectPath === '/tmp/workspace-a'
    );
    const secondPermissionCall = permissionCalls.find(
      ([ref]) => ref.projectPath === '/tmp/workspace-b'
    );
    expect(firstPermissionCall).toBeDefined();
    expect(secondPermissionCall).toBeDefined();

    const firstPermissionId = String(firstPermissionCall?.[2].requestId);
    const secondPermissionId = String(secondPermissionCall?.[2].requestId);

    const pendingSessionsResponse = await app.request('/sessions');
    expect(pendingSessionsResponse.status).toBe(200);
    const pendingSessions = (await pendingSessionsResponse.json()) as Array<{
      projectPath: string;
      pendingInteraction?: { type: string; requestId: string };
    }>;
    expect(
      pendingSessions.find((session) => session.projectPath === '/tmp/workspace-a')
    ).toMatchObject({
      pendingInteraction: {
        type: 'permission',
        requestId: firstPermissionId,
      },
    });
    expect(
      pendingSessions.find((session) => session.projectPath === '/tmp/workspace-b')
    ).toMatchObject({
      pendingInteraction: {
        type: 'permission',
        requestId: secondPermissionId,
      },
    });

    const firstPermissionResponse = await app.request(
      `/permissions/${firstPermissionId}?sessionId=shared-session&projectPath=${encodeURIComponent('/tmp/workspace-a')}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ approved: true }),
      }
    );
    expect(firstPermissionResponse.status).toBe(200);

    await vi.waitFor(() => {
      expect(resolvedPermissions).toEqual(['/tmp/workspace-a']);
      expect(busState.publish).toHaveBeenCalledWith(
        { sessionId: 'shared-session', projectPath: '/tmp/workspace-a' },
        'interaction.resolved',
        { requestId: firstPermissionId }
      );
    });

    const secondPermissionResponse = await app.request(
      `/permissions/${secondPermissionId}?sessionId=shared-session&projectPath=${encodeURIComponent('/tmp/workspace-b')}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ approved: true }),
      }
    );
    expect(secondPermissionResponse.status).toBe(200);

    await vi.waitFor(() => {
      expect(resolvedPermissions).toEqual(['/tmp/workspace-a', '/tmp/workspace-b']);
    });
  });

  it('routes goal creation and continuation to the exact session workspace', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');
    const metadataA = metadataFor('shared-goal', '/tmp/workspace-a');
    const metadataB = metadataFor('shared-goal', '/tmp/workspace-b');
    const goal = {
      version: 1 as const,
      sessionId: 'shared-goal',
      goalId: 'goal-a',
      objective: 'finish workspace A',
      status: 'active' as const,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      continuationCount: 0,
      createdAt: '2026-08-05T00:00:00.000Z',
      updatedAt: '2026-08-05T00:00:00.000Z',
    };
    const createGoalA = vi.fn().mockResolvedValue(goal);
    const createGoalB = vi.fn();
    const runtimeA = await createRuntimeDouble({
      workspaceRoot: '/tmp/workspace-a',
      createGoal: createGoalA,
    });
    const runtimeB = await createRuntimeDouble({
      workspaceRoot: '/tmp/workspace-b',
      createGoal: createGoalB,
    });

    vi.mocked(SessionService.listSessions).mockResolvedValue([metadataA, metadataB]);
    vi.mocked(SessionService.findSessionMetadata).mockImplementation(
      async (sessionId: string, projectPath?: string) => {
        if (sessionId !== 'shared-goal') return undefined;
        if (projectPath === '/tmp/workspace-a') return metadataA;
        if (projectPath === '/tmp/workspace-b') return metadataB;
        return undefined;
      }
    );
    vi.mocked(SessionRuntime.create).mockImplementation(
      async ({ workspaceRoot }: SessionRuntimeOptions) =>
        workspaceRoot === '/tmp/workspace-a' ? runtimeA : runtimeB
    );

    const app = SessionRoutes();
    const response = await app.request(
      `/shared-goal/goal?projectPath=${encodeURIComponent('/tmp/workspace-a')}`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ objective: 'finish workspace A' }),
      }
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      status: 'running',
      goal,
    });
    expect(createGoalA).toHaveBeenCalledWith({
      objective: 'finish workspace A',
    });
    expect(createGoalB).not.toHaveBeenCalled();
    expect(busState.publish).toHaveBeenCalledWith(
      { sessionId: 'shared-goal', projectPath: '/tmp/workspace-a' },
      'goal.updated',
      { goal }
    );
    await vi.waitFor(() => {
      expect(agentState.chatStream).toHaveBeenCalledWith(
        '',
        expect.objectContaining({
          sessionId: 'shared-goal',
          workspaceRoot: '/tmp/workspace-a',
        }),
        expect.objectContaining({ goalContinuationOnly: true })
      );
    });

    const ambiguous = await app.request('/shared-goal/goal', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ objective: 'must not guess a workspace' }),
    });
    expect(ambiguous.status).toBe(409);
    expect(createGoalB).not.toHaveBeenCalled();
  });

  it('lists and rewinds checkpoints in the exact session workspace', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');
    const metadataA = metadataFor('shared-rewind', '/tmp/workspace-a');
    const metadataB = metadataFor('shared-rewind', '/tmp/workspace-b');
    const checkpoints = [
      {
        messageId: 'user-a',
        preview: 'rewind workspace A',
        createdAt: '2026-08-05T00:00:00.000Z',
        fileCount: 1,
      },
    ];
    const rewoundMessages = makeMessages({
      role: 'user',
      content: 'kept message',
    });
    const listA = vi.fn().mockResolvedValue(checkpoints);
    const listB = vi.fn();
    const rewindA = vi.fn().mockResolvedValue({
      checkpoint: checkpoints[0],
      mode: 'both',
      removedTurns: 1,
      restoredFiles: ['/tmp/workspace-a/result.txt'],
      messages: rewoundMessages,
    });
    const rewindB = vi.fn();
    const runtimeA = await createRuntimeDouble({
      workspaceRoot: '/tmp/workspace-a',
      listRewindCheckpoints: listA,
      rewindSession: rewindA,
    });
    const runtimeB = await createRuntimeDouble({
      workspaceRoot: '/tmp/workspace-b',
      listRewindCheckpoints: listB,
      rewindSession: rewindB,
    });

    vi.mocked(SessionService.listSessions).mockResolvedValue([metadataA, metadataB]);
    vi.mocked(SessionService.findSessionMetadata).mockImplementation(
      async (sessionId: string, projectPath?: string) => {
        if (sessionId !== 'shared-rewind') return undefined;
        if (projectPath === '/tmp/workspace-a') return metadataA;
        if (projectPath === '/tmp/workspace-b') return metadataB;
        return undefined;
      }
    );
    vi.mocked(SessionRuntime.create).mockImplementation(
      async ({ workspaceRoot }: SessionRuntimeOptions) =>
        workspaceRoot === '/tmp/workspace-a' ? runtimeA : runtimeB
    );

    const app = SessionRoutes();
    const listResponse = await app.request(
      `/shared-rewind/rewind?projectPath=${encodeURIComponent('/tmp/workspace-a')}`
    );
    expect(listResponse.status).toBe(200);
    await expect(listResponse.json()).resolves.toEqual({ checkpoints });
    expect(listA).toHaveBeenCalledOnce();
    expect(listB).not.toHaveBeenCalled();

    const rewindResponse = await app.request(
      `/shared-rewind/rewind?projectPath=${encodeURIComponent('/tmp/workspace-a')}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ targetMessageId: 'user-a', mode: 'both' }),
      }
    );
    expect(rewindResponse.status).toBe(200);
    await expect(rewindResponse.json()).resolves.toMatchObject({
      checkpoint: checkpoints[0],
      mode: 'both',
      removedTurns: 1,
      restoredFiles: ['/tmp/workspace-a/result.txt'],
    });
    expect(rewindA).toHaveBeenCalledWith({
      targetMessageId: 'user-a',
      mode: 'both',
    });
    expect(rewindB).not.toHaveBeenCalled();
    expect(busState.publish).toHaveBeenCalledWith(
      { sessionId: 'shared-rewind', projectPath: '/tmp/workspace-a' },
      'session.rewound',
      expect.objectContaining({
        targetMessageId: 'user-a',
        mode: 'both',
      })
    );

    const messagesResponse = await app.request(
      `/shared-rewind/message?projectPath=${encodeURIComponent('/tmp/workspace-a')}`
    );
    await expect(messagesResponse.json()).resolves.toEqual(rewoundMessages);

    const ambiguous = await app.request('/shared-rewind/rewind');
    expect(ambiguous.status).toBe(409);
    expect(listB).not.toHaveBeenCalled();
  });

  it('lists and resumes durable subagents in the exact session workspace', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');
    const metadataA = metadataFor('shared-subagents', '/tmp/workspace-a');
    const metadataB = metadataFor('shared-subagents', '/tmp/workspace-b');
    const source = {
      schemaVersion: 2 as const,
      id: 'agent-source',
      subagentType: 'Explore',
      description: 'Inspect code',
      prompt: 'Inspect code',
      messages: [],
      status: 'completed' as const,
      createdAt: 1,
      lastActiveAt: 2,
      completedAt: 2,
      parentSessionId: 'shared-subagents',
      parentProjectPath: '/tmp/workspace-a',
      rootAgentId: 'agent-source',
      resumeDepth: 0,
      workspaceRoot: '/tmp/workspace-a',
      result: { success: true, message: 'Initial finding' },
    };
    const child = {
      ...source,
      id: 'agent-child',
      status: 'running' as const,
      createdAt: 3,
      lastActiveAt: 3,
      completedAt: undefined,
      resumedFrom: source.id,
      rootAgentId: source.id,
      resumeDepth: 1,
      result: undefined,
    };
    const completedChild = {
      ...child,
      status: 'completed' as const,
      completedAt: 4,
      result: { success: true, message: 'Follow-up complete' },
    };
    const listA = vi.fn(() => [source]);
    const listB = vi.fn(() => []);
    const resumeA = vi.fn(
      (options: {
        agentId: string;
        prompt: string;
        onEvent?: (event: LoopEvent, agentId: string) => void;
        onCompleted?: (session: typeof completedChild) => void;
      }) => {
        options.onEvent?.({ kind: 'content_delta', delta: 'follow-up' }, child.id);
        options.onCompleted?.(completedChild);
        return { source, session: child };
      }
    );
    const resumeB = vi.fn();
    const runtimeA = await createRuntimeDouble({
      workspaceRoot: '/tmp/workspace-a',
      listSubagents: listA as any,
      resumeSubagent: resumeA,
    });
    const runtimeB = await createRuntimeDouble({
      workspaceRoot: '/tmp/workspace-b',
      listSubagents: listB,
      resumeSubagent: resumeB,
    });

    vi.mocked(SessionService.listSessions).mockResolvedValue([metadataA, metadataB]);
    vi.mocked(SessionService.findSessionMetadata).mockImplementation(
      async (sessionId: string, projectPath?: string) => {
        if (sessionId !== 'shared-subagents') return undefined;
        if (projectPath === '/tmp/workspace-a') return metadataA;
        if (projectPath === '/tmp/workspace-b') return metadataB;
        return undefined;
      }
    );
    vi.mocked(SessionRuntime.create).mockImplementation(
      async ({ workspaceRoot }: SessionRuntimeOptions) =>
        workspaceRoot === '/tmp/workspace-a' ? runtimeA : runtimeB
    );

    const app = SessionRoutes();
    const listed = await app.request(
      `/shared-subagents/subagents?projectPath=${encodeURIComponent('/tmp/workspace-a')}`
    );
    expect(listed.status).toBe(200);
    await expect(listed.json()).resolves.toEqual({
      subagents: [
        expect.objectContaining({
          id: source.id,
          rootAgentId: source.id,
          resumeDepth: 0,
        }),
      ],
    });
    expect(listA).toHaveBeenCalledOnce();
    expect(listB).not.toHaveBeenCalled();

    const resumed = await app.request(
      `/shared-subagents/subagents/${source.id}/resume?projectPath=${encodeURIComponent('/tmp/workspace-a')}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'Check the follow-up' }),
      }
    );
    expect(resumed.status).toBe(200);
    await expect(resumed.json()).resolves.toMatchObject({
      source: { id: source.id },
      session: {
        id: child.id,
        resumedFrom: source.id,
        rootAgentId: source.id,
        resumeDepth: 1,
      },
    });
    expect(resumeA).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: source.id,
        prompt: 'Check the follow-up',
      })
    );
    expect(resumeB).not.toHaveBeenCalled();
    expect(busState.publish).toHaveBeenCalledWith(
      { sessionId: 'shared-subagents', projectPath: '/tmp/workspace-a' },
      'subagent.start',
      expect.objectContaining({
        subagentSessionId: child.id,
        resumedFrom: source.id,
        resumeDepth: 1,
      })
    );
    expect(busState.publish).toHaveBeenCalledWith(
      { sessionId: 'shared-subagents', projectPath: '/tmp/workspace-a' },
      'subagent.complete',
      expect.objectContaining({
        subagentSessionId: child.id,
        success: true,
      })
    );

    const ambiguous = await app.request('/shared-subagents/subagents');
    expect(ambiguous.status).toBe(409);
    expect(listB).not.toHaveBeenCalled();
  });

  it('returns a generic internal error body when an unexpected session route error occurs', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');

    vi.mocked(SessionService.findSessionMetadata).mockRejectedValueOnce(
      new Error('failed to parse /secret/path.jsonl')
    );

    const app = SessionRoutes();
    const response = await app.request(
      `/secretive/events?projectPath=${encodeURIComponent('/tmp/workspace-a')}`
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Internal server error',
      },
    });
  });

  it('returns a generic internal error when listing sessions fails instead of leaking paths or returning []', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');

    vi.mocked(SessionService.listSessions).mockRejectedValueOnce(
      new Error('scan failed for /secret/workspaces/project/.blade/sessions')
    );

    const app = SessionRoutes();
    const response = await app.request('/');
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toMatchObject({
      error: {
        code: 'INTERNAL_ERROR',
      },
    });
    expect(body.error.message).not.toContain(
      '/secret/workspaces/project/.blade/sessions'
    );
  });

  it('executes a user shell command through the exact Session runtime', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');
    const { SessionService } = await import(
      '../../../../src/services/SessionService.js'
    );
    vi.mocked(SessionService.findSessionMetadata).mockResolvedValue(
      makeSessionMetadata({
        sessionId: 'shell-session',
        projectPath: '/tmp/shell-workspace',
      })
    );
    vi.mocked(SessionService.loadSession).mockResolvedValue([]);
    runtimeState.runtime.executeUserShellCommand.mockResolvedValueOnce({
      executionId: 'shell-execution',
      messageId: 'shell-message',
      record: {
        version: 1,
        command: 'pwd',
        status: 'completed',
        exitCode: 0,
        durationMs: 4,
        stdout: '/tmp/shell-workspace',
        stderr: '',
        stdoutOmittedBytes: 0,
        stderrOmittedBytes: 0,
        binaryOutput: false,
        truncated: false,
      },
      modelContent: '<user_shell_command>pwd</user_shell_command>',
      auxiliary: false,
    });

    const response = await SessionRoutes().request('/shell-session/shell', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        command: 'pwd',
        projectPath: '/tmp/shell-workspace',
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      executionId: 'shell-execution',
      record: {
        command: 'pwd',
        stdout: '/tmp/shell-workspace',
      },
    });
    expect(runtimeState.runtime.executeUserShellCommand).toHaveBeenCalledWith('pwd', {
      signal: expect.any(AbortSignal),
    });
    expect(SessionService.loadSession).toHaveBeenCalledWith(
      'shell-session',
      '/tmp/shell-workspace'
    );
    expect(agentState.chatStream).not.toHaveBeenCalled();
  });

  it('answers a side question without creating or steering a main run', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');
    vi.mocked(SessionService.findSessionMetadata).mockResolvedValue(
      makeSessionMetadata({
        sessionId: 'side-session',
        projectPath: '/tmp/side-workspace',
      })
    );
    vi.mocked(SessionService.loadSession).mockResolvedValue([
      { role: 'user', content: 'Persisted context' },
    ]);
    runtimeState.runtime.hasActiveTurn.mockReturnValue(true);
    runtimeState.runtime.askSideQuestion.mockResolvedValueOnce({
      response: 'The main run is still active.',
      durationMs: 17,
      usage: {
        promptTokens: 40,
        completionTokens: 8,
        totalTokens: 48,
      },
    });

    const response = await SessionRoutes().request('/side-session/side-question', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        question: 'What is running?',
        projectPath: '/tmp/side-workspace',
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      response: 'The main run is still active.',
      durationMs: 17,
      modelId: 'model-1',
      usage: {
        promptTokens: 40,
        completionTokens: 8,
        totalTokens: 48,
      },
    });
    expect(runtimeState.runtime.askSideQuestion).toHaveBeenCalledWith(
      'What is running?',
      { signal: expect.any(AbortSignal) }
    );
    expect(runtimeState.runtime.prepareInputTurn).not.toHaveBeenCalled();
    expect(runtimeState.runtime.enqueueSteering).not.toHaveBeenCalled();
    expect(agentState.chatStream).not.toHaveBeenCalled();
  });
});
