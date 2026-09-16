import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AcpSession, createLocalAcpSessionRoots } from '../../../../src/acp/Session.js';
import { MAX_USER_MESSAGE_TEXT_CHARS } from '../../../../src/api/attachmentLimits.js';
import { Bus } from '../../../../src/server/bus.js';
import { comprehensiveLoopEvents } from '../../../support/comprehensiveLoopEvents.js';

const mocks = vi.hoisted(() => ({
  createAgent: vi.fn(),
  createRuntime: vi.fn(),
  destroyService: vi.fn(),
  initializeCommands: vi.fn(),
  initializeService: vi.fn(),
  resolveInteraction: vi.fn(),
  sessionUpdate: vi.fn(),
  setPermissionMode: vi.fn(),
  updateMetadata: vi.fn(),
}));

vi.mock('../../../../src/agent/Agent.js', () => ({
  Agent: { createWithRuntime: mocks.createAgent },
}));

vi.mock('../../../../src/agent/runtime/SessionRuntime.js', () => ({
  SessionRuntime: { create: mocks.createRuntime },
}));

vi.mock('../../../../src/acp/AcpServiceContext.js', () => ({
  AcpServiceContext: {
    initializeSession: mocks.initializeService,
    destroyRegisteredSession: mocks.destroyService,
    setCurrentSession: vi.fn(),
    getTerminalService: () => ({ execute: vi.fn() }),
  },
}));

vi.mock('../../../../src/services/SessionInteractionService.js', () => ({
  SessionInteractionService: {
    resolvePendingWithHandler: mocks.resolveInteraction,
  },
}));

vi.mock('../../../../src/services/CodeReviewService.js', () => ({
  CodeReviewService: { recoverInterrupted: vi.fn().mockResolvedValue(false) },
  renderCodeReview: vi.fn(),
}));

vi.mock('../../../../src/services/SessionService.js', () => ({
  SessionMissingCreationError: class SessionMissingCreationError extends Error {},
  SessionService: {
    loadSession: vi.fn().mockResolvedValue([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' },
    ]),
    loadSessionModelContext: vi.fn().mockResolvedValue([]),
    setSessionPermissionMode: mocks.setPermissionMode,
    updateSessionMetadata: mocks.updateMetadata,
    createSessionMetadata: vi.fn(),
  },
}));

vi.mock('../../../../src/slash-commands/index.js', () => ({
  executeSlashCommand: vi.fn(),
  getRegisteredCommands: () => [
    { name: 'help', description: 'Show help', usage: '/help', aliases: [] },
  ],
  initializeCustomCommands: mocks.initializeCommands,
  isSlashCommand: (value: string) => value.startsWith('/'),
}));

function configuration(selection: string) {
  return { selection, effective: selection, supported: [selection] };
}

function createRuntime() {
  return {
    dispose: vi.fn().mockResolvedValue(undefined),
    discardPendingInput: vi.fn().mockResolvedValue(undefined),
    enqueueSteering: vi.fn().mockResolvedValue({ accepted: true, queued: 1 }),
    executeUserShellCommand: vi.fn(),
    getPendingSteeringCount: vi.fn(() => 0),
    getPendingSteeringMessages: vi.fn(() => []),
    getFollowUpQueueSnapshot: vi.fn().mockResolvedValue({
      version: 'a'.repeat(64),
      pending: 0,
      mutable: 0,
      locked: 0,
      internal: 0,
      items: [],
    }),
    getProviderRecoveryProjection: vi.fn(() => ({
      version: 1,
      generation: 'recovery',
      revision: 0,
      snapshot: null,
    })),
    getTurnActivityProjection: vi.fn(() => ({
      version: 1,
      generation: 'activity',
      revision: 0,
      snapshot: null,
    })),
    getTurnRecoveryAssessment: vi.fn(() => ({ state: 'none' })),
    getGoal: vi.fn().mockResolvedValue(null),
    getCurrentModelId: vi.fn(() => 'model-1'),
    getConfig: vi.fn(() => ({
      currentModelId: 'model-1',
      models: [],
      modelProviders: {},
    })),
    getReasoningConfiguration: vi.fn(() => configuration('off')),
    resolveReasoningConfiguration: vi.fn(configuration),
    getServiceTierConfiguration: vi.fn(() => configuration('auto')),
    resolveServiceTierConfiguration: vi.fn(configuration),
    getResponseVerbosityConfiguration: vi.fn(() => configuration('auto')),
    resolveResponseVerbosityConfiguration: vi.fn(configuration),
    getCommunicationStyleConfiguration: vi.fn(() => ({
      ...configuration('auto'),
      name: 'Auto',
      description: 'Default',
      source: 'built-in',
    })),
    resolveCommunicationStyleConfiguration: vi.fn((selection: string) => ({
      ...configuration(selection),
      name: selection,
      description: selection,
      source: 'built-in',
    })),
    refresh: vi.fn().mockResolvedValue(undefined),
    isIdleForResidency: vi.fn(() => true),
  };
}

