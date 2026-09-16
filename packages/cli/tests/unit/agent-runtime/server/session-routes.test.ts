import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Agent } from '../../../../src/agent/Agent.js';
import type { LoopEvent } from '../../../../src/agent/loop/types.js';
import { resolveWorkspaceAgentResources } from '../../../../src/agent/resources/WorkspaceAgentResources.js';
import { resolveWorkspaceModelResources } from '../../../../src/agent/resources/WorkspaceModelResources.js';
import type {
  InputTurnPreparation,
  SteeringEnqueueResult,
} from '../../../../src/agent/runtime/ActiveTurnMailbox.js';
import {
  SessionRuntime,
  type SessionRuntimeOptions,
} from '../../../../src/agent/runtime/SessionRuntime.js';
import { taskRunScheduler } from '../../../../src/agent/runtime/TaskRunScheduler.js';
import {
  MAX_INLINE_ATTACHMENT_BYTES,
  MAX_USER_MESSAGE_TEXT_CHARS,
} from '../../../../src/api/attachmentLimits.js';
import type { FollowUpQueueSnapshot } from '../../../../src/api/followUpQueueSchemas.js';
import { PermissionMode } from '../../../../src/config/types.js';
import type { ProjectedSessionInteraction } from '../../../../src/context/interactions.js';
import { getBladeStorageRoot } from '../../../../src/context/storage/pathUtils.js';
import type { SessionEvent } from '../../../../src/context/types.js';
import type { Message } from '../../../../src/services/ChatServiceInterface.js';
import type {
  SessionMetadata,
  SessionMetadataUpdate,
} from '../../../../src/services/SessionService.js';
import { SessionService } from '../../../../src/services/SessionService.js';
import { sessionRouteLoopEvents } from '../../../support/comprehensiveLoopEvents.js';

const DEFAULT_PROJECT_PATH =
  '/Users/bytedance/Documents/GitHub/Blade/.worktrees/session-discovery-fork/packages/cli';

type EventReplaySubscriber = {
  onCommitted(event: SessionEvent): void | Promise<void>;
};

type RequestableApp = Pick<Hono<{ Variables: { directory: string } }>, 'request'>;

const requestJson = (
  app: RequestableApp,
  path: string,
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  body: unknown
) =>
  app.request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const loadSessionRoutes = async () =>
  (await import('../../../../src/server/routes/session.js')).SessionRoutes;
const loadSessionRouteController = async () =>
  (await import('../../../../src/server/routes/session.js'))
    .createSessionRouteController;
const loadSessionService = async () =>
  (await import('../../../../src/services/SessionService.js')).SessionService;
const loadBus = async () => (await import('../../../../src/server/bus.js')).Bus;

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

const makeFollowUpQueueSnapshot = (
  overrides: Partial<FollowUpQueueSnapshot> = {}
): FollowUpQueueSnapshot => ({
  version: 'a'.repeat(64),
  pending: 1,
  mutable: 1,
  locked: 0,
  internal: 0,
  items: [
    {
      id: 'follow-up-1',
      position: 0,
      queuedAt: '2026-09-05T00:00:00.000Z',
      kind: 'user',
      state: 'pending',
      delivery: 'current_turn',
      mutable: true,
      preview: 'Updated requirement',
      previewTruncated: false,
      attachmentCount: 0,
    },
  ],
  ...overrides,
});

const makeSteeringEnqueueResult = (): SteeringEnqueueResult => ({
  accepted: true,
  messageId: 'steering-input',
  turnId: 'turn-1',
  queued: 1,
  delivery: 'current_turn',
  queue: makeFollowUpQueueSnapshot(),
});

const makeProviderRecoveryBudgetFailure = (detail = 'opaque') => ({
  success: false as const,
  error: {
    type: 'api_error' as const,
    message: 'Provider request failed.',
    details: Object.assign(new Error(detail), {
      code: 'PROVIDER_RECOVERY_BUDGET_EXCEEDED',
    }),
  },
  metadata: { turnsCount: 1, toolCallsCount: 0, duration: 0 },
});

function promiseGate<T = void>(): readonly [
  Promise<T>,
  (value?: T | PromiseLike<T>) => void,
] {
  let settle!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    settle = resolvePromise;
  });
  const resolve = (value?: T | PromiseLike<T>) => settle(value as T | PromiseLike<T>);
  return [promise, resolve] as const;
}