describe('AcpSession', () => {
  let abort: AbortController;
  let runtime: ReturnType<typeof createRuntime>;
  let session: AcpSession;
  const agent = {
    chatStream: vi.fn(),
    switchModel: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    abort = new AbortController();
    runtime = createRuntime();
    mocks.createRuntime.mockResolvedValue(runtime);
    mocks.createAgent.mockResolvedValue(agent);
    agent.chatStream.mockImplementation(async function* () {
      yield { kind: 'stream_end' as const };
      return {
        success: true,
        finalMessage: 'done',
        metadata: { turnsCount: 1, toolCallsCount: 0, duration: 1 },
      };
    });
    mocks.initializeService.mockReturnValue({
      generation: 'registration-1',
      sessionId: 'session-1',
    });
    mocks.resolveInteraction.mockResolvedValue(false);
    mocks.initializeCommands.mockResolvedValue({
      commands: [],
      scannedDirs: [],
      errors: [],
    });
    mocks.setPermissionMode.mockImplementation(
      async (_id: string, _root: string, permissionMode: string) => ({
        permissionMode,
      })
    );
    mocks.updateMetadata.mockImplementation(
      async (_id: string, _root: string, update: object) => update
    );
    session = new AcpSession(
      'session-1',
      createLocalAcpSessionRoots('/workspace'),
      {
        signal: abort.signal,
        sessionUpdate: mocks.sessionUpdate,
        requestPermission: vi.fn(),
      } as never,
      {},
      {
        initialMessages: [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'world' },
        ],
      }
    );
  });

  afterEach(async () => {
    await session.destroy().catch(() => undefined);
    vi.useRealTimers();
  });

  it('projects the complete loop event surface through ACP updates', async () => {
    agent.chatStream.mockImplementation(async function* () {
      for (const event of comprehensiveLoopEvents()) yield event;
      return {
        success: true,
        finalMessage: 'done',
        metadata: {
          turnsCount: 1,
          toolCallsCount: 4,
          duration: 1,
          structuredOutput: { status: 'ok' },
          structuredOutputSchemaDigest: 'f'.repeat(64),
          goalCompletionVerified: true,
          goalVerificationVerdict: 'pass' as const,
          goalVerifierSessionId: 'verifier-1',
          goalVerificationEvidenceSha256: 'e'.repeat(64),
        },
      };
    });
    await session.initialize();
    mocks.sessionUpdate.mockClear();

    const response = await session.prompt({
      sessionId: 'session-1',
      prompt: [{ type: 'text', text: 'exercise the event surface' }],
    });

    const updates = mocks.sessionUpdate.mock.calls.map(([notification]) => {
      const value = notification as {
        update: { sessionUpdate: string; _meta?: Record<string, unknown> };
      };
      return value.update;
    });
    expect(response).toMatchObject({
      stopReason: 'end_turn',
      _meta: {
        structuredOutput: { status: 'ok' },
        goalCompletion: {
          verified: true,
          verdict: 'pass',
          verifierSessionId: 'verifier-1',
        },
      },
    });
    expect(new Set(updates.map((update) => update.sessionUpdate))).toEqual(
      expect.objectContaining(
        new Set([
          'agent_message_chunk',
          'agent_thought_chunk',
          'tool_call',
          'tool_call_update',
          'plan',
          'session_info_update',
          'user_message_chunk',
        ])
      )
    );
    expect(updates.some((update) => update._meta?.['blade/goal'])).toBe(true);
    expect(updates.some((update) => update._meta?.['blade/goalFrontier'])).toBe(true);
    expect(updates.some((update) => update._meta?.['blade/compaction'])).toBe(true);
    expect(updates.some((update) => update._meta?.['blade/modelFallback'])).toBe(true);
    expect(updates.at(-1)?._meta?.['blade/providerAdmission']).toBeNull();
  });

  it('routes multimodal, resource, steering, and bounded prompt inputs', async () => {
    await session.initialize();
    await session.prompt({
      sessionId: 'session-1',
      prompt: [
        { type: 'text', text: 'Inspect' },
        { type: 'image', mimeType: 'image/png', data: 'image-data' },
        {
          type: 'resource',
          resource: {
            uri: 'context://guide',
            mimeType: 'text/plain',
            text: 'inline guide',
          },
        },
        { type: 'resource_link', uri: 'context://linked', name: 'linked' },
      ],
    });
    expect(agent.chatStream).toHaveBeenLastCalledWith(
      expect.arrayContaining([
        {
          type: 'image_url',
          image_url: { url: 'data:image/png;base64,image-data' },
        },
        {
          type: 'text',
          text: '<file path="context://guide">\ninline guide\n</file>',
        },
        { type: 'text', text: '[Resource: context://linked]' },
      ]),
      expect.objectContaining({
        workspaceRoot: '/workspace',
        workspaceKind: 'local',
      }),
      expect.any(Object)
    );

    (session as unknown as { pendingPrompt: AbortController | null }).pendingPrompt =
      new AbortController();
    runtime.enqueueSteering.mockResolvedValueOnce({
      accepted: true,
      queued: 1,
      delivery: 'next_turn',
    });
    await expect(
      session.prompt({
        sessionId: 'session-1',
        prompt: [{ type: 'text', text: 'steer the active turn' }],
      })
    ).resolves.toEqual({ stopReason: 'end_turn' });
    expect(runtime.enqueueSteering).toHaveBeenCalledWith('steer the active turn', {
      allowBeforeTurn: true,
    });
    (session as unknown as { pendingPrompt: AbortController | null }).pendingPrompt =
      null;

    await expect(
      session.prompt({
        sessionId: 'session-1',
        prompt: [{ type: 'text', text: 'x'.repeat(MAX_USER_MESSAGE_TEXT_CHARS + 1) }],
      })
    ).rejects.toThrow('ACP prompt text exceeds');
    expect(agent.chatStream).toHaveBeenCalledTimes(1);
  });
});