function mockPendingResume(metadata: SessionMetadata): void {
  vi.mocked(SessionService.listSessions).mockResolvedValue([metadata]);
  vi.mocked(SessionService.findSessionMetadata).mockResolvedValue(metadata);
  vi.mocked(SessionRuntime.hasPendingInbox).mockResolvedValue(true);
  runtimeState.runtime.getPendingSteeringCount.mockReturnValue(1);
}

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
  ...overrides,
  sessionId: overrides.sessionId,
  projectPath: overrides.projectPath,
  rootId: overrides.rootId ?? overrides.sessionId,
  title: overrides.title ?? `Session ${overrides.sessionId}`,
  taskStatus: overrides.taskStatus ?? 'completed',
  messageCount: overrides.messageCount ?? 0,
  firstMessageTime: overrides.firstMessageTime ?? new Date(0).toISOString(),
  lastMessageTime: overrides.lastMessageTime ?? new Date(1).toISOString(),
  hasErrors: overrides.hasErrors ?? false,
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
    getFollowUpQueueSnapshot: vi.fn(async () => makeFollowUpQueueSnapshot()),
    getProviderRecoveryProjection: vi.fn(() => ({
      version: 1 as const,
      generation: 'provider-recovery-generation',
      revision: 1,
      snapshot: {
        activity: 'retry_wait' as const,
        reason: 'rate_limit' as const,
        updatedAt: 1_000,
        nextActionAt: 3_000,
        retry: { attempt: 1, maxRetries: 12, delayMs: 2_000 },
      },
    })),
    getTurnActivityProjection: vi.fn(() => ({
      version: 1 as const,
      generation: 'turn-activity-generation',
      revision: 2,
      snapshot: {
        phase: 'executing_tools' as const,
        startedAt: 1_000,
        updatedAt: 2_000,
        turn: 1,
        maxTurns: 20,
        outputStarted: true,
        toolCallsStarted: 1,
        toolCallsCompleted: 0,
        activeTools: [{ name: 'Bash', kind: 'execute' as const, startedAt: 1_500 }],
        activeToolOverflow: 0,
      },
    })),
    mutateFollowUpQueue: vi.fn(async () => ({
      snapshot: makeFollowUpQueueSnapshot({
        version: 'b'.repeat(64),
        pending: 0,
        mutable: 0,
        items: [],
      }),
    })),
    getRecoveredSteeringCount: vi.fn(() => 0),
    getTurnRecoveryAssessment: vi.fn<
      () => ReturnType<SessionRuntime['getTurnRecoveryAssessment']>
    >(() => ({ state: 'none' })),
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
    askSideQuestion: vi.fn<SessionRuntime['askSideQuestion']>().mockResolvedValue({
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
const projectionResidencyConfig = vi.hoisted(() => ({
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

const loggerState = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../../../src/agent/runtime/SessionRuntime.js', () => ({
  SessionRuntime: {
    create: vi.fn(async () => runtimeState.runtime),
    hasPendingInbox: vi.fn(async () => false),
    hasDurableFollowUpInbox: vi.fn(async () => false),
    hasActiveGoal: vi.fn(async () => false),
    hasRecoverableTurn: vi.fn(async () => false),
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
    maxResidentSessionProjections: projectionResidencyConfig.maxResident,
    sessionProjectionIdleMs: projectionResidencyConfig.idleMs,
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
  resolveWorkspaceAgentResources: vi.fn(async (workspaceRoot: string) => ({
    workspaceRoot,
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
  snapshotWorkspaceAgentResources: vi.fn((resources: { workspaceRoot: string }) => ({
    ...resources,
    projectRoot: resources.workspaceRoot,
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
  WorktreeUnavailableError: class WorktreeUnavailableError extends Error {
    readonly name = 'WorktreeUnavailableError';

    constructor(public readonly reason: string) {
      super('Task worktree is no longer available');
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
        options: {
          newSessionId?: string;
          sourceProjectPath: string;
          targetProjectPath: string;
        }
      ) => {
        const childSessionId = options.newSessionId ?? 'forked-session';
        return {
          sessionId: childSessionId,
          parentSessionId: sessionId,
          projectPath: options.targetProjectPath,
          messages: makeMessages(),
          metadata: makeSessionMetadata({
            sessionId: childSessionId,
            projectPath: options.targetProjectPath,
            parentId: sessionId,
            relationType: 'fork',
            rootId: sessionId,
            lastMessageTime: new Date(0).toISOString(),
          }),
        };
      }
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
  createLogger: vi.fn(() => loggerState),
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
    async readDone(timeoutMs = 2000) {
      return new Promise<{ done: boolean }>((resolve, reject) => {
        const timer = setTimeout(
          () =>
            reject(
              new Error(`Timed out waiting for SSE stream completion (${timeoutMs}ms)`)
            ),
          timeoutMs
        );
        reader.read().then(
          (result) => {
            clearTimeout(timer);
            resolve(result);
          },
          (error) => {
            clearTimeout(timer);
            reject(error);
          }
        );
      });
    },
  };
}

async function closeSse(
  controller: { shutdown(): Promise<void> },
  signal: AbortController,
  response: Response
): Promise<void> {
  signal.abort();
  await response.body?.cancel().catch(() => undefined);
  await controller.shutdown();
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
    projectionResidencyConfig.maxResident = 256;
    projectionResidencyConfig.idleMs = 300_000;
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
    runtimeState.runtime.enqueueSteering.mockReset();
    runtimeState.runtime.setTaskAdmission.mockClear();
    runtimeState.runtime.setTaskStatus.mockReset().mockResolvedValue(undefined);
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
    runtimeState.runtime.getFollowUpQueueSnapshot
      .mockReset()
      .mockResolvedValue(makeFollowUpQueueSnapshot());
    runtimeState.runtime.getProviderRecoveryProjection.mockReturnValue({
      version: 1,
      generation: 'provider-recovery-generation',
      revision: 1,
      snapshot: {
        activity: 'retry_wait',
        reason: 'rate_limit',
        updatedAt: 1_000,
        nextActionAt: 3_000,
        retry: { attempt: 1, maxRetries: 12, delayMs: 2_000 },
      },
    });
    runtimeState.runtime.mutateFollowUpQueue.mockReset().mockResolvedValue({
      snapshot: makeFollowUpQueueSnapshot({
        version: 'b'.repeat(64),
        pending: 0,
        mutable: 0,
        items: [],
      }),
    });
    runtimeState.runtime.getRecoveredSteeringCount.mockReturnValue(0);
    runtimeState.runtime.getTurnRecoveryAssessment.mockReturnValue({ state: 'none' });
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
    loggerState.debug.mockReset();
    loggerState.info.mockReset();
    loggerState.warn.mockReset();
    loggerState.error.mockReset();
    vi.mocked(SessionRuntime.create).mockImplementation(
      async (options: SessionRuntimeOptions) =>
        createRuntimeDouble({
          sessionId: options.sessionId,
          workspaceRoot: options.workspaceRoot,
        })
    );
    vi.mocked(SessionRuntime.hasPendingInbox).mockResolvedValue(false);
    vi.mocked(SessionRuntime.hasDurableFollowUpInbox).mockResolvedValue(false);
    vi.mocked(SessionRuntime.hasActiveGoal).mockResolvedValue(false);
    vi.mocked(SessionRuntime.hasRecoverableTurn).mockResolvedValue(false);
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
    agentState.chatStream.mockReset().mockImplementation(async function* () {
      if (Date.now() < 0) {
        yield undefined;
      }
      return {
        success: true,
        finalMessage: 'assistant reply',
        metadata: { turnsCount: 1, toolCallsCount: 0, duration: 0 },
      };
    });
    agentState.destroy.mockReset().mockResolvedValue(undefined);
    vi.mocked(Agent.createWithRuntime)
      .mockReset()
      .mockImplementation(
        async () =>
          ({
            chatStream: agentState.chatStream,
            destroy: agentState.destroy,
          }) as unknown as Agent
      );
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
    expect(replay).toBeDefined();
    if (!replay) throw new Error('Expected committed tool result projection');
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
    expect(replay).toBeDefined();
    if (!replay) throw new Error('Expected committed tool result projection');

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

  it('does not replay client-hidden message content over SSE', async () => {
    const { projectCommittedSessionEvent } = await import(
      '../../../../src/server/routes/session.js'
    );
    const hidden: SessionEvent = {
      id: 'hidden-message-event',
      seq: 44,
      sessionId: 'replay-session',
      timestamp: '2026-09-06T00:00:00.000Z',
      type: 'message_created',
      cwd: DEFAULT_PROJECT_PATH,
      version: 'test',
      data: {
        messageId: 'hidden-message',
        role: 'user',
        createdAt: '2026-09-06T00:00:00.000Z',
        metadata: { clientVisible: false },
      },
    };
    const hiddenPart: SessionEvent = {
      id: 'hidden-part-event',
      seq: 45,
      sessionId: 'replay-session',
      timestamp: '2026-09-06T00:00:00.000Z',
      type: 'part_created',
      cwd: DEFAULT_PROJECT_PATH,
      version: 'test',
      data: {
        partId: 'hidden-part',
        messageId: 'hidden-message',
        partType: 'text',
        payload: { text: 'private hidden content' },
        createdAt: '2026-09-06T00:00:00.000Z',
      },
    };

    expect(projectCommittedSessionEvent(hidden)).toBeUndefined();
    expect(projectCommittedSessionEvent(hiddenPart)).toBeUndefined();
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
    const SessionRoutes = await loadSessionRoutes();

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

  const createMountedSessionApp = async () => {
    const SessionRoutes = await loadSessionRoutes();
    const app = new Hono<{ Variables: { directory: string } }>();
    app.use('*', async (context, next) => {
      context.set(
        'directory',
        context.req.query('directory') ??
          context.req.header('x-blade-directory') ??
          DEFAULT_PROJECT_PATH
      );
      return next();
    });
    app.route('/sessions', SessionRoutes());
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
      taskIsolation: SessionMetadata['taskIsolation'];
      taskStatus: SessionMetadata['taskStatus'];
    }> = {}
  ): SessionMetadata =>
    makeSessionMetadata({
      sessionId,
      projectPath,
      ...overrides,
    });

  const mockDuplicateSessions = (
    sessionId: string,
    overridesA: Parameters<typeof metadataFor>[2] = {},
    overridesB: Parameters<typeof metadataFor>[2] = {}
  ) => {
    const metadataA = metadataFor(sessionId, '/tmp/workspace-a', overridesA);
    const metadataB = metadataFor(sessionId, '/tmp/workspace-b', overridesB);
    vi.mocked(SessionService.listSessions).mockResolvedValue([metadataA, metadataB]);
    vi.mocked(SessionService.findSessionMetadata).mockImplementation(
      async (requestedSessionId, projectPath) => {
        if (requestedSessionId !== sessionId) return undefined;
        if (projectPath === metadataA.projectPath) return metadataA;
        if (projectPath === metadataB.projectPath) return metadataB;
        return undefined;
      }
    );
    return { metadataA, metadataB };
  };

  const mockResolvedSession = (
    sessionId: string,
    options: {
      projectPath?: string;
      messages?: Message[];
      permissionMode?: SessionMetadata['permissionMode'];
    } = {}
  ) => {
    const messages = options.messages ?? makeMessages();
    const metadata = metadataFor(sessionId, options.projectPath, {
      permissionMode: options.permissionMode,
      messageCount: messages.filter(
        (message) => message.role === 'user' || message.role === 'assistant'
      ).length,
    });
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

  it('hydrates an idle Session SSE projection without loading durable history', async () => {
    const createSessionRouteController = await loadSessionRouteController();
    const sessionId = 'history-free-sse-session';
    const projectPath = '/tmp/history-free-sse-workspace';
    mockResolvedSession(sessionId, {
      projectPath,
      messages: makeMessages(
        { role: 'user', content: 'durable user history' },
        { role: 'assistant', content: 'durable assistant history' }
      ),
    });
    const requestController = new AbortController();
    const controller = createSessionRouteController();
    const response = await controller.app.request(
      `/${sessionId}/events?projectPath=${encodeURIComponent(projectPath)}`,
      { signal: requestController.signal }
    );
    const collector = createSseCollector(response);

    try {
      expect(response.status).toBe(200);
      await expect(collector.next()).resolves.toMatchObject({ type: 'connected' });
      expect(SessionService.findSessionMetadata).toHaveBeenCalledWith(
        sessionId,
        projectPath
      );
      expect(SessionService.findSessionTaskWorktree).toHaveBeenCalledWith(
        sessionId,
        projectPath
      );
      expect(SessionService.loadSession).not.toHaveBeenCalled();
    } finally {
      requestController.abort();
      await collector.cancel();
      await controller.shutdown();
    }
  });

  it('returns projection capacity 429 for metadata-only after projection eviction Browser hydrate', async () => {
    const createSessionRouteController = await loadSessionRouteController();
    projectionResidencyConfig.maxResident = 1;
    const idleA = metadataFor('projection-browser-idle-a', '/tmp/projection-browser');
    const idleB = metadataFor('projection-browser-idle-b', '/tmp/projection-browser');
    const [hydrationGate, releaseHydration] = promiseGate();
    const [hydrationStarted, markHydrationStarted] = promiseGate();
    vi.mocked(SessionService.listSessions).mockResolvedValue([idleA, idleB]);
    vi.mocked(SessionService.findSessionMetadata).mockImplementation(
      async (sessionId, projectPath) => {
        const match = [idleA, idleB].find(
          (candidate) =>
            candidate.sessionId === sessionId && candidate.projectPath === projectPath
        );
        if (match?.sessionId === idleA.sessionId) {
          markHydrationStarted();
          await hydrationGate;
        }
        return match;
      }
    );
    const controller = createSessionRouteController();
    let firstResponse: Response | undefined;

    try {
      const firstResponsePromise = Promise.resolve(
        controller.app.request(
          `/${idleA.sessionId}/browser/reset?projectPath=${encodeURIComponent(idleA.projectPath)}`,
          { method: 'POST' }
        )
      );
      await hydrationStarted;

      const second = await controller.app.request(
        `/${idleB.sessionId}/browser/reset?projectPath=${encodeURIComponent(idleB.projectPath)}`,
        { method: 'POST' }
      );

      expect(second.status).toBe(429);
      await expect(second.json()).resolves.toEqual({
        error: {
          code: 'TOO_MANY_REQUESTS',
          message: 'Session projection capacity is full',
          details: {
            resource: 'resident_session_projections',
            limit: 1,
            retryable: true,
          },
        },
      });
      expect(SessionRuntime.create).not.toHaveBeenCalled();
      expect(controller.getProjectionResidencyStats()).toMatchObject({
        resident: 0,
        reserved: 1,
        retained: 1,
        maxResident: 1,
      });

      releaseHydration();
      firstResponse = await firstResponsePromise;
      expect(firstResponse.status).toBe(200);
    } finally {
      releaseHydration();
      await controller.shutdown();
    }
  });

  it('does not let an invalidated hydration overwrite or release a newer same-key generation', async () => {
    const createSessionRouteController = await loadSessionRouteController();
    const sessionId = 'same-key-hydration-generation';
    const projectPath = '/tmp/same-key-hydration-generation';
    const oldMetadata = metadataFor(sessionId, projectPath, {
      title: 'Old generation',
    });
    const archivedMetadata = {
      ...oldMetadata,
      archivedAt: '2026-08-29T00:00:00.000Z',
      archivedBySessionId: sessionId,
    };
    const newMetadata = metadataFor(sessionId, projectPath, {
      title: 'New generation',
    });
    let durableMetadata: SessionMetadata = oldMetadata;
    let taskWorktreeLookups = 0;
    const [oldHydrationGate, releaseOldHydration] = promiseGate();
    const [oldHydrationStarted, markOldHydrationStarted] = promiseGate();
    const [newHydrationGate, releaseNewHydration] = promiseGate();
    const [newHydrationStarted, markNewHydrationStarted] = promiseGate();

    vi.mocked(SessionService.findSessionMetadata).mockImplementation(
      async (requestedSessionId, requestedProjectPath) =>
        requestedSessionId === sessionId && requestedProjectPath === projectPath
          ? durableMetadata
          : undefined
    );
    vi.mocked(SessionService.findSessionTaskWorktree).mockImplementation(
      async (requestedSessionId, requestedProjectPath) => {
        if (requestedSessionId !== sessionId || requestedProjectPath !== projectPath) {
          return undefined;
        }
        taskWorktreeLookups++;
        if (taskWorktreeLookups === 1) {
          markOldHydrationStarted();
          await oldHydrationGate;
        } else if (taskWorktreeLookups === 2) {
          markNewHydrationStarted();
          await newHydrationGate;
        }
        return undefined;
      }
    );
    vi.mocked(SessionService.listSessions).mockResolvedValue([]);
    vi.mocked(SessionService.listSessionArchiveMembers).mockImplementation(async () => [
      durableMetadata,
    ]);
    vi.mocked(SessionService.archiveSession).mockImplementationOnce(async () => {
      durableMetadata = archivedMetadata;
      return archivedMetadata;
    });
    vi.mocked(SessionService.unarchiveSession).mockImplementationOnce(async () => {
      durableMetadata = newMetadata;
      return newMetadata;
    });

    const route = (suffix: string) =>
      '/' + sessionId + suffix + '?projectPath=' + encodeURIComponent(projectPath);
    const controller = createSessionRouteController();
    const oldResponsePromise = Promise.resolve(
      controller.app.request(route('/browser/reset'), { method: 'POST' })
    );
    let firstNewResponsePromise: Promise<Response> | undefined;
    let joinedNewResponsePromise: Promise<Response> | undefined;

    try {
      await oldHydrationStarted;
      const archiveResponse = await controller.app.request(route('/archive'), {
        method: 'POST',
      });
      expect(archiveResponse.status).toBe(200);
      const unarchiveResponse = await controller.app.request(route('/unarchive'), {
        method: 'POST',
      });
      expect(unarchiveResponse.status).toBe(200);

      firstNewResponsePromise = Promise.resolve(
        controller.app.request(route('/browser/reset'), { method: 'POST' })
      );
      await newHydrationStarted;

      releaseOldHydration();
      const oldResponse = await oldResponsePromise;
      const oldBody = (await oldResponse.json()) as {
        error?: { code?: string };
      };
      const beforeNewCommitResponse = await controller.app.request('/');
      const beforeNewCommit = (await beforeNewCommitResponse.json()) as Array<{
        sessionId: string;
        title?: string;
      }>;

      joinedNewResponsePromise = Promise.resolve(
        controller.app.request(route('/browser/reset'), { method: 'POST' })
      );
      releaseNewHydration();
      const [firstNewResponse, joinedNewResponse] = await Promise.all([
        firstNewResponsePromise,
        joinedNewResponsePromise,
      ]);
      const afterNewCommitResponse = await controller.app.request('/');
      const afterNewCommit = (await afterNewCommitResponse.json()) as Array<{
        sessionId: string;
        title?: string;
      }>;

      expect({
        oldStatus: oldResponse.status,
        oldErrorCode: oldBody.error?.code,
        beforeNewCommit,
        firstNewStatus: firstNewResponse.status,
        joinedNewStatus: joinedNewResponse.status,
        taskWorktreeLookups,
        afterNewCommit,
      }).toEqual({
        oldStatus: 409,
        oldErrorCode: 'CONFLICT',
        beforeNewCommit: [],
        firstNewStatus: 200,
        joinedNewStatus: 200,
        taskWorktreeLookups: 2,
        afterNewCommit: [
          expect.objectContaining({
            sessionId,
            title: 'New generation',
          }),
        ],
      });
    } finally {
      releaseOldHydration();
      releaseNewHydration();
      await oldResponsePromise.catch(() => undefined);
      await firstNewResponsePromise?.catch(() => undefined);
      await joinedNewResponsePromise?.catch(() => undefined);
      await controller.shutdown().catch(() => undefined);
    }
  });

  it('keeps an in-flight Session hydration valid when durable archive fails', async () => {
    const createSessionRouteController = await loadSessionRouteController();
    const sessionId = 'failed-archive-hydration';
    const projectPath = '/tmp/failed-archive-hydration';
    const metadata = metadataFor(sessionId, projectPath);
    const [hydrationGate, releaseHydration] = promiseGate();
    const [hydrationStarted, markHydrationStarted] = promiseGate();

    vi.mocked(SessionService.findSessionMetadata).mockImplementation(
      async (requestedSessionId, requestedProjectPath) =>
        requestedSessionId === sessionId && requestedProjectPath === projectPath
          ? metadata
          : undefined
    );
    vi.mocked(SessionService.findSessionTaskWorktree).mockImplementation(
      async (requestedSessionId, requestedProjectPath) => {
        if (requestedSessionId !== sessionId || requestedProjectPath !== projectPath) {
          return undefined;
        }
        markHydrationStarted();
        await hydrationGate;
        return undefined;
      }
    );
    vi.mocked(SessionService.listSessionArchiveMembers).mockResolvedValue([metadata]);
    vi.mocked(SessionService.archiveSession).mockRejectedValueOnce(
      new Error('durable archive failed')
    );
    vi.mocked(SessionService.listSessions).mockResolvedValue([metadata]);

    const requestController = new AbortController();
    const controller = createSessionRouteController();
    const hydrationResponsePromise = Promise.resolve(
      controller.app.request(
        `/${sessionId}/events?projectPath=${encodeURIComponent(projectPath)}`,
        { signal: requestController.signal }
      )
    );
    let hydrationResponse: Response | undefined;
    let collector: ReturnType<typeof createSseCollector> | undefined;

    try {
      await hydrationStarted;
      const archiveResponse = await controller.app.request(
        `/${sessionId}/archive?projectPath=${encodeURIComponent(projectPath)}`,
        { method: 'POST' }
      );
      expect(archiveResponse.status).toBe(500);

      releaseHydration();
      hydrationResponse = await hydrationResponsePromise;
      expect(hydrationResponse.status).toBe(200);
      collector = createSseCollector(hydrationResponse);
      await expect(collector.next()).resolves.toMatchObject({ type: 'connected' });

      const sessionsResponse = await controller.app.request('/');
      const activeSessions = (await sessionsResponse.json()) as Array<{
        sessionId: string;
        isActive?: boolean;
      }>;
      expect(activeSessions).toContainEqual(
        expect.objectContaining({ sessionId, isActive: true })
      );
      expect(busState.subscribers.size).toBe(1);
      expect(SessionRuntime.create).not.toHaveBeenCalled();
    } finally {
      releaseHydration();
      requestController.abort();
      hydrationResponse ??= await hydrationResponsePromise.catch(() => undefined);
      if (collector) await collector.cancel();
      else await hydrationResponse?.body?.cancel().catch(() => undefined);
      await controller.shutdown().catch(() => undefined);
    }
  });

  it('shares active-controller hydration with durable permission recovery', async () => {
    const { BladeServerError } = await import('../../../../src/server/error.js');
    const { PermissionRoutes } = await import(
      '../../../../src/server/routes/permission.js'
    );
    const createSessionRouteController = await loadSessionRouteController();
    const { SessionInteractionService } = await import(
      '../../../../src/services/SessionInteractionService.js'
    );
    const sessionId = 'permission-shared-hydration';
    const projectPath = '/tmp/permission-shared-hydration';
    const permissionId = 'permission-shared-hydration-request';
    const metadata = metadataFor(sessionId, projectPath);
    const pending: ProjectedSessionInteraction = {
      request: {
        requestId: permissionId,
        toolCallId: 'permission-tool-call',
        toolName: 'Read',
        interactionType: 'permission',
        details: {
          type: 'permission',
          toolName: 'Read',
          message: 'Allow durable read?',
          args: {},
        },
        requestedAt: '2026-08-29T00:00:00.000Z',
      },
      hasToolResult: false,
      hasRecoveryToolResult: false,
    };
    const findPending = vi
      .spyOn(SessionInteractionService, 'findPending')
      .mockResolvedValue(pending);
    const [durableRecoveryGate, continueDurableRecovery] = promiseGate();
    const [durableRecoveryStarted, markDurableRecoveryStarted] = promiseGate();
    const respondAndRecover = vi
      .spyOn(SessionInteractionService, 'respondAndRecover')
      .mockImplementation(async () => {
        markDurableRecoveryStarted();
        await durableRecoveryGate;
      });
    const [hydrationGate, releaseHydration] = promiseGate();
    const [hydrationStarted, markHydrationStarted] = promiseGate();
    let taskWorktreeLookups = 0;
    let metadataLookups = 0;

    vi.mocked(SessionService.findSessionMetadata).mockImplementation(
      async (requestedSessionId, requestedProjectPath) => {
        if (requestedSessionId !== sessionId || requestedProjectPath !== projectPath) {
          return undefined;
        }
        metadataLookups++;
        return metadata;
      }
    );
    vi.mocked(SessionService.findSessionTaskWorktree).mockImplementation(
      async (requestedSessionId, requestedProjectPath) => {
        if (requestedSessionId !== sessionId || requestedProjectPath !== projectPath) {
          return undefined;
        }
        taskWorktreeLookups++;
        if (taskWorktreeLookups === 1) {
          markHydrationStarted();
          await hydrationGate;
        }
        return undefined;
      }
    );
    vi.mocked(SessionService.listSessions).mockResolvedValue([metadata]);

    const requestController = new AbortController();
    const controller = createSessionRouteController();
    const app = new Hono();
    app.onError((error, c) => {
      if (error instanceof BladeServerError) {
        return c.json(
          error.toObject(),
          error.statusCode as 400 | 404 | 409 | 429 | 500 | 503
        );
      }
      throw error;
    });
    app.route('/sessions', controller.app);
    app.route('/permissions', PermissionRoutes());
    const sseResponsePromise = Promise.resolve(
      app.request(`/sessions/${sessionId}/events`, { signal: requestController.signal })
    );
    let sseResponse: Response | undefined;
    let collector: ReturnType<typeof createSseCollector> | undefined;
    let permissionSettled = false;

    try {
      await hydrationStarted;
      const permissionResponsePromise = Promise.resolve(
        requestJson(
          app,
          `/permissions/${permissionId}?sessionId=${sessionId}&projectPath=${encodeURIComponent(projectPath)}`,
          'POST',
          { approved: true }
        )
      ).then((response) => {
        permissionSettled = true;
        return response;
      });

      await durableRecoveryStarted;
      continueDurableRecovery();
      await new Promise<void>((resolve) => {
        queueMicrotask(() => {
          queueMicrotask(() => {
            queueMicrotask(resolve);
          });
        });
      });
      expect({ permissionSettled, taskWorktreeLookups }).toEqual({
        permissionSettled: false,
        taskWorktreeLookups: 1,
      });

      releaseHydration();
      const [permissionResponse, resolvedSseResponse] = await Promise.all([
        permissionResponsePromise,
        sseResponsePromise,
      ]);
      sseResponse = resolvedSseResponse;
      collector = createSseCollector(sseResponse);
      await expect(collector.next()).resolves.toMatchObject({ type: 'connected' });

      expect(permissionResponse.status).toBe(200);
      expect(findPending).toHaveBeenCalledWith(projectPath, sessionId);
      expect(respondAndRecover).toHaveBeenCalledWith(
        projectPath,
        sessionId,
        permissionId,
        expect.objectContaining({ approved: true })
      );
      expect(metadataLookups).toBeGreaterThanOrEqual(1);
      expect(taskWorktreeLookups).toBe(1);
      expect(busState.publish).toHaveBeenCalledWith(
        { sessionId, projectPath },
        'interaction.resolved',
        { requestId: permissionId }
      );
      expect(SessionRuntime.create).not.toHaveBeenCalled();
    } finally {
      continueDurableRecovery();
      releaseHydration();
      requestController.abort();
      sseResponse ??= await sseResponsePromise.catch(() => undefined);
      if (collector) await collector.cancel();
      else await sseResponse?.body?.cancel().catch(() => undefined);
      await controller.shutdown().catch(() => undefined);
      findPending.mockRestore();
      respondAndRecover.mockRestore();
    }
  });

  it('returns a cursor-based public session catalog page', async () => {
    const SessionRoutes = await loadSessionRoutes();
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
    const SessionRoutes = await loadSessionRoutes();
    vi.mocked(SessionService.listSessionPage).mockRejectedValue(
      new Error('Session catalog limit must be an integer from 1 to 100')
    );

    const response = await SessionRoutes().request('/catalog?limit=0');

    expect(response.status).toBe(400);
  });

  it('lists archived sessions in an independently scoped catalog', async () => {
    const SessionRoutes = await loadSessionRoutes();
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

  it('rejects protected remote roots at V1 Session entry points before lookup or writes', async () => {
    const app = await createMountedSessionApp();
    const protectedRoot =
      getBladeStorageRoot() + '/acp-remote-workspaces/' + 'a'.repeat(64);
    const encodedRoot = encodeURIComponent(protectedRoot);

    const responses = await Promise.all([
      app.request('/sessions/catalog?projectPath=' + encodedRoot),
      app.request('/sessions/local-session?projectPath=' + encodedRoot),
      requestJson(app, '/sessions', 'POST', { projectPath: protectedRoot }),
      requestJson(app, '/sessions?directory=' + encodedRoot, 'POST', {}),
      app.request('/sessions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-blade-directory': protectedRoot,
        },
        body: JSON.stringify({}),
      }),
    ]);

    expect(responses.map((response) => response.status)).toEqual([
      400, 400, 400, 400, 400,
    ]);
    for (const response of responses) {
      await expect(response.json()).resolves.toMatchObject({
        error: { code: 'BAD_REQUEST' },
      });
    }
    expect(SessionService.listSessionPage).not.toHaveBeenCalled();
    expect(SessionService.findSessionMetadata).not.toHaveBeenCalled();
    expect(SessionService.createSessionMetadata).not.toHaveBeenCalled();
  });

  it('validates export visibility and maps empty conversations to conflict', async () => {
    const SessionRoutes = await loadSessionRoutes();
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
    const SessionRoutes = await loadSessionRoutes();
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

  it('falls back from a removed durable model and migrates the Session metadata', async () => {
    const SessionRoutes = await loadSessionRoutes();
    const metadata = makeSessionMetadata({
      sessionId: 'stale-model-session',
      projectPath: '/tmp/stale-model-workspace',
      selectedModelId: 'removed-model',
    });
    vi.mocked(SessionService.listSessions).mockResolvedValue([metadata]);
    vi.mocked(SessionService.findSessionMetadata).mockResolvedValue(metadata);
    vi.mocked(SessionService.loadSession).mockResolvedValue(makeMessages());

    const response = await requestJson(
      SessionRoutes(),
      `/stale-model-session/message?projectPath=${encodeURIComponent(metadata.projectPath)}`,
      'POST',
      { content: 'continue with an available model' }
    );

    expect(response.status).toBe(202);
    expect(vi.mocked(SessionRuntime.create).mock.calls[0]?.[0]).not.toHaveProperty(
      'modelId'
    );
    expect(SessionService.updateSessionMetadata).toHaveBeenCalledWith(
      metadata.sessionId,
      metadata.projectPath,
      { selectedModelId: 'model-1' }
    );
  });

  it('returns a stable conflict when a restored task worktree is unavailable', async () => {
    const SessionRoutes = await loadSessionRoutes();
    const { WorktreeUnavailableError } = await import(
      '../../../../src/worktree/WorktreeManager.js'
    );
    const metadata = makeSessionMetadata({
      sessionId: 'missing-worktree-session',
      projectPath: '/tmp/missing-worktree',
      taskStatus: 'completed',
      taskIsolation: 'worktree',
      taskWorktreePath: '/tmp/missing-worktree',
    });
    vi.mocked(SessionService.listSessions).mockResolvedValue([metadata]);
    vi.mocked(SessionService.findSessionMetadata).mockResolvedValue(metadata);
    vi.mocked(SessionService.findSessionTaskWorktree).mockResolvedValue({
      sessionId: metadata.sessionId,
      name: 'task/missing-worktree-session',
      branch: 'blade-worktree-missing-worktree-session',
      baseCommit: 'a'.repeat(40),
      originalBranch: 'main',
      repositoryRoot: '/tmp/repository',
      originalWorkspaceRoot: '/tmp/source',
      worktreeRoot: metadata.projectPath,
      workspaceRoot: metadata.projectPath,
      sourceHadChanges: false,
    });
    vi.mocked(SessionService.loadSession).mockResolvedValue(makeMessages());
    vi.mocked(SessionRuntime.create).mockRejectedValueOnce(
      new WorktreeUnavailableError('missing')
    );

    const response = await requestJson(
      SessionRoutes(),
      `/${metadata.sessionId}/message?projectPath=${encodeURIComponent(metadata.projectPath)}`,
      'POST',
      { content: 'continue' }
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'SESSION_WORKSPACE_UNAVAILABLE',
        message: 'This session workspace is no longer available',
        details: { reason: 'missing' },
      },
    });
  });

  it('rejects a second Session while the only resident Runtime is active', async () => {
    const createSessionRouteController = await loadSessionRouteController();
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
    const [runGate, releaseRun] = promiseGate();
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

    const first = await requestJson(
      controller.app,
      '/resident-active-a/message?projectPath=%2Ftmp%2Fresidency',
      'POST',
      { content: 'hold resident A' }
    );
    expect(first.status).toBe(202);
    const second = await requestJson(
      controller.app,
      '/resident-active-b/message?projectPath=%2Ftmp%2Fresidency',
      'POST',
      { content: 'must not initialize B' }
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
    const createSessionRouteController = await loadSessionRouteController();
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
      const response = await requestJson(
        controller.app,
        `/${sessionId}/message?projectPath=%2Ftmp%2Fresidency`,
        'POST',
        { content }
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
    const createSessionRouteController = await loadSessionRouteController();
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
      const response = await requestJson(
        controller.app,
        `/${session.sessionId}/message?projectPath=${encodeURIComponent(projectPath)}`,
        'POST',
        { content: `message ${session.sessionId}` }
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
    const SessionRoutes = await loadSessionRoutes();
    const { Agent } = await import('../../../../src/agent/Agent.js');
    const Bus = await loadBus();
    mockResolvedSession('steering-session');
    const [runGate, releaseRun] = promiseGate();
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
    const first = await requestJson(app, '/steering-session/message', 'POST', {
      content: 'initial request',
    });
    expect(first.status).toBe(202);
    await vi.waitFor(() => {
      expect(Bus.publish).toHaveBeenCalledWith(
        refFor('steering-session'),
        'turn.started',
        expect.any(Object)
      );
    });

    const second = await requestJson(app, '/steering-session/message', 'POST', {
      content: 'updated requirement',
    });

    expect(second.status).toBe(202);
    expect(await second.json()).toMatchObject({
      status: 'steering_queued',
      queued: 1,
      followUpQueue: makeFollowUpQueueSnapshot(),
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
    expect(Bus.publish).not.toHaveBeenCalledWith(
      refFor('steering-session'),
      'message.created',
      expect.objectContaining({ messageId: 'steering-input' })
    );
    expect(Bus.publish).toHaveBeenCalledWith(
      refFor('steering-session'),
      'follow_up.queue.changed',
      { queue: makeFollowUpQueueSnapshot() }
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
        followUpQueue: makeFollowUpQueueSnapshot(),
        providerRecovery: {
          version: 1,
          generation: 'provider-recovery-generation',
          revision: 1,
          snapshot: { activity: 'retry_wait', reason: 'rate_limit' },
        },
        turnActivity: {
          version: 1,
          generation: 'turn-activity-generation',
          revision: 2,
          snapshot: { phase: 'executing_tools', activeTools: [{ name: 'Bash' }] },
        },
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

  it.each([
    ['already_claimed', 409],
    ['immutable_origin', 409],
    ['immutable_boundary', 409],
    ['not_found', 404],
    ['runtime_unavailable', 503],
    ['invalid_mutation', 400],
    ['storage_unavailable', 503],
  ] as const)('maps the %s queue error to HTTP %s', async (code, status) => {
    const SessionRoutes = await loadSessionRoutes();
    const { FollowUpQueueMutationError } = await import(
      '../../../../src/agent/runtime/FollowUpQueueProjection.js'
    );
    const projectPath = `/tmp/${code}-follow-up-queue`;
    mockResolvedSession(`${code}-follow-up-queue`, { projectPath });
    const latest = makeFollowUpQueueSnapshot();
    runtimeState.runtime.mutateFollowUpQueue.mockRejectedValue(
      new FollowUpQueueMutationError(code, latest, `Queue error: ${code}`)
    );

    const response = await requestJson(
      SessionRoutes(),
      `/${code}-follow-up-queue/follow-ups/mutate?projectPath=${encodeURIComponent(projectPath)}`,
      'POST',
      {
        expectedVersion: latest.version,
        operation: { type: 'remove', messageId: 'follow-up-1' },
      }
    );

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({
      error: { code, message: `Queue error: ${code}` },
      snapshot: latest,
    });
  });

  it('rejects malformed follow-up mutations before acquiring a runtime', async () => {
    const SessionRoutes = await loadSessionRoutes();
    const projectPath = '/tmp/invalid-follow-up-queue';
    mockResolvedSession('invalid-follow-up-queue', { projectPath });

    const response = await requestJson(
      SessionRoutes(),
      `/invalid-follow-up-queue/follow-ups/mutate?projectPath=${encodeURIComponent(projectPath)}`,
      'POST',
      {
        expectedVersion: 'not-a-version',
        operation: { type: 'remove', messageId: 'follow-up-1' },
        unexpected: true,
      }
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'BAD_REQUEST' },
    });
    expect(SessionRuntime.create).not.toHaveBeenCalled();
    expect(runtimeState.runtime.mutateFollowUpQueue).not.toHaveBeenCalled();
  });

  it('rejects archived and ACP-remote follow-up queue surfaces', async () => {
    const SessionRoutes = await loadSessionRoutes();
    const { SessionArchivedError } = await import(
      '../../../../src/services/SessionService.js'
    );
    const archivedPath = '/tmp/archived-follow-up';
    mockResolvedSession('archived-follow-up', { projectPath: archivedPath });
    vi.mocked(SessionService.assertSessionWritable).mockRejectedValueOnce(
      new SessionArchivedError('archived-follow-up', 'archived-follow-up')
    );
    const archived = await SessionRoutes().request(
      `/archived-follow-up/follow-ups?projectPath=${encodeURIComponent(archivedPath)}`
    );
    expect(archived.status).toBe(409);

    const app = await createMountedSessionApp();
    const protectedRoot =
      getBladeStorageRoot() + '/acp-remote-workspaces/' + 'a'.repeat(64);
    const remote = await app.request(
      `/sessions/remote-follow-up/follow-ups?projectPath=${encodeURIComponent(protectedRoot)}`
    );
    expect(remote.status).toBe(400);
    await expect(remote.json()).resolves.toMatchObject({
      error: { code: 'BAD_REQUEST' },
    });
  });

  it('publishes an unsequenced queue snapshot to an active SSE stream', async () => {
    const SessionRoutes = await loadSessionRoutes();
    const Bus = await loadBus();
    const projectPath = '/tmp/follow-up-sse';
    mockResolvedSession('follow-up-sse', { projectPath });
    vi.mocked(SessionRuntime.hasDurableFollowUpInbox).mockResolvedValue(true);
    const app = SessionRoutes();
    const abort = new AbortController();
    const response = await app.request(
      `/follow-up-sse/events?projectPath=${encodeURIComponent(projectPath)}`,
      { signal: abort.signal }
    );
    const collector = createSseCollector(response);
    expect(await collector.next()).toMatchObject({
      type: 'connected',
      properties: { followUpQueue: makeFollowUpQueueSnapshot() },
    });

    const replacement = makeFollowUpQueueSnapshot({ version: 'e'.repeat(64) });
    Bus.publish(
      { sessionId: 'follow-up-sse', projectPath },
      'follow_up.queue.changed',
      { queue: replacement }
    );
    const changed = await collector.next();
    expect(changed).toMatchObject({
      type: 'follow_up.queue.changed',
      properties: { queue: replacement },
    });
    expect(changed.seq).toBeUndefined();

    abort.abort();
    await collector.cancel();
  });

  it('rejects changing models while a turn is active', async () => {
    const SessionRoutes = await loadSessionRoutes();
    const Bus = await loadBus();
    mockResolvedSession('active-model-session');
    const [runGate, releaseRun] = promiseGate();
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
    const first = await requestJson(app, '/active-model-session/message', 'POST', {
      content: 'start with model one',
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
    const second = await requestJson(app, '/active-model-session/message', 'POST', {
      content: 'switch too early',
      modelId: 'model-2',
    });

    expect(second.status).toBe(409);
    await expect(second.json()).resolves.toMatchObject({
      error: {
        message: 'Wait for the active turn to finish before switching models',
      },
    });
    expect(runtimeState.runtime.enqueueSteering).not.toHaveBeenCalled();

    const effortSwitch = await requestJson(
      app,
      '/active-model-session/message',
      'POST',
      {
        content: 'switch effort too early',
        reasoningEffort: 'low',
      }
    );
    expect(effortSwitch.status).toBe(409);
    await expect(effortSwitch.json()).resolves.toMatchObject({
      error: {
        message: 'Wait for the active turn to finish before switching reasoning effort',
      },
    });

    const tierSwitch = await requestJson(app, '/active-model-session/message', 'POST', {
      content: 'switch service tier too early',
      serviceTier: 'fast',
    });
    expect(tierSwitch.status).toBe(409);
    await expect(tierSwitch.json()).resolves.toMatchObject({
      error: {
        message: 'Wait for the active turn to finish before switching service tier',
      },
    });

    const verbositySwitch = await requestJson(
      app,
      '/active-model-session/message',
      'POST',
      {
        content: 'switch response verbosity too early',
        responseVerbosity: 'high',
      }
    );
    expect(verbositySwitch.status).toBe(409);
    await expect(verbositySwitch.json()).resolves.toMatchObject({
      error: {
        message:
          'Wait for the active turn to finish before switching response verbosity',
      },
    });

    const styleSwitch = await requestJson(
      app,
      '/active-model-session/message',
      'POST',
      {
        content: 'switch communication style too early',
        communicationStyle: 'friendly',
      }
    );
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
    const SessionRoutes = await loadSessionRoutes();
    const Bus = await loadBus();
    mockResolvedSession('follow-up-session');
    const [runGate, releaseRun] = promiseGate();
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
    await requestJson(app, '/follow-up-session/message', 'POST', {
      content: 'initial request',
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

    const response = await requestJson(app, '/follow-up-session/message', 'POST', {
      content: 'run after this answer',
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

  it('wakes a persisted durable follow-up when Web SSE reconnects', async () => {
    const SessionRoutes = await loadSessionRoutes();
    const { Agent } = await import('../../../../src/agent/Agent.js');
    const SessionService = await loadSessionService();
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
    const [runGate, releaseRun] = promiseGate();
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

  it('retries a retryable zero-side-effect Web pending resume', async () => {
    const createSessionRouteController = await loadSessionRouteController();
    const recoveredMetadata = metadataFor(
      'retry-recovered-web-session',
      '/persisted-workspace',
      { permissionMode: 'yolo' }
    );
    vi.mocked(SessionService.listSessions).mockResolvedValue([recoveredMetadata]);
    vi.mocked(SessionService.findSessionMetadata).mockResolvedValue(recoveredMetadata);
    vi.mocked(SessionRuntime.hasPendingInbox).mockResolvedValue(true);
    runtimeState.runtime.getPendingSteeringCount.mockReturnValue(1);
    agentState.chatStream
      .mockImplementationOnce(async function* () {
        yield {
          kind: 'follow_up_started' as const,
          queued: 1,
          recovered: 1,
          messages: [
            {
              id: 'durable-recovered-input',
              content: 'continue durable work',
              queuedAt: Date.now(),
              recovered: true,
              persisted: false,
            },
          ],
          queue: makeFollowUpQueueSnapshot({ locked: 1, mutable: 0 }),
        };
        yield {
          kind: 'steering_applied' as const,
          messageIds: ['durable-recovered-input'],
          count: 1,
          recovered: 1,
          delivery: 'next_turn' as const,
          messages: [
            {
              id: 'durable-recovered-input',
              content: 'continue durable work',
              queuedAt: Date.now(),
              recovered: true,
              persisted: false,
            },
          ],
          queue: makeFollowUpQueueSnapshot({
            version: 'b'.repeat(64),
            pending: 0,
            mutable: 0,
            items: [],
          }),
        };
        return makeProviderRecoveryBudgetFailure('opaque Provider failure');
      })
      .mockImplementationOnce(async function* () {
        runtimeState.runtime.getPendingSteeringCount.mockReturnValue(0);
        yield {
          kind: 'follow_up_started' as const,
          queued: 1,
          recovered: 1,
          messages: [
            {
              id: 'durable-recovered-input',
              content: 'continue durable work',
              queuedAt: Date.now(),
              recovered: true,
              persisted: false,
            },
          ],
          queue: makeFollowUpQueueSnapshot({ locked: 1, mutable: 0 }),
        };
        yield {
          kind: 'steering_applied' as const,
          messageIds: ['durable-recovered-input'],
          count: 1,
          recovered: 1,
          delivery: 'next_turn' as const,
          messages: [
            {
              id: 'durable-recovered-input',
              content: 'continue durable work',
              queuedAt: Date.now(),
              recovered: true,
              persisted: false,
            },
          ],
          queue: makeFollowUpQueueSnapshot({
            version: 'c'.repeat(64),
            pending: 0,
            mutable: 0,
            items: [],
          }),
        };
        return {
          success: true,
          finalMessage: 'recovered',
          metadata: { turnsCount: 1, toolCallsCount: 0, duration: 0 },
        };
      });

    const controller = createSessionRouteController();
    const eventsController = new AbortController();
    const response = await controller.app.request(
      '/retry-recovered-web-session/events',
      { signal: eventsController.signal }
    );
    expect(response.status).toBe(200);

    await vi.waitFor(
      () => {
        expect(agentState.chatStream).toHaveBeenCalledTimes(2);
      },
      { timeout: 3_000 }
    );
    const published = busState.publish.mock.calls.map(([, type, properties]) => ({
      type,
      properties,
    }));
    expect(
      published.filter(
        (event) =>
          event.type === 'pending.resume' &&
          event.properties.phase === 'retry_scheduled'
      )
    ).toHaveLength(1);
    expect(
      published.filter(
        (event) =>
          event.type === 'pending.resume' && event.properties.phase === 'recovered'
      )
    ).toHaveLength(1);
    expect(published.filter((event) => event.type === 'session.error')).toHaveLength(0);
    expect(
      published.filter(
        (event) =>
          event.type === 'message.created' &&
          event.properties.messageId === 'durable-recovered-input'
      )
    ).toHaveLength(1);

    await closeSse(controller, eventsController, response);
  });

  it('stays terminal when persisting a pending resume startup failure rejects', async () => {
    vi.useFakeTimers();
    const createSessionRouteController = await loadSessionRouteController();
    const sessionId = 'retry-terminal-persist-failure';
    const projectPath = '/persisted-workspace';
    const metadata = metadataFor(sessionId, projectPath, { permissionMode: 'yolo' });
    vi.mocked(SessionService.listSessions).mockResolvedValue([metadata]);
    vi.mocked(SessionService.findSessionMetadata).mockResolvedValue(metadata);
    vi.mocked(SessionRuntime.hasPendingInbox)
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(new Error('private retry startup details'))
      .mockResolvedValue(true);
    vi.mocked(SessionService.updateSessionMetadata).mockRejectedValueOnce(
      new Error('private persistence details')
    );
    runtimeState.runtime.getPendingSteeringCount.mockReturnValue(1);
    agentState.chatStream.mockImplementationOnce(async function* () {
      if (Date.now() < 0) yield undefined;
      return makeProviderRecoveryBudgetFailure();
    });

    const controller = createSessionRouteController();
    const firstController = new AbortController();
    const firstResponse = await controller.app.request(
      `/${sessionId}/events?projectPath=${encodeURIComponent(projectPath)}`,
      { signal: firstController.signal }
    );
    try {
      await vi.waitFor(() => {
        expect(
          busState.publish.mock.calls.filter(
            ([, type, properties]) =>
              type === 'pending.resume' && properties.phase === 'retry_scheduled'
          )
        ).toHaveLength(1);
      });
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.waitFor(() => {
        expect(
          busState.publish.mock.calls.filter(
            ([, type, properties]) =>
              type === 'pending.resume' && properties.phase === 'failed'
          )
        ).toHaveLength(1);
        expect(
          busState.publish.mock.calls.filter(
            ([, type, properties]) =>
              type === 'session.error' &&
              (properties.taskFailure as { code?: unknown } | undefined)?.code ===
                'runtime'
          )
        ).toHaveLength(1);
        expect(controller.getProjectionResidencyStats().pinned).toBe(0);
      });
      expect(JSON.stringify(busState.publish.mock.calls)).not.toContain('private');

      const pendingChecks = vi.mocked(SessionRuntime.hasPendingInbox).mock.calls.length;
      const reconnectController = new AbortController();
      const reconnectResponse = await controller.app.request(
        `/${sessionId}/events?projectPath=${encodeURIComponent(projectPath)}`,
        { signal: reconnectController.signal }
      );
      try {
        await vi.advanceTimersByTimeAsync(0);
        expect(SessionRuntime.hasPendingInbox).toHaveBeenCalledTimes(pendingChecks);
        expect(agentState.chatStream).toHaveBeenCalledTimes(1);
      } finally {
        reconnectController.abort();
        await reconnectResponse.body?.cancel().catch(() => undefined);
      }
    } finally {
      firstController.abort();
      await firstResponse.body?.cancel().catch(() => undefined);
      await controller.shutdown();
      vi.useRealTimers();
    }
  });

  it('exhausts a Web pending resume whose cleanup crosses the recovery deadline', async () => {
    vi.useFakeTimers({ now: 1_000 });
    const createSessionRouteController = await loadSessionRouteController();
    const sessionId = 'cleanup-crosses-resume-deadline';
    const projectPath = '/persisted-workspace';
    const metadata = metadataFor(sessionId, projectPath, { permissionMode: 'yolo' });
    mockPendingResume(metadata);

    const [destroyGate, releaseDestroy] = promiseGate<undefined>();
    agentState.destroy.mockImplementationOnce(() => destroyGate);
    agentState.chatStream.mockImplementationOnce(async function* () {
      if (Date.now() < 0) yield undefined;
      return makeProviderRecoveryBudgetFailure();
    });

    const controller = createSessionRouteController();
    const eventsController = new AbortController();
    const response = await controller.app.request(
      `/${sessionId}/events?projectPath=${encodeURIComponent(projectPath)}`,
      { signal: eventsController.signal }
    );
    try {
      await vi.waitFor(() => {
        expect(
          busState.publish.mock.calls.some(
            ([, type, properties]) =>
              type === 'pending.resume' && properties.phase === 'retry_scheduled'
          )
        ).toBe(true);
      });
      await vi.advanceTimersByTimeAsync(120_000);
      expect(agentState.chatStream).toHaveBeenCalledTimes(1);
      releaseDestroy();
      await vi.waitFor(() => {
        expect(
          busState.publish.mock.calls.filter(
            ([, type, properties]) =>
              type === 'pending.resume' && properties.phase === 'exhausted'
          )
        ).toHaveLength(1);
      });

      expect(Agent.createWithRuntime).toHaveBeenCalledTimes(1);
      expect(agentState.chatStream).toHaveBeenCalledTimes(1);
      expect(
        busState.publish.mock.calls.some(([, type]) =>
          ['permission.asked', 'question.required', 'elicitation.required'].includes(
            type
          )
        )
      ).toBe(false);
      expect(
        busState.publish.mock.calls.filter(
          ([, type, properties]) =>
            type === 'session.error' &&
            (properties.taskFailure as { code?: unknown } | undefined)?.code ===
              'timeout'
        )
      ).toHaveLength(1);
      expect(
        busState.publish.mock.calls.some(([, type]) => type === 'session.completed')
      ).toBe(false);
      await vi.waitFor(() => {
        expect(controller.getProjectionResidencyStats().pinned).toBe(0);
      });

      const pendingChecks = vi.mocked(SessionRuntime.hasPendingInbox).mock.calls.length;
      const reconnectController = new AbortController();
      const reconnectResponse = await controller.app.request(
        `/${sessionId}/events?projectPath=${encodeURIComponent(projectPath)}`,
        { signal: reconnectController.signal }
      );
      try {
        await vi.advanceTimersByTimeAsync(0);
        expect(SessionRuntime.hasPendingInbox).toHaveBeenCalledTimes(pendingChecks);
        expect(agentState.chatStream).toHaveBeenCalledTimes(1);
        expect(
          busState.publish.mock.calls.filter(
            ([, type, properties]) =>
              type === 'pending.resume' && properties.phase === 'exhausted'
          )
        ).toHaveLength(1);
      } finally {
        reconnectController.abort();
        await reconnectResponse.body?.cancel().catch(() => undefined);
      }
    } finally {
      releaseDestroy();
      await closeSse(controller, eventsController, response);
      vi.useRealTimers();
    }
  });

  it('rejects pending permission and ignores late success at the Web resume deadline', async () => {
    vi.useFakeTimers({ now: 1_000 });
    const createSessionRouteController = await loadSessionRouteController();
    const metadata = metadataFor('deadline-resume', '/persisted-workspace', {
      permissionMode: 'yolo',
    });
    mockPendingResume(metadata);
    let confirmationResponse: { approved: boolean; reason?: string } | undefined;
    agentState.chatStream.mockImplementationOnce(async function* (_content, context) {
      if (Date.now() < 0) yield undefined;
      if (!context.confirmationHandler) {
        throw new Error('Expected confirmation handler');
      }
      confirmationResponse = await context.confirmationHandler.requestConfirmation({
        toolName: 'Write',
        message: 'Approve a write after durable recovery',
      });
      return {
        success: true,
        finalMessage: 'late success',
        metadata: { turnsCount: 1, toolCallsCount: 0, duration: 120_000 },
      };
    });

    const controller = createSessionRouteController();
    const eventsController = new AbortController();
    const response = await controller.app.request('/deadline-resume/events', {
      signal: eventsController.signal,
    });
    try {
      await vi.waitFor(() => {
        expect(agentState.chatStream).toHaveBeenCalledTimes(1);
      });
      await vi.advanceTimersByTimeAsync(120_000);
      expect(confirmationResponse).toEqual({
        approved: false,
        reason: '__aborted__',
      });
      expect(
        busState.publish.mock.calls.some(
          ([, type, properties]) =>
            type === 'pending.resume' && properties.phase === 'exhausted'
        )
      ).toBe(true);
      expect(
        busState.publish.mock.calls.some(([, type]) => type === 'session.completed')
      ).toBe(false);
      expect(
        busState.publish.mock.calls.some(
          ([, type, properties]) =>
            type === 'session.error' &&
            (properties.taskFailure as { code?: unknown } | undefined)?.code ===
              'timeout'
        )
      ).toBe(true);
    } finally {
      eventsController.abort();
      await response.body?.cancel().catch(() => undefined);
      vi.useRealTimers();
      await controller.shutdown();
    }
  });

  it.each([
    ['content', { kind: 'content_delta', delta: 'partial' } satisfies LoopEvent, 0],
    ['thinking', { kind: 'thinking_delta', delta: 'partial' } satisfies LoopEvent, 0],
    [
      'structured',
      {
        kind: 'structured_output',
        output: { partial: true },
        schemaDigest: 'schema',
      } satisfies LoopEvent,
      0,
    ],
    [
      'tool_start',
      {
        kind: 'tool_start',
        toolCall: {
          id: 'tool-call',
          type: 'function',
          function: { name: 'Write', arguments: '{}' },
        },
      } satisfies LoopEvent,
      0,
    ],
    [
      'tool_progress',
      {
        kind: 'tool_progress',
        toolCall: {
          id: 'tool-call',
          type: 'function',
          function: { name: 'Write', arguments: '{}' },
        },
        update: { message: 'working' },
      } satisfies LoopEvent,
      0,
    ],
    [
      'tool_result',
      {
        kind: 'tool_result',
        toolCall: {
          id: 'tool-call',
          type: 'function',
          function: { name: 'Write', arguments: '{}' },
        },
        result: { success: true, llmContent: 'done' },
      } satisfies LoopEvent,
      0,
    ],
    ['unknown count', undefined, undefined],
    ['nonretryable', undefined, 0],
    ['inbox cleared', undefined, 0],
  ])(
    'does not retry Web pending resume after %s evidence',
    async (boundary, event, toolCallsCount) => {
      const createSessionRouteController = await loadSessionRouteController();
      const sessionId = `no-retry-${boundary}`
        .replaceAll('_', '-')
        .replaceAll(' ', '-');
      const metadata = metadataFor(sessionId, '/persisted-workspace', {
        permissionMode: 'yolo',
      });
      mockPendingResume(metadata);
      const retryable = boundary !== 'nonretryable';
      agentState.chatStream.mockImplementationOnce(async function* () {
        if (event) yield event;
        if (boundary === 'inbox cleared') {
          runtimeState.runtime.getPendingSteeringCount.mockReturnValue(0);
        }
        return {
          success: false,
          error: {
            type: 'api_error' as const,
            message: 'Provider request failed.',
            details: retryable
              ? Object.assign(new Error('opaque'), {
                  code: 'PROVIDER_RECOVERY_BUDGET_EXCEEDED',
                })
              : {
                  code: 'permission' as const,
                  message:
                    'Provider rejected this request. Check account and model permissions.',
                  retryable: false,
                },
          },
          metadata: {
            turnsCount: 1,
            ...(toolCallsCount === undefined ? {} : { toolCallsCount }),
            duration: 0,
          },
        };
      });

      const controller = createSessionRouteController();
      const eventsController = new AbortController();
      const response = await controller.app.request(`/${sessionId}/events`, {
        signal: eventsController.signal,
      });
      try {
        await vi.waitFor(() => {
          expect(
            busState.publish.mock.calls.some(([, type]) => type === 'session.error')
          ).toBe(true);
        });
        expect(agentState.chatStream).toHaveBeenCalledTimes(1);
        expect(
          busState.publish.mock.calls.some(
            ([, type, properties]) =>
              type === 'pending.resume' && properties.phase === 'retry_scheduled'
          )
        ).toBe(false);
        expect(
          busState.publish.mock.calls.some(
            ([, type, properties]) =>
              type === 'pending.resume' && properties.phase === 'failed'
          )
        ).toBe(true);

        const pendingChecks = vi.mocked(SessionRuntime.hasPendingInbox).mock.calls
          .length;
        const reconnectController = new AbortController();
        const reconnectResponse = await controller.app.request(
          `/${sessionId}/events?projectPath=${encodeURIComponent('/persisted-workspace')}`,
          { signal: reconnectController.signal }
        );
        try {
          await new Promise<void>((resolve) => setImmediate(resolve));
          expect(SessionRuntime.hasPendingInbox).toHaveBeenCalledTimes(pendingChecks);
          expect(agentState.chatStream).toHaveBeenCalledTimes(1);
          expect(
            busState.publish.mock.calls.filter(
              ([, type, properties]) =>
                type === 'pending.resume' && properties.phase === 'failed'
            )
          ).toHaveLength(1);
        } finally {
          reconnectController.abort();
          await reconnectResponse.body?.cancel().catch(() => undefined);
        }
      } finally {
        await closeSse(controller, eventsController, response);
      }
    }
  );

  it('releases pending resume owners when shutdown closes admission during handoff', async () => {
    const createSessionRouteController = await loadSessionRouteController();
    const sessionId = 'shutdown-before-pending-start-run';
    const projectPath = '/persisted-workspace';
    const metadata = metadataFor(sessionId, projectPath, { permissionMode: 'yolo' });
    mockPendingResume(metadata);

    const controller = createSessionRouteController();
    let shutdownPromise: Promise<void> | undefined;
    const [shutdownStarted, markShutdownStarted] = promiseGate();
    runtimeState.runtime.hasTurnOwner.mockImplementationOnce(() => {
      queueMicrotask(() => {
        shutdownPromise = controller.shutdown('test-shutdown');
        markShutdownStarted();
      });
      return false;
    });
    const eventsController = new AbortController();
    const response = await controller.app.request(
      `/${sessionId}/events?projectPath=${encodeURIComponent(projectPath)}`,
      { signal: eventsController.signal }
    );
    try {
      await shutdownStarted;
      await shutdownPromise;

      expect(Agent.createWithRuntime).not.toHaveBeenCalled();
      expect(controller.getProjectionResidencyStats().pinned).toBe(0);
    } finally {
      await closeSse(controller, eventsController, response);
    }
  });

  it('invalidates a pending resume attempt when abort arrives during its disk probe', async () => {
    vi.useFakeTimers();
    const createSessionRouteController = await loadSessionRouteController();
    const sessionId = 'abort-during-pending-resume-probe';
    const projectPath = '/persisted-workspace';
    const metadata = metadataFor(sessionId, projectPath, { permissionMode: 'yolo' });
    vi.mocked(SessionService.listSessions).mockResolvedValue([metadata]);
    vi.mocked(SessionService.findSessionMetadata).mockResolvedValue(metadata);
    const [probeGate, releaseProbe] = promiseGate<boolean>();
    vi.mocked(SessionRuntime.hasPendingInbox)
      .mockResolvedValueOnce(true)
      .mockImplementationOnce(() => probeGate);
    runtimeState.runtime.getPendingSteeringCount.mockReturnValue(1);
    agentState.chatStream.mockImplementationOnce(async function* () {
      if (Date.now() < 0) yield undefined;
      return makeProviderRecoveryBudgetFailure();
    });

    const controller = createSessionRouteController();
    const eventsController = new AbortController();
    const response = await controller.app.request(
      `/${sessionId}/events?projectPath=${encodeURIComponent(projectPath)}`,
      { signal: eventsController.signal }
    );
    try {
      await vi.waitFor(() => {
        expect(
          busState.publish.mock.calls.some(
            ([, type, properties]) =>
              type === 'pending.resume' && properties.phase === 'retry_scheduled'
          )
        ).toBe(true);
      });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(SessionRuntime.hasPendingInbox).toHaveBeenCalledTimes(2);

      const abortPromise = controller.app.request(
        `/${sessionId}/abort?projectPath=${encodeURIComponent(projectPath)}`,
        { method: 'POST' }
      );
      await vi.advanceTimersByTimeAsync(0);
      releaseProbe(true);
      expect((await abortPromise).status).toBe(200);
      await vi.advanceTimersByTimeAsync(0);

      expect(agentState.chatStream).toHaveBeenCalledTimes(1);
      expect(Agent.createWithRuntime).toHaveBeenCalledTimes(1);
      expect(
        busState.publish.mock.calls.some(
          ([, type, properties]) =>
            type === 'pending.resume' && properties.phase === 'recovered'
        )
      ).toBe(false);
      expect(
        busState.publish.mock.calls.some(([, type]) => type === 'session.completed')
      ).toBe(false);
    } finally {
      releaseProbe(true);
      await closeSse(controller, eventsController, response);
      vi.useRealTimers();
    }
  });

  it.each(['session delete', 'new message run', 'controller replacement'] as const)(
    'clears a scheduled Web pending resume on %s',
    async (cleanup) => {
      vi.useFakeTimers();
      const createSessionRouteController = await loadSessionRouteController();
      const sessionId = `pending-resume-${cleanup.replaceAll(' ', '-')}`;
      const projectPath = '/persisted-workspace';
      const metadata = metadataFor(sessionId, projectPath, {
        permissionMode: 'yolo',
      });
      mockPendingResume(metadata);
      agentState.chatStream.mockImplementationOnce(async function* () {
        if (Date.now() < 0) yield undefined;
        return makeProviderRecoveryBudgetFailure();
      });
      if (cleanup === 'new message run') {
        agentState.chatStream.mockImplementationOnce(async function* () {
          if (Date.now() < 0) yield undefined;
          runtimeState.runtime.getPendingSteeringCount.mockReturnValue(0);
          return {
            success: true,
            finalMessage: 'new user run',
            metadata: { turnsCount: 1, toolCallsCount: 0, duration: 0 },
          };
        });
      }

      const controller = createSessionRouteController();
      let resetController: ReturnType<typeof createSessionRouteController> | undefined;
      const eventsController = new AbortController();
      const response = await controller.app.request(`/${sessionId}/events`, {
        signal: eventsController.signal,
      });
      try {
        await vi.waitFor(() => {
          expect(
            busState.publish.mock.calls.some(
              ([, type, properties]) =>
                type === 'pending.resume' && properties.phase === 'retry_scheduled'
            )
          ).toBe(true);
        });

        if (cleanup === 'session delete') {
          const deleteResponse = await controller.app.request(
            `/${sessionId}?projectPath=${encodeURIComponent(projectPath)}`,
            { method: 'DELETE' }
          );
          expect(deleteResponse.status).toBe(200);
        } else if (cleanup === 'new message run') {
          const messageResponse = await requestJson(
            controller.app,
            `/${sessionId}/message?projectPath=${encodeURIComponent(projectPath)}`,
            'POST',
            { content: 'start a fresh run' }
          );
          expect(messageResponse.status).toBe(202);
          await vi.waitFor(() => {
            expect(agentState.chatStream).toHaveBeenCalledTimes(2);
          });
        } else {
          resetController = createSessionRouteController();
        }

        const callsAfterCleanup = agentState.chatStream.mock.calls.length;
        await vi.advanceTimersByTimeAsync(5_000);
        expect(agentState.chatStream).toHaveBeenCalledTimes(callsAfterCleanup);
      } finally {
        await closeSse(controller, eventsController, response);
        await resetController?.shutdown();
        vi.useRealTimers();
      }
    }
  );

  it.each(['Goal-only', 'task-isolated'] as const)(
    'does not attach Web pending recovery to a %s run',
    async (kind) => {
      const createSessionRouteController = await loadSessionRouteController();
      const sessionId = `excluded-${kind.toLowerCase()}`;
      const metadata = metadataFor(sessionId, '/persisted-workspace', {
        permissionMode: 'yolo',
        ...(kind === 'task-isolated'
          ? { taskIsolation: 'local', taskStatus: 'running' }
          : {}),
      });
      vi.mocked(SessionService.listSessions).mockResolvedValue([metadata]);
      vi.mocked(SessionService.findSessionMetadata).mockResolvedValue(metadata);
      vi.mocked(SessionRuntime.hasPendingInbox).mockResolvedValue(
        kind === 'task-isolated'
      );
      vi.mocked(SessionRuntime.hasActiveGoal).mockResolvedValue(kind === 'Goal-only');
      runtimeState.runtime.getPendingSteeringCount.mockReturnValue(
        kind === 'task-isolated' ? 1 : 0
      );
      runtimeState.runtime.getGoal.mockResolvedValue(
        kind === 'Goal-only' ? { status: 'active', goalId: 'goal-only' } : null
      );
      agentState.chatStream.mockImplementationOnce(async function* () {
        if (Date.now() < 0) yield undefined;
        return makeProviderRecoveryBudgetFailure();
      });

      const controller = createSessionRouteController();
      const eventsController = new AbortController();
      const response = await controller.app.request(`/${sessionId}/events`, {
        signal: eventsController.signal,
      });
      try {
        await vi.waitFor(() => {
          expect(
            busState.publish.mock.calls.some(([, type]) => type === 'session.error')
          ).toBe(true);
        });
        expect(agentState.chatStream).toHaveBeenCalledTimes(1);
        expect(
          busState.publish.mock.calls.some(([, type]) => type === 'pending.resume')
        ).toBe(false);
      } finally {
        await closeSse(controller, eventsController, response);
      }
    }
  );

  it('projects recovery attention without starting a Web run on reconnect', async () => {
    const SessionRoutes = await loadSessionRoutes();
    const { Agent } = await import('../../../../src/agent/Agent.js');
    const Bus = await loadBus();
    const recoveredMetadata = metadataFor(
      'attention-web-session',
      '/attention-workspace',
      { permissionMode: 'yolo' }
    );
    vi.mocked(SessionService.listSessions).mockResolvedValue([recoveredMetadata]);
    vi.mocked(SessionService.findSessionMetadata).mockResolvedValue(recoveredMetadata);
    vi.mocked(SessionRuntime.hasPendingInbox).mockResolvedValue(true);
    runtimeState.runtime.getPendingSteeringCount.mockReturnValue(1);
    runtimeState.runtime.getTurnRecoveryAssessment.mockReturnValue({
      state: 'requires_attention',
      turnId: 'turn-before-restart',
      inputMessageCount: 1,
      reason: 'interrupted_tool_call',
    });

    const controller = new AbortController();
    const response = await SessionRoutes().request('/attention-web-session/events', {
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    await vi.waitFor(() => {
      expect(Bus.publish).toHaveBeenCalledWith(
        {
          sessionId: 'attention-web-session',
          projectPath: '/attention-workspace',
        },
        'turn.recovery',
        {
          assessment: {
            state: 'requires_attention',
            turnId: 'turn-before-restart',
            inputMessageCount: 1,
            reason: 'interrupted_tool_call',
          },
        }
      );
    });
    expect(Agent.createWithRuntime).not.toHaveBeenCalled();
    expect(agentState.chatStream).not.toHaveBeenCalled();

    controller.abort();
    await response.body?.cancel().catch(() => undefined);
  });

  it('projects completed recovery before Web resume eligibility short-circuits', async () => {
    const SessionRoutes = await loadSessionRoutes();
    const { Agent } = await import('../../../../src/agent/Agent.js');
    const Bus = await loadBus();
    const recoveredMetadata = metadataFor(
      'completed-web-session',
      '/completed-workspace',
      { permissionMode: 'yolo' }
    );
    vi.mocked(SessionService.listSessions).mockResolvedValue([recoveredMetadata]);
    vi.mocked(SessionService.findSessionMetadata).mockResolvedValue(recoveredMetadata);
    vi.mocked(SessionRuntime.hasPendingInbox).mockResolvedValue(false);
    vi.mocked(SessionRuntime.hasActiveGoal).mockResolvedValue(false);
    vi.mocked(SessionRuntime.hasRecoverableTurn).mockResolvedValue(true);
    runtimeState.runtime.getGoal.mockResolvedValue({ status: 'complete' });
    runtimeState.runtime.getTurnRecoveryAssessment.mockReturnValue({
      state: 'completed',
      turnId: 'turn-finalized-before-restart',
      inputMessageCount: 1,
    });

    const controller = new AbortController();
    const response = await SessionRoutes().request('/completed-web-session/events', {
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    await vi.waitFor(() => {
      expect(Bus.publish).toHaveBeenCalledWith(
        {
          sessionId: 'completed-web-session',
          projectPath: '/completed-workspace',
        },
        'turn.recovery',
        {
          assessment: {
            state: 'completed',
            turnId: 'turn-finalized-before-restart',
            inputMessageCount: 1,
          },
        }
      );
    });
    expect(Agent.createWithRuntime).not.toHaveBeenCalled();
    expect(agentState.chatStream).not.toHaveBeenCalled();

    controller.abort();
    await response.body?.cancel().catch(() => undefined);
  });

  it('wakes an idle Web parent when a background completion is durably queued', async () => {
    const SessionRoutes = await loadSessionRoutes();
    const Bus = await loadBus();
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

  it('builds image-only user content when the request only contains image attachments', async () => {
    const SessionRoutes = await loadSessionRoutes();
    mockResolvedSession('session-3');

    const app = SessionRoutes();

    const response = await requestJson(app, '/session-3/message', 'POST', {
      content: '',
      attachments: [{ type: 'image', content: 'data:image/png;base64,image-only' }],
    });

    expect(response.status).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(agentState.chatStream).toHaveBeenCalledWith(
      [{ type: 'image_url', image_url: { url: 'data:image/png;base64,image-only' } }],
      expect.any(Object),
      expect.any(Object)
    );
  });

  it('persists selected conversation annotations as input metadata', async () => {
    const SessionRoutes = await loadSessionRoutes();
    mockResolvedSession('annotated-session');
    const annotations = [
      {
        id: 'annotation-1',
        text: 'Quoted assistant response',
        sourceMessageId: 'assistant-1',
        sourceRole: 'assistant',
        comment: 'Explain this invariant',
      },
    ];

    const response = await requestJson(
      SessionRoutes(),
      '/annotated-session/message',
      'POST',
      {
        content: 'Why does this matter?',
        annotations,
      }
    );

    expect(response.status).toBe(202);
    expect(runtimeState.runtime.prepareInputTurn).toHaveBeenCalledWith(
      'Why does this matter?',
      {
        metadata: { selectedConversationAnnotations: annotations },
      }
    );
  });

  it('validates and durably prepares a turn-scoped output schema', async () => {
    const SessionRoutes = await loadSessionRoutes();
    mockResolvedSession('structured-session');
    const outputSchema = {
      type: 'object',
      properties: { answer: { type: 'string' } },
      required: ['answer'],
      additionalProperties: false,
    };

    const response = await requestJson(
      SessionRoutes(),
      '/structured-session/message',
      'POST',
      {
        content: 'return a structured answer',
        outputSchema,
      }
    );

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
    const SessionRoutes = await loadSessionRoutes();
    mockResolvedSession('invalid-structured-session');

    const response = await requestJson(
      SessionRoutes(),
      '/invalid-structured-session/message',
      'POST',
      {
        content: 'return a structured answer',
        outputSchema: {
          type: 'object',
          properties: {
            answer: { $ref: 'https://example.com/remote.json' },
          },
        },
      }
    );

    expect(response.status).toBe(400);
    expect(runtimeState.runtime.prepareInputTurn).not.toHaveBeenCalled();
    expect(agentState.chatStream).not.toHaveBeenCalled();
  });

  it('hides the reserved structured-output tool from client history', async () => {
    const SessionRoutes = await loadSessionRoutes();
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

  it.each([
    {
      label: 'reasoning',
      sessionId: 'reasoning-selected-session',
      content: 'use low reasoning',
      setting: { reasoningEffort: 'low' },
      verifyResolution: () =>
        expect(runtimeState.runtime.resolveReasoningConfiguration).toHaveBeenCalledWith(
          'low',
          undefined
        ),
    },
    {
      label: 'service tier',
      sessionId: 'tier-selected-session',
      content: 'use the priority provider tier',
      setting: { serviceTier: 'fast' },
      verifyResolution: () =>
        expect(
          runtimeState.runtime.resolveServiceTierConfiguration
        ).toHaveBeenCalledWith('fast', undefined),
    },
    {
      label: 'response verbosity',
      sessionId: 'verbosity-selected-session',
      content: 'use detailed responses',
      setting: { responseVerbosity: 'high' },
      verifyResolution: () =>
        expect(
          runtimeState.runtime.resolveResponseVerbosityConfiguration
        ).toHaveBeenCalledWith('high', undefined),
    },
    {
      label: 'communication style',
      sessionId: 'style-selected-session',
      content: 'use an explanatory communication style',
      setting: { communicationStyle: 'explanatory' },
      verifyResolution: () =>
        expect(
          runtimeState.runtime.resolveCommunicationStyleConfiguration
        ).toHaveBeenCalledWith('explanatory'),
    },
  ])(
    'validates, persists, and publishes an idle Session $label switch',
    async ({ sessionId, content, setting, verifyResolution }) => {
      const SessionRoutes = await loadSessionRoutes();
      mockResolvedSession(sessionId);

      const response = await requestJson(
        SessionRoutes(),
        `/${sessionId}/message`,
        'POST',
        { content, ...setting }
      );

      expect(response.status).toBe(202);
      verifyResolution();
      expect(runtimeState.runtime.refresh).toHaveBeenCalledWith(setting);
      expect(SessionService.updateSessionMetadata).toHaveBeenCalledWith(
        sessionId,
        expect.any(String),
        setting
      );
      expect(busState.publish).toHaveBeenCalledWith(
        refFor(sessionId),
        'session.updated',
        setting
      );
    }
  );

  it('rolls back an idle runtime switch when the selected model cannot be persisted', async () => {
    const SessionRoutes = await loadSessionRoutes();
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

    const response = await requestJson(
      SessionRoutes(),
      '/model-persistence-failure/message',
      'POST',
      {
        content: 'do not accept a volatile model switch',
        modelId: 'model-2',
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
    const SessionRoutes = await loadSessionRoutes();
    mockResolvedSession('oversized-message-session');
    const halfBudget = 'x'.repeat(Math.floor(MAX_INLINE_ATTACHMENT_BYTES / 2) + 1);

    const response = await requestJson(
      SessionRoutes(),
      '/oversized-message-session/message',
      'POST',
      {
        content: 'inspect these screenshots',
        attachments: [
          { type: 'image', content: halfBudget },
          { type: 'image', content: halfBudget },
        ],
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

  it('rejects Web prompts above the durable character limit before runtime use', async () => {
    const SessionRoutes = await loadSessionRoutes();
    mockResolvedSession('too-large-web-prompt-session');

    const response = await requestJson(
      SessionRoutes(),
      '/too-large-web-prompt-session/message',
      'POST',
      {
        content: 'x'.repeat(MAX_USER_MESSAGE_TEXT_CHARS + 1),
      }
    );

    expect(response.status).toBe(400);
    expect(runtimeState.runtime.prepareInputTurn).not.toHaveBeenCalled();
    expect(agentState.chatStream).not.toHaveBeenCalled();
  });

  it('preserves recovery evidence when outer Web cleanup retries an ack failure', async () => {
    const SessionRoutes = await loadSessionRoutes();
    mockResolvedSession('failed-recovery-ack');
    runtimeState.runtime.getTurnRecoveryAssessment.mockReturnValue({
      state: 'requires_attention',
      turnId: 'turn-before-ack-failure',
      inputMessageCount: 0,
      reason: 'successful_tool_result',
    });
    agentState.chatStream.mockImplementationOnce(async function* () {
      if (Date.now() < 0) yield undefined;
      throw new Error('recovery acknowledgement fsync failed');
    });

    const response = await requestJson(
      SessionRoutes(),
      '/failed-recovery-ack/message',
      'POST',
      { content: 'confirm external state' }
    );

    expect(response.status).toBe(202);
    await vi.waitFor(() => {
      expect(runtimeState.runtime.finishTurn).toHaveBeenCalledWith(
        { id: 'prepared-turn' },
        { preserveStartupRecovery: true }
      );
    });
  });

  it('settles Web recovery attention without publishing completion', async () => {
    const SessionRoutes = await loadSessionRoutes();
    const Bus = await loadBus();
    mockResolvedSession('attention-run');
    const assessment = {
      state: 'requires_attention' as const,
      turnId: 'turn-before-restart',
      inputMessageCount: 1,
      reason: 'interrupted_tool_call' as const,
    };
    agentState.chatStream.mockImplementationOnce(async function* () {
      yield { kind: 'turn_recovery' as const, assessment };
      return {
        success: true,
        finalMessage: '',
        metadata: {
          turnsCount: 0,
          toolCallsCount: 0,
          duration: 0,
          recoveryAttention: assessment,
        },
      };
    });

    const response = await requestJson(
      SessionRoutes(),
      '/attention-run/message',
      'POST',
      { content: 'continue only after attention clears' }
    );

    expect(response.status).toBe(202);
    await vi.waitFor(() => {
      expect(Bus.publish).toHaveBeenCalledWith(
        refFor('attention-run'),
        'session.status',
        { status: 'idle' }
      );
    });
    expect(Bus.publish).toHaveBeenCalledWith(refFor('attention-run'), 'turn.recovery', {
      assessment,
    });
    expect(Bus.publish).not.toHaveBeenCalledWith(
      refFor('attention-run'),
      'session.completed',
      expect.any(Object)
    );
    expect(agentState.chatStream).toHaveBeenCalledTimes(1);
  });

  it('stops the Web follow-up loop when recovery attention appears', async () => {
    const SessionRoutes = await loadSessionRoutes();
    const Bus = await loadBus();
    mockResolvedSession('attention-follow-up');
    runtimeState.runtime.getPendingSteeringCount.mockReturnValue(1);
    const assessment = {
      state: 'requires_attention' as const,
      turnId: 'turn-before-follow-up',
      inputMessageCount: 1,
      reason: 'successful_tool_result' as const,
    };
    agentState.chatStream
      .mockImplementationOnce(async function* () {
        if (Date.now() < 0) yield undefined;
        return {
          success: true,
          finalMessage: 'first turn',
          metadata: { turnsCount: 1, toolCallsCount: 0, duration: 0 },
        };
      })
      .mockImplementationOnce(async function* () {
        yield { kind: 'turn_recovery' as const, assessment };
        return {
          success: true,
          finalMessage: '',
          metadata: {
            turnsCount: 0,
            toolCallsCount: 0,
            duration: 0,
            recoveryAttention: assessment,
          },
        };
      });

    const response = await requestJson(
      SessionRoutes(),
      '/attention-follow-up/message',
      'POST',
      { content: 'start the run' }
    );

    expect(response.status).toBe(202);
    await vi.waitFor(() => expect(agentState.chatStream).toHaveBeenCalledTimes(2));
    expect(Bus.publish).not.toHaveBeenCalledWith(
      refFor('attention-follow-up'),
      'session.completed',
      expect.any(Object)
    );
  });

  it('publishes loop lifecycle events and preserves canonical tool failure state', async () => {
    const SessionRoutes = await loadSessionRoutes();
    const Bus = await loadBus();
    mockResolvedSession('surface-events');

    agentState.chatStream.mockImplementationOnce(async function* () {
      for (const event of sessionRouteLoopEvents()) yield event;
      return {
        success: true,
        finalMessage: 'recovered',
        metadata: { turnsCount: 2, toolCallsCount: 1, duration: 0 },
      };
    });

    const app = SessionRoutes();
    const response = await requestJson(app, '/surface-events/message', 'POST', {
      content: 'recover from the failed command',
    });

    expect(response.status).toBe(202);
    await vi.waitFor(() => {
      expect(Bus.publish).toHaveBeenCalledWith(
        refFor('surface-events'),
        'session.completed',
        expect.any(Object)
      );
    });

    const ref = refFor('surface-events');
    const published = busState.publish.mock.calls.filter(
      ([candidate]) =>
        candidate.sessionId === ref.sessionId &&
        candidate.projectPath === ref.projectPath
    );
    expect(published.map(([, type]) => type)).toEqual(
      expect.arrayContaining([
        'turn.started',
        'turn.recovery',
        'compaction.started',
        'compaction.completed',
        'model.fallback',
        'provider.admission',
        'provider.retry',
        'provider.circuit',
        'provider.stall',
        'thinking.delta',
        'message.created',
        'steering.applied',
        'follow_up.queue.changed',
        'goal.continuation.started',
        'tool.result',
        'session.completed',
      ])
    );
    expect(published).not.toContainEqual([
      ref,
      'message.created',
      expect.objectContaining({ messageId: 'already-persisted' }),
    ]);
    expect(published).toContainEqual([
      ref,
      'message.created',
      expect.objectContaining({
        messageId: 'not-yet-persisted',
        recovered: true,
      }),
    ]);
    expect(published).toContainEqual([
      ref,
      'tool.result',
      expect.objectContaining({
        toolCallId: 'tool-failed-without-error-payload',
        success: false,
      }),
    ]);
  });

  it('returns projection capacity 429 before POST create durable write', async () => {
    const createSessionRouteController = await loadSessionRouteController();
    projectionResidencyConfig.maxResident = 1;
    const resident = metadataFor(
      'projection-create-resident',
      '/tmp/task4-create-capacity-resident'
    );
    const [hydrationGate, releaseHydration] = promiseGate();
    const [hydrationStarted, markHydrationStarted] = promiseGate();
    vi.mocked(SessionService.listSessions).mockResolvedValue([resident]);
    vi.mocked(SessionService.findSessionMetadata).mockImplementation(
      async (sessionId, projectPath) => {
        if (sessionId === resident.sessionId && projectPath === resident.projectPath) {
          markHydrationStarted();
          await hydrationGate;
          return resident;
        }
        return undefined;
      }
    );
    const controller = createSessionRouteController();
    let residentResponse: Response | undefined;

    try {
      const residentResponsePromise = Promise.resolve(
        controller.app.request(
          `/${resident.sessionId}/browser/reset?projectPath=${encodeURIComponent(resident.projectPath)}`,
          { method: 'POST' }
        )
      );
      await hydrationStarted;

      const second = await requestJson(controller.app, '/', 'POST', {
        title: 'Create B',
        projectPath: '/tmp/task4-create-capacity-b',
      });

      expect(second.status).toBe(429);
      await expect(second.json()).resolves.toEqual({
        error: {
          code: 'TOO_MANY_REQUESTS',
          message: 'Session projection capacity is full',
          details: {
            resource: 'resident_session_projections',
            limit: 1,
            retryable: true,
          },
        },
      });
      expect(SessionService.createSessionMetadata).not.toHaveBeenCalled();
      expect(controller.getProjectionResidencyStats()).toMatchObject({
        resident: 0,
        reserved: 1,
        retained: 1,
        maxResident: 1,
      });

      releaseHydration();
      residentResponse = await residentResponsePromise;
      expect(residentResponse.status).toBe(200);
    } finally {
      releaseHydration();
      await controller.shutdown();
    }
  });

  it('creates a durable child without a projection when fork projection capacity is full', async () => {
    const createSessionRouteController = await loadSessionRouteController();
    projectionResidencyConfig.maxResident = 1;
    const source = metadataFor('fork-source-session', '/tmp/task4-fork-source');
    let durableChild: SessionMetadata | undefined;
    const [hydrationGate, releaseHydration] = promiseGate();
    const [hydrationStarted, markHydrationStarted] = promiseGate();
    vi.mocked(SessionService.listSessions).mockImplementation(async () =>
      durableChild ? [source, durableChild] : [source]
    );
    let sourceMetadataLookups = 0;
    vi.mocked(SessionService.findSessionMetadata).mockImplementation(
      async (sessionId, projectPath) => {
        if (sessionId === source.sessionId && projectPath === source.projectPath) {
          sourceMetadataLookups++;
          if (sourceMetadataLookups === 1) {
            markHydrationStarted();
            await hydrationGate;
          }
          return source;
        }
        return undefined;
      }
    );
    vi.mocked(SessionService.forkSession).mockImplementationOnce(
      async (sessionId, options) => {
        if (!options.newSessionId) {
          throw new Error('Expected the route to allocate the fork Session ID');
        }
        durableChild = metadataFor(options.newSessionId, options.targetProjectPath, {
          parentId: sessionId,
          relationType: 'fork',
          rootId: sessionId,
        });
        return {
          sessionId: options.newSessionId,
          parentSessionId: sessionId,
          projectPath: options.targetProjectPath,
          messages: [],
          metadata: durableChild,
        };
      }
    );
    const controller = createSessionRouteController();
    let residentResponse: Response | undefined;

    try {
      const residentResponsePromise = Promise.resolve(
        controller.app.request(
          `/${source.sessionId}/browser/reset?projectPath=${encodeURIComponent(source.projectPath)}`,
          { method: 'POST' }
        )
      );
      await hydrationStarted;
      expect(controller.getProjectionResidencyStats()).toMatchObject({
        resident: 0,
        reserved: 1,
        retained: 1,
        maxResident: 1,
      });

      const forkResponse = await requestJson(
        controller.app,
        `/${source.sessionId}/fork`,
        'POST',
        { projectPath: source.projectPath }
      );

      expect(forkResponse.status).toBe(201);
      const fork = (await forkResponse.json()) as {
        session: { sessionId: string };
        messages: unknown[];
      };
      expect(fork).toMatchObject({
        session: expect.objectContaining({
          sessionId: expect.stringMatching(/^fork-/),
          parentId: source.sessionId,
          relationType: 'fork',
        }),
        messages: [],
      });
      expect(SessionService.forkSession).toHaveBeenCalledWith(source.sessionId, {
        newSessionId: fork.session.sessionId,
        sourceProjectPath: source.projectPath,
        targetProjectPath: source.projectPath,
      });

      const sessionsResponse = await controller.app.request('/');
      const sessions = (await sessionsResponse.json()) as Array<{
        sessionId: string;
        isActive?: boolean;
      }>;
      expect(sessions).toContainEqual(
        expect.objectContaining({
          sessionId: fork.session.sessionId,
          isActive: false,
        })
      );
      expect(controller.getProjectionResidencyStats()).toMatchObject({
        resident: 0,
        reserved: 1,
        retained: 1,
        maxResident: 1,
      });
      releaseHydration();
      residentResponse = await residentResponsePromise;
      expect(residentResponse.status).toBe(200);
    } finally {
      releaseHydration();
      await controller.shutdown();
    }
  });

  it('starts a native read-only review for an exact Session workspace', async () => {
    const SessionRoutes = await loadSessionRoutes();
    const app = SessionRoutes();
    const projectPath = '/tmp/native-review-workspace';
    const created = await requestJson(app, '/', 'POST', {
      title: 'Review',
      projectPath,
    });
    const session = (await created.json()) as { sessionId: string };

    const response = await requestJson(app, `/${session.sessionId}/review`, 'POST', {
      projectPath,
      kind: 'base',
      ref: 'main',
      modelId: 'model-1',
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

  it('rejects task dispatch before durable creation when no model is configured', async () => {
    const createSessionRouteController = await loadSessionRouteController();
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
    const createSessionRouteController = await loadSessionRouteController();
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

  it('closes admission and drains active work before disposing runtimes', async () => {
    const createSessionRouteController = await loadSessionRouteController();
    const [aborted, observeAbort] = promiseGate<unknown>();
    const [completionBarrier, releaseCompletion] = promiseGate();
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

  it('disposes an uncommitted Runtime when residency commit rejects', async () => {
    const createSessionRouteController = await loadSessionRouteController();
    const { SessionRuntime: CurrentSessionRuntime } = await import(
      '../../../../src/agent/runtime/SessionRuntime.js'
    );
    const { SessionRuntimeResidency: CurrentSessionRuntimeResidency } = await import(
      '../../../../src/agent/runtime/SessionRuntimeResidency.js'
    );
    const sessionId = 'runtime-commit-failure';
    const projectPath = '/tmp/runtime-commit-failure';
    mockResolvedSession(sessionId, { projectPath });
    const commitFailure = new Error('injected residency commit failure');

    const createRuntime = vi.mocked(CurrentSessionRuntime.create);
    const defaultCreateRuntime = createRuntime.getMockImplementation();
    if (!defaultCreateRuntime) throw new Error('Expected SessionRuntime.create mock');
    let createdRuntime: SessionRuntime | undefined;
    createRuntime.mockReset().mockImplementation(async (...args) => {
      createdRuntime = await defaultCreateRuntime(...args);
      return createdRuntime;
    });
    const originalReserve = CurrentSessionRuntimeResidency.prototype.reserve;
    const reserveRuntime = vi
      .spyOn(CurrentSessionRuntimeResidency.prototype, 'reserve')
      .mockImplementation(async function (key, options) {
        const reservation = await originalReserve.call(this, key, options);
        return {
          commit: () => {
            throw commitFailure;
          },
          cancel: () => reservation.cancel(),
        };
      });

    const controller = createSessionRouteController();
    try {
      const response = await controller.app.request(
        `/${sessionId}/subagents?projectPath=${encodeURIComponent(projectPath)}`
      );

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({
        error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
      });
      if (!createdRuntime) throw new Error('Expected SessionRuntime.create result');
      expect(CurrentSessionRuntime.create).toHaveBeenCalledOnce();
      expect(createdRuntime.dispose).toHaveBeenCalledOnce();
      expect(createdRuntime.listSubagents).not.toHaveBeenCalled();
      expect(loggerState.error).toHaveBeenCalledWith(
        '[SessionRoutes] Unhandled route error:',
        commitFailure
      );
      expect(controller.getRuntimeResidencyStats()).toMatchObject({
        resident: 0,
        reserved: 0,
        pinned: 0,
      });

      await controller.shutdown();
      expect(createdRuntime.dispose).toHaveBeenCalledOnce();
    } finally {
      await controller.shutdown().catch(() => undefined);
      reserveRuntime.mockRestore();
      createRuntime.mockReset().mockImplementation(defaultCreateRuntime);
    }
  });

  it('cancels a queued run durably and immediately reuses its queue slot', async () => {
    const createSessionRouteController = await loadSessionRouteController();
    runtimeState.runtime.getTaskAdmissionLimits.mockReturnValue({
      maxConcurrent: 1,
      maxQueued: 1,
      maxQueuedBytes: 64 * 1024 * 1024,
    });
    const [firstGate, releaseFirst] = promiseGate();
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

  it('rejects pending task byte overflow and immediately reuses capacity', async () => {
    const createSessionRouteController = await loadSessionRouteController();
    runtimeState.runtime.getTaskAdmissionLimits.mockReturnValue({
      maxConcurrent: 1,
      maxQueued: 10,
      maxQueuedBytes: 64 * 1024,
    });
    const [firstGate, releaseFirst] = promiseGate();
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
    const createSessionRouteController = await loadSessionRouteController();
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
    const createSessionRouteController = await loadSessionRouteController();
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
    const [runningGate, releaseRunning] = promiseGate();
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
    const createSessionRouteController = await loadSessionRouteController();
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

  it('rejects task creation before durable writes when projection capacity is reserved elsewhere', async () => {
    const createSessionRouteController = await loadSessionRouteController();
    projectionResidencyConfig.maxResident = 1;
    const resident = metadataFor(
      'task-capacity-resident',
      '/tmp/task-capacity-resident'
    );
    const [hydrationGate, releaseHydration] = promiseGate();
    const [hydrationStarted, markHydrationStarted] = promiseGate();
    vi.mocked(SessionService.listSessions).mockResolvedValue([resident]);
    vi.mocked(SessionService.findSessionMetadata).mockImplementation(
      async (sessionId, projectPath) => {
        if (sessionId === resident.sessionId && projectPath === resident.projectPath) {
          markHydrationStarted();
          await hydrationGate;
          return resident;
        }
        return undefined;
      }
    );
    const controller = createSessionRouteController();

    try {
      const residentResponsePromise = Promise.resolve(
        controller.app.request(
          `/${resident.sessionId}/browser/reset?projectPath=${encodeURIComponent(resident.projectPath)}`,
          { method: 'POST' }
        )
      );
      await hydrationStarted;

      await expect(
        controller.dispatchTask({
          prompt: 'Must fail before durable task create',
          sourceProjectPath: '/tmp/task-capacity-source',
          isolation: 'worktree',
          permissionMode: PermissionMode.DEFAULT,
        })
      ).rejects.toMatchObject({
        code: 'TOO_MANY_REQUESTS',
        statusCode: 429,
        details: {
          resource: 'resident_session_projections',
          limit: 1,
          retryable: true,
        },
      });
      expect(SessionService.createSessionMetadata).not.toHaveBeenCalled();
      expect(worktreeState.enter).not.toHaveBeenCalled();
      expect(controller.getProjectionResidencyStats()).toMatchObject({
        resident: 0,
        reserved: 1,
        pinned: 0,
        retained: 1,
        maxResident: 1,
      });

      releaseHydration();
      expect((await residentResponsePromise).status).toBe(200);
      expect(controller.getProjectionResidencyStats()).toMatchObject({
        pinned: 0,
      });
    } finally {
      releaseHydration();
      await controller.shutdown();
    }
  });

  it('keeps an active session visible when another workspace persists the same id as a subagent', async () => {
    const SessionRoutes = await loadSessionRoutes();

    const app = SessionRoutes();
    const createResponse = await requestJson(app, '/', 'POST', {
      title: 'Workspace B active session',
      projectPath: '/tmp/workspace-b',
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
    const SessionRoutes = await loadSessionRoutes();

    const metadata = metadataFor('ghost-session', '/tmp/ghost-workspace', {
      title: 'Ghost session',
    });
    let observedSignal: AbortSignal | undefined;
    const [runGate, releaseRun] = promiseGate();

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
    const startResponse = await requestJson(
      app1,
      `/ghost-session/message?projectPath=${encodeURIComponent('/tmp/ghost-workspace')}`,
      'POST',
      { content: 'leave a ghost run behind' }
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
    const SessionRoutes = await loadSessionRoutes();
    const SessionService = await loadSessionService();
    vi.mocked(SessionService.createSessionMetadata).mockRejectedValueOnce(
      new Error('disk full')
    );

    const app = SessionRoutes();
    const createResponse = await requestJson(app, '/', 'POST', {
      title: 'Unpersisted',
      projectPath: '/tmp/task4-create-fail',
    });

    expect(createResponse.status).toBe(500);

    const listResponse = await app.request('/');
    expect(listResponse.status).toBe(200);
    expect(await listResponse.json()).toEqual([]);
  });

  it('does not mutate the active title when durable rename fails', async () => {
    const SessionRoutes = await loadSessionRoutes();
    const SessionService = await loadSessionService();
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
    const patchResponse = await requestJson(app, '/stable-title-session', 'PATCH', {
      title: 'Should not stick',
      projectPath: '/tmp/task4-stable-title',
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
    const SessionRoutes = await loadSessionRoutes();
    const SessionService = await loadSessionService();

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

  it('returns exact lookup errors for SSE instead of falling back to the request directory', async () => {
    const SessionRoutes = await loadSessionRoutes();

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
    const SessionRoutes = await loadSessionRoutes();
    const Bus = await loadBus();
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

  it('cleans up the listener when the connected write rejects', async () => {
    const { SSEStreamingApi } = await import('hono/streaming');
    const writeSse = vi
      .spyOn(SSEStreamingApi.prototype, 'writeSSE')
      .mockRejectedValueOnce(new Error('connected write failed'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const SessionRoutes = await loadSessionRoutes();
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
    const SessionRoutes = await loadSessionRoutes();
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
      timers: 2,
      ended: true,
    });
  });

  it('cuts replay over to live committed events without duplicates or cursor regression', async () => {
    const SessionRoutes = await loadSessionRoutes();
    const Bus = await loadBus();
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

  it('removes a deleted task worktree after durable session deletion', async () => {
    const createSessionRouteController = await loadSessionRouteController();
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

  it('persists a safe conflict reason without removing the task worktree', async () => {
    const createSessionRouteController = await loadSessionRouteController();
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
    const createSessionRouteController = await loadSessionRouteController();
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

  it('keeps volatile session state after durable delete failure while marking the run cancelled', async () => {
    const SessionRoutes = await loadSessionRoutes();

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
    const [runGate, releaseRun] = promiseGate();

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
    const startResponse = await requestJson(
      app,
      `/delete-failure-session/message?projectPath=${encodeURIComponent('/tmp/delete-failure-workspace')}`,
      'POST',
      { content: 'start delete failure run' }
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

  it('routes permission responses through the unified exact session resolver', async () => {
    const permissionApp = await createPermissionsApp();

    const relativeProjectPath = await requestJson(
      permissionApp,
      '/permissions/perm-1?sessionId=shared-session&projectPath=relative-path',
      'POST',
      { approved: true }
    );
    expect(relativeProjectPath.status).toBe(400);
    await expect(relativeProjectPath.json()).resolves.toMatchObject({
      error: { code: 'BAD_REQUEST' },
    });

    const explicitMissing = await requestJson(
      permissionApp,
      `/permissions/perm-1?sessionId=shared-session&projectPath=${encodeURIComponent('/tmp/workspace-a')}`,
      'POST',
      { approved: true }
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

    const ambiguous = await requestJson(
      permissionApp,
      '/permissions/perm-1?sessionId=shared-session',
      'POST',
      { approved: true }
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
      requestJson(
        app,
        `/sessions/shared-session/message?projectPath=${encodeURIComponent(projectPath)}`,
        'POST',
        { content: `run in ${projectPath}` }
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

    const firstPermissionResponse = await requestJson(
      app,
      `/permissions/${firstPermissionId}?sessionId=shared-session&projectPath=${encodeURIComponent('/tmp/workspace-a')}`,
      'POST',
      { approved: true }
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

    const secondPermissionResponse = await requestJson(
      app,
      `/permissions/${secondPermissionId}?sessionId=shared-session&projectPath=${encodeURIComponent('/tmp/workspace-b')}`,
      'POST',
      { approved: true }
    );
    expect(secondPermissionResponse.status).toBe(200);

    await vi.waitFor(() => {
      expect(resolvedPermissions).toEqual(['/tmp/workspace-a', '/tmp/workspace-b']);
    });
  });

  it('routes goal creation and continuation to the exact session workspace', async () => {
    const SessionRoutes = await loadSessionRoutes();
    mockDuplicateSessions('shared-goal');
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

    vi.mocked(SessionRuntime.create).mockImplementation(
      async ({ workspaceRoot }: SessionRuntimeOptions) =>
        workspaceRoot === '/tmp/workspace-a' ? runtimeA : runtimeB
    );

    const app = SessionRoutes();
    const response = await requestJson(
      app,
      `/shared-goal/goal?projectPath=${encodeURIComponent('/tmp/workspace-a')}`,
      'PUT',
      { objective: 'finish workspace A' }
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

    const ambiguous = await requestJson(app, '/shared-goal/goal', 'PUT', {
      objective: 'must not guess a workspace',
    });
    expect(ambiguous.status).toBe(409);
    expect(createGoalB).not.toHaveBeenCalled();
  });

  it('lists and rewinds checkpoints in the exact session workspace', async () => {
    const SessionRoutes = await loadSessionRoutes();
    const metadataA = metadataFor('shared-rewind', '/tmp/workspace-a');
    const metadataB = metadataFor('shared-rewind', '/tmp/workspace-b');
    const rewoundMetadataA = metadataFor('shared-rewind', '/tmp/workspace-a', {
      messageCount: 1,
      lastMessageTime: '2026-08-05T00:00:01.000Z',
    });
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
    let rewound = false;
    rewindA.mockImplementation(async () => {
      rewound = true;
      return {
        checkpoint: checkpoints[0],
        mode: 'both',
        removedTurns: 1,
        restoredFiles: ['/tmp/workspace-a/result.txt'],
        messages: rewoundMessages,
      };
    });
    vi.mocked(SessionService.findSessionMetadata).mockImplementation(
      async (sessionId: string, projectPath?: string) => {
        if (sessionId !== 'shared-rewind') return undefined;
        if (projectPath === '/tmp/workspace-a') {
          return rewound ? rewoundMetadataA : metadataA;
        }
        if (projectPath === '/tmp/workspace-b') return metadataB;
        return undefined;
      }
    );
    vi.mocked(SessionRuntime.create).mockImplementation(
      async ({ workspaceRoot }: SessionRuntimeOptions) =>
        workspaceRoot === '/tmp/workspace-a' ? runtimeA : runtimeB
    );
    vi.mocked(SessionService.loadSession).mockImplementation(
      async (sessionId: string, projectPath?: string) =>
        sessionId === 'shared-rewind' && projectPath === '/tmp/workspace-a'
          ? rewoundMessages
          : []
    );

    const app = SessionRoutes();
    const listResponse = await app.request(
      `/shared-rewind/rewind?projectPath=${encodeURIComponent('/tmp/workspace-a')}`
    );
    expect(listResponse.status).toBe(200);
    await expect(listResponse.json()).resolves.toEqual({ checkpoints });
    expect(listA).toHaveBeenCalledOnce();
    expect(listB).not.toHaveBeenCalled();

    const rewindResponse = await requestJson(
      app,
      `/shared-rewind/rewind?projectPath=${encodeURIComponent('/tmp/workspace-a')}`,
      'POST',
      { targetMessageId: 'user-a', mode: 'both' }
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
    expect(SessionService.loadSession).toHaveBeenCalledWith(
      'shared-rewind',
      '/tmp/workspace-a'
    );
    const sessionsResponse = await app.request('/');
    const sessions = (await sessionsResponse.json()) as Array<{
      projectPath: string;
      messageCount: number;
      lastMessageTime: string;
    }>;
    expect(
      sessions.find((session) => session.projectPath === '/tmp/workspace-a')
    ).toMatchObject({
      messageCount: 1,
      lastMessageTime: rewoundMetadataA.lastMessageTime,
    });

    const ambiguous = await app.request('/shared-rewind/rewind');
    expect(ambiguous.status).toBe(409);
    expect(listB).not.toHaveBeenCalled();
  });

  it('lists and resumes durable subagents in the exact session workspace', async () => {
    const SessionRoutes = await loadSessionRoutes();
    mockDuplicateSessions('shared-subagents');
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

    const resumed = await requestJson(
      app,
      `/shared-subagents/subagents/${source.id}/resume?projectPath=${encodeURIComponent('/tmp/workspace-a')}`,
      'POST',
      { prompt: 'Check the follow-up' }
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

  it('executes a user shell command through the exact Session runtime', async () => {
    const SessionRoutes = await loadSessionRoutes();
    const SessionService = await loadSessionService();
    const initialMetadata = makeSessionMetadata({
      sessionId: 'shell-session',
      projectPath: '/tmp/shell-workspace',
      messageCount: 0,
    });
    const updatedMetadata = makeSessionMetadata({
      sessionId: 'shell-session',
      projectPath: '/tmp/shell-workspace',
      messageCount: 1,
    });
    vi.mocked(SessionService.findSessionMetadata)
      .mockResolvedValueOnce(initialMetadata)
      .mockResolvedValueOnce(initialMetadata)
      .mockResolvedValue(updatedMetadata);
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

    const app = SessionRoutes();
    const response = await requestJson(app, '/shell-session/shell', 'POST', {
      command: 'pwd',
      projectPath: '/tmp/shell-workspace',
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
    expect(SessionService.loadSession).not.toHaveBeenCalled();
    expect(SessionService.findSessionMetadata).toHaveBeenLastCalledWith(
      'shell-session',
      '/tmp/shell-workspace'
    );
    const sessionsResponse = await app.request('/');
    const sessions = (await sessionsResponse.json()) as Array<{
      sessionId: string;
      messageCount: number;
    }>;
    expect(
      sessions.find((session) => session.sessionId === 'shell-session')
    ).toMatchObject({ messageCount: 1 });
    expect(agentState.chatStream).not.toHaveBeenCalled();
  });

  it('preserves shutdown cancellation while a side-question runtime initializes', async () => {
    const createSessionRouteController = await loadSessionRouteController();
    const sessionId = 'initializing-side-question';
    const projectPath = '/tmp/initializing-side-question';
    mockResolvedSession(sessionId, { projectPath });
    const [initialization, releaseInitialization] = promiseGate();
    const [started, resolveStarted] = promiseGate();
    vi.mocked(SessionRuntime.create).mockImplementationOnce(async () => {
      resolveStarted();
      await initialization;
      return createRuntimeDouble({ sessionId, workspaceRoot: projectPath });
    });
    let sideSignal: AbortSignal | undefined;
    runtimeState.runtime.askSideQuestion.mockImplementationOnce(
      async (_question, options) => {
        sideSignal = options?.signal;
        throw new DOMException('Aborted', 'AbortError');
      }
    );
    const controller = createSessionRouteController();
    const pending = requestJson(controller.app, `/${sessionId}/side-question`, 'POST', {
      question: 'Explain the current work',
      projectPath,
    });
    let shutdown: Promise<void> | undefined;
    try {
      await started;
      shutdown = controller.shutdown('initialization-shutdown');
      expect(runtimeState.runtime.dispose).not.toHaveBeenCalled();
      const rejected = await requestJson(
        controller.app,
        `/${sessionId}/side-question`,
        'POST',
        { question: 'Do not admit this request', projectPath }
      );
      expect(rejected.status).toBe(503);
      releaseInitialization();
      await pending;
      await shutdown;
      expect(runtimeState.runtime.askSideQuestion).toHaveBeenCalledOnce();
      expect(sideSignal?.aborted).toBe(true);
      expect(sideSignal?.reason).toBe('initialization-shutdown');
      expect(runtimeState.runtime.dispose).toHaveBeenCalledOnce();
      expect(runtimeState.runtime.prepareInputTurn).not.toHaveBeenCalled();
    } finally {
      releaseInitialization();
      await pending;
      await (shutdown ?? controller.shutdown());
    }
  });

  it('uses the source project for a discarded worktree side conversation', async () => {
    const SessionRoutes = await loadSessionRoutes();
    const projectPath = '/tmp/removed-side-worktree';
    const sourceProjectPath = '/tmp/source-project';
    vi.mocked(SessionService.findSessionMetadata).mockResolvedValue(
      makeSessionMetadata({
        sessionId: 'discarded-side-session',
        projectPath,
        taskIsolation: 'worktree',
        taskSourceProjectPath: sourceProjectPath,
        taskDelivery: {
          status: 'discarded',
          updatedAt: '2026-09-11T00:00:00.000Z',
          message: 'Task worktree removed',
        },
        messageCount: 2,
      })
    );
    runtimeState.runtime.askSideQuestion.mockResolvedValueOnce({
      response: 'The task wrote one file.',
      durationMs: 11,
    });

    const response = await requestJson(
      SessionRoutes(),
      '/discarded-side-session/side-question',
      'POST',
      {
        question: 'What did this task do?',
        projectPath,
      }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      response: 'The task wrote one file.',
    });
    expect(resolveWorkspaceModelResources).toHaveBeenCalledWith(
      sourceProjectPath,
      expect.any(Object)
    );
    expect(resolveWorkspaceAgentResources).toHaveBeenCalledWith(sourceProjectPath);
    expect(SessionRuntime.create).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'discarded-side-session',
        workspaceRoot: projectPath,
        workspace: {
          kind: 'local',
          executionRoot: sourceProjectPath,
          resourceRoot: sourceProjectPath,
        },
        modelResources: expect.objectContaining({
          projectRoot: sourceProjectPath,
        }),
        agentResources: expect.objectContaining({
          projectRoot: sourceProjectPath,
        }),
        lspResources: {
          projectRoot: sourceProjectPath,
          servers: {},
        },
        auxiliaryReadOnly: true,
      })
    );
    expect(runtimeState.runtime.askSideQuestion).toHaveBeenCalledWith(
      'What did this task do?',
      { signal: expect.any(AbortSignal) }
    );
    expect(runtimeState.runtime.dispose).toHaveBeenCalledTimes(1);
    expect(runtimeState.runtime.prepareInputTurn).not.toHaveBeenCalled();
    expect(runtimeState.runtime.enqueueSteering).not.toHaveBeenCalled();
  });

  it('returns a clear conflict when a discarded worktree has no source project', async () => {
    const SessionRoutes = await loadSessionRoutes();
    const projectPath = '/tmp/removed-side-worktree';
    vi.mocked(SessionService.findSessionMetadata).mockResolvedValue(
      makeSessionMetadata({
        sessionId: 'missing-side-source',
        projectPath,
        taskIsolation: 'worktree',
        taskDelivery: {
          status: 'discarded',
          updatedAt: '2026-09-11T00:00:00.000Z',
          message: 'Task worktree removed',
        },
        messageCount: 2,
      })
    );

    const response = await requestJson(
      SessionRoutes(),
      '/missing-side-source/side-question',
      'POST',
      {
        question: 'What did this task do?',
        projectPath,
      }
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'SESSION_WORKSPACE_UNAVAILABLE',
        message: 'This session workspace is no longer available',
        details: {
          reason: 'task_source_project_missing',
        },
      },
    });
    expect(SessionRuntime.create).not.toHaveBeenCalled();
  });

  it('returns a clear conflict when the side conversation fallback path is missing', async () => {
    const SessionRoutes = await loadSessionRoutes();
    const projectPath = '/tmp/removed-side-worktree';
    const sourceProjectPath = '/tmp/missing-source-project';
    vi.mocked(SessionService.findSessionMetadata).mockResolvedValue(
      makeSessionMetadata({
        sessionId: 'missing-side-workspace',
        projectPath,
        taskIsolation: 'worktree',
        taskSourceProjectPath: sourceProjectPath,
        taskDelivery: {
          status: 'discarded',
          updatedAt: '2026-09-11T00:00:00.000Z',
          message: 'Task worktree removed',
        },
        messageCount: 2,
      })
    );
    vi.mocked(resolveWorkspaceModelResources).mockRejectedValueOnce(
      Object.assign(new Error('missing workspace'), { code: 'ENOENT' })
    );

    const response = await requestJson(
      SessionRoutes(),
      '/missing-side-workspace/side-question',
      'POST',
      {
        question: 'What did this task do?',
        projectPath,
      }
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'SESSION_WORKSPACE_UNAVAILABLE',
        message: 'This session workspace is no longer available',
        details: {
          reason: 'workspace_missing',
        },
      },
    });
    expect(SessionRuntime.create).not.toHaveBeenCalled();
  });

  it('owns session SSE shutdown, drains connected readers, and blocks runtime disposal until a team callback settles', async () => {
    const { TeamMailbox } = await import('../../../../src/agent/teams/TeamMailbox.js');
    const createSessionRouteController = await loadSessionRouteController();
    const sessionId = 'shutdown-owned-session';
    const projectPath = '/tmp/shutdown-owned-session';
    const ref = { sessionId, projectPath };
    mockResolvedSession(sessionId, { projectPath });

    const [enqueueGate, releaseEnqueue] = promiseGate();
    const [enqueueStarted, resolveEnqueueStarted] = promiseGate();
    runtimeState.runtime.enqueueSteering.mockImplementationOnce(
      async () =>
        new Promise((resolve) => {
          resolveEnqueueStarted();
          enqueueGate.then(() =>
            resolve({
              accepted: true,
              messageId: 'team-message-1',
              turnId: 'turn-team-1',
              queued: 1,
              delivery: 'next_turn',
            })
          );
        })
    );
    const markDelivered = vi
      .spyOn(TeamMailbox.prototype, 'markDelivered')
      .mockResolvedValue(undefined);

    const controller = createSessionRouteController();
    const response = await controller.app.request(
      `/${sessionId}/events?projectPath=${encodeURIComponent(projectPath)}`
    );
    const collector = createSseCollector(response);
    let shutdown: Promise<void> | undefined;
    let secondRead: Promise<{ done: boolean }> | undefined;

    try {
      await expect(collector.next()).resolves.toMatchObject({ type: 'connected' });

      const maybeStatsController = controller as typeof controller & {
        getSseConnectionStats?: () => { accepting: boolean; active: number };
      };
      if (!('getSseConnectionStats' in maybeStatsController)) {
        throw new Error(
          'expected owned Session route controller getSseConnectionStats()'
        );
      }
      expect(maybeStatsController.getSseConnectionStats?.()).toEqual({
        accepting: true,
        active: 1,
      });

      busState.publish(ref, 'team.message.received', {
        teamName: 'shutdown-team',
        messageId: 'team-message-1',
        content: 'deliver while shutdown is waiting',
        metadata: {
          clientVisible: false,
          teamMessage: {
            messageId: 'team-message-1',
            teamName: 'shutdown-team',
            from: 'worker',
            to: 'team-lead',
          },
        },
      });
      await enqueueStarted;

      secondRead = collector.readDone(1000);

      shutdown = controller.shutdown('server-shutdown');
      await expect(secondRead).resolves.toMatchObject({ done: true });

      let shutdownSettled = false;
      const observedShutdown = shutdown.then(() => {
        shutdownSettled = true;
      });
      await Promise.resolve();

      expect(shutdownSettled).toBe(false);
      expect(markDelivered).not.toHaveBeenCalled();
      expect(runtimeState.runtime.dispose).not.toHaveBeenCalled();
      expect(busState.subscribers.size).toBe(0);
      expect(maybeStatsController.getSseConnectionStats?.()).toEqual({
        accepting: false,
        active: 1,
      });

      busState.publish(ref, 'team.message.received', {
        teamName: 'shutdown-team',
        messageId: 'team-message-late',
        content: 'must not start new work after unsubscribe',
        metadata: {
          clientVisible: false,
          teamMessage: {
            messageId: 'team-message-late',
            teamName: 'shutdown-team',
            from: 'worker',
            to: 'team-lead',
          },
        },
      });
      expect(runtimeState.runtime.enqueueSteering).toHaveBeenCalledTimes(1);

      releaseEnqueue();
      await expect(observedShutdown).resolves.toBeUndefined();
      expect(markDelivered).toHaveBeenCalledTimes(1);
      expect(runtimeState.runtime.dispose).toHaveBeenCalledOnce();
      expect(maybeStatsController.getSseConnectionStats?.()).toEqual({
        accepting: false,
        active: 0,
      });
    } finally {
      releaseEnqueue?.();
      await shutdown?.catch(() => undefined);
      await collector.cancel();
      markDelivered.mockRestore();
    }
  });
});
