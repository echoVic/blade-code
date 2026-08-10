import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubagentContext } from '../../../../src/agent/subagents/types.js';
import { PermissionMode } from '../../../../src/config/types.js';

const executionState = vi.hoisted(() => ({
  contexts: [] as SubagentContext[],
  resources: [] as unknown[],
  modelResources: [] as unknown[],
  lspResources: [] as unknown[],
}));

vi.mock('../../../../src/agent/subagents/SubagentExecutor.js', () => ({
  SubagentExecutor: class MockSubagentExecutor {
    constructor(
      _config: unknown,
      resources?: unknown,
      modelResources?: unknown,
      lspResources?: unknown
    ) {
      executionState.resources.push(resources);
      executionState.modelResources.push(modelResources);
      executionState.lspResources.push(lspResources);
    }

    execute = vi.fn(async (context: SubagentContext) => {
      executionState.contexts.push(context);
      const messages = [
        ...(context.existingMessages ?? []),
        { role: 'user' as const, content: context.prompt },
        {
          role: 'assistant' as const,
          content: `result:${context.prompt}`,
        },
      ];
      return {
        success: true,
        message: `result:${context.prompt}`,
        agentId: context.subagentSessionId,
        messages,
        stats: { tokens: 10, toolCalls: 0, duration: 1 },
      };
    });
  },
}));

vi.mock('../../../../src/agent/subagents/SubagentWorktreeLifecycle.js', () => ({
  subagentWorktreeLifecycle: {
    prepare: vi.fn(async (input: { agentId: string; sourceWorkspaceRoot: string }) => ({
      isolation: 'none',
      workspaceRoot: input.sourceWorkspaceRoot,
      ownerAgentId: input.agentId,
    })),
    finalize: vi.fn(async () => ({
      preserved: false,
      removed: false,
    })),
  },
}));

vi.mock('../../../../src/hooks/HookManager.js', () => ({
  HookManager: {
    getInstance: () => ({
      executeSubagentStopHooks: vi.fn(async () => ({ shouldStop: true })),
    }),
  },
}));

vi.mock('../../../../src/server/bus.js', () => ({
  Bus: { publish: vi.fn() },
}));

vi.mock('../../../../src/store/vanilla.js', () => ({
  vanillaStore: {
    getState: () => ({
      app: {
        actions: {
          startSubagentProgress: vi.fn(),
          updateSubagentTool: vi.fn(),
          completeSubagentProgress: vi.fn(),
        },
      },
    }),
  },
}));

describe('Task durable subagent resume protocol', () => {
  let storageRoot: string;
  let previousStorageRoot: string | undefined;
  const workspaceA = '/tmp/task-resume-workspace-a';
  const workspaceB = '/tmp/task-resume-workspace-b';

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    executionState.contexts.length = 0;
    executionState.resources.length = 0;
    executionState.modelResources.length = 0;
    executionState.lspResources.length = 0;
    previousStorageRoot = process.env.BLADE_STORAGE_ROOT;
    storageRoot = mkdtempSync(path.join(os.tmpdir(), 'blade-task-resume-'));
    process.env.BLADE_STORAGE_ROOT = storageRoot;
    const { subagentRegistry } = await import(
      '../../../../src/agent/subagents/SubagentRegistry.js'
    );
    subagentRegistry.clear();
    subagentRegistry.register({
      name: 'durable-reviewer',
      description: 'Durable reviewer',
      tools: ['Read'],
      model: 'inherit',
    });
    subagentRegistry.register({
      name: 'other-reviewer',
      description: 'Conflicting reviewer',
    });
  });

  afterEach(async () => {
    const { AgentSessionStore } = await import(
      '../../../../src/agent/subagents/AgentSessionStore.js'
    );
    const { BackgroundAgentManager } = await import(
      '../../../../src/agent/subagents/BackgroundAgentManager.js'
    );
    (
      AgentSessionStore as unknown as {
        instance: unknown;
      }
    ).instance = null;
    (
      BackgroundAgentManager as unknown as {
        instance: unknown;
      }
    ).instance = null;
    if (previousStorageRoot === undefined) {
      delete process.env.BLADE_STORAGE_ROOT;
    } else {
      process.env.BLADE_STORAGE_ROOT = previousStorageRoot;
    }
    rmSync(storageRoot, { recursive: true, force: true });
  });

  async function taskTool() {
    return (await import('../../../../src/tools/builtin/task/task.js')).taskTool;
  }

  async function resetProcessState() {
    const { AgentSessionStore } = await import(
      '../../../../src/agent/subagents/AgentSessionStore.js'
    );
    const { BackgroundAgentManager } = await import(
      '../../../../src/agent/subagents/BackgroundAgentManager.js'
    );
    (
      AgentSessionStore as unknown as {
        instance: unknown;
      }
    ).instance = null;
    (
      BackgroundAgentManager as unknown as {
        instance: unknown;
      }
    ).instance = null;
  }

  it('allows independent durable child sessions to share batch execution', async () => {
    const tool = await taskTool();
    expect(tool.isConcurrencySafe).toBe(false);
    expect(tool.parallelism).toBe('shared');
  });

  it('passes the parent Session resources to foreground subagents', async () => {
    const { createTaskTool } = await import(
      '../../../../src/tools/builtin/task/task.js'
    );
    const { subagentRegistry } = await import(
      '../../../../src/agent/subagents/SubagentRegistry.js'
    );
    const agentResources = {
      projectRoot: workspaceA,
      subagents: subagentRegistry,
      skills: {},
      commands: {},
    } as never;
    const modelResources = {
      projectRoot: workspaceA,
      config: {},
      catalog: {},
    } as never;
    const lspResources = {
      projectRoot: workspaceA,
      servers: { typescript: { command: 'server' } },
    } as never;
    const tool = createTaskTool(
      subagentRegistry,
      agentResources,
      modelResources,
      lspResources,
      () => 'high',
      () => 'fast',
      () => 'high',
      () => 'explanatory'
    );

    await tool
      .build({
        subagent_type: 'durable-reviewer',
        description: 'Inspect resources',
        prompt: 'Inspect the inherited project resource snapshot.',
        run_in_background: false,
        subagent_session_id: 'agent-resource-child',
      })
      .execute(new AbortController().signal, undefined, {
        sessionId: 'parent-session',
        workspaceRoot: workspaceA,
      });

    expect(executionState.resources).toEqual([agentResources]);
    expect(executionState.modelResources).toEqual([modelResources]);
    expect(executionState.lspResources).toEqual([lspResources]);
    expect(executionState.contexts[0]?.reasoningEffort).toBe('high');
    expect(executionState.contexts[0]?.serviceTier).toBe('fast');
    expect(executionState.contexts[0]?.responseVerbosity).toBe('high');
    expect(executionState.contexts[0]?.communicationStyle).toBe('explanatory');
  });

  it('persists a foreground root run and resumes it after process reconstruction', async () => {
    const tool = await taskTool();
    const root = await tool
      .build({
        subagent_type: 'durable-reviewer',
        description: 'Inspect implementation',
        prompt: 'Inspect the implementation and remember ALPHA.',
        run_in_background: false,
        subagent_session_id: 'agent-root',
      })
      .execute(new AbortController().signal, undefined, {
        sessionId: 'parent-session',
        workspaceRoot: workspaceA,
        modelId: 'parent-model',
        permissionMode: PermissionMode.YOLO,
      });

    expect(root.success).toBe(true);
    expect(root.metadata).toMatchObject({
      subagentSessionId: 'agent-root',
      subagentRootId: 'agent-root',
      subagentResumeDepth: 0,
      resume_from_hint: 'agent-root',
    });
    const { AgentSessionStore } = await import(
      '../../../../src/agent/subagents/AgentSessionStore.js'
    );
    expect(AgentSessionStore.getInstance().loadSession('agent-root')).toMatchObject({
      status: 'completed',
      rootAgentId: 'agent-root',
      resumeDepth: 0,
      parentSessionId: 'parent-session',
      parentProjectPath: workspaceA,
      configSnapshot: {
        name: 'durable-reviewer',
        model: 'parent-model',
        permissionMode: PermissionMode.YOLO,
      },
      messages: [
        {
          role: 'user',
          content: 'Inspect the implementation and remember ALPHA.',
        },
        {
          role: 'assistant',
          content: 'result:Inspect the implementation and remember ALPHA.',
        },
      ],
    });

    await resetProcessState();
    const child = await (await taskTool())
      .build({
        description: 'Check follow-up',
        prompt: 'What token did you remember?',
        run_in_background: false,
        resume_from: 'agent-root',
        subagent_session_id: 'agent-child',
      })
      .execute(new AbortController().signal, undefined, {
        sessionId: 'parent-session',
        workspaceRoot: workspaceA,
        modelId: 'different-parent-model',
        permissionMode: PermissionMode.DEFAULT,
      });

    expect(child.success).toBe(true);
    expect(child.metadata).toMatchObject({
      subagentSessionId: 'agent-child',
      subagentResumedFrom: 'agent-root',
      subagentRootId: 'agent-root',
      subagentResumeDepth: 1,
      resume_from_hint: 'agent-child',
    });
    expect(executionState.contexts.at(-1)?.existingMessages).toEqual([
      {
        role: 'user',
        content: 'Inspect the implementation and remember ALPHA.',
      },
      {
        role: 'assistant',
        content: 'result:Inspect the implementation and remember ALPHA.',
      },
    ]);
    const storeAfterRestart = AgentSessionStore.getInstance();
    const sourceAfterResume = storeAfterRestart.loadSession('agent-root');
    expect(sourceAfterResume).toMatchObject({
      status: 'completed',
      resumeDepth: 0,
    });
    expect(sourceAfterResume).not.toHaveProperty('resumedFrom');
    expect(storeAfterRestart.loadSession('agent-child')).toMatchObject({
      status: 'completed',
      resumedFrom: 'agent-root',
      rootAgentId: 'agent-root',
      resumeDepth: 1,
      configSnapshot: {
        model: 'parent-model',
        permissionMode: PermissionMode.YOLO,
      },
    });
  });

  it('creates a new immutable run for every resume edge', async () => {
    const tool = await taskTool();
    for (const request of [
      {
        id: 'agent-root',
        params: {
          subagent_type: 'durable-reviewer',
          description: 'Root review',
          prompt: 'Remember the root state.',
        },
      },
      {
        id: 'agent-child',
        params: {
          description: 'Child review',
          prompt: 'Continue from root.',
          resume_from: 'agent-root',
        },
      },
      {
        id: 'agent-grandchild',
        params: {
          description: 'Grandchild review',
          prompt: 'Continue from child.',
          resume_from: 'agent-child',
        },
      },
    ]) {
      const result = await tool
        .build({
          ...request.params,
          run_in_background: false,
          subagent_session_id: request.id,
        })
        .execute(new AbortController().signal, undefined, {
          sessionId: 'parent-session',
          workspaceRoot: workspaceA,
          modelId: 'parent-model',
          permissionMode: PermissionMode.YOLO,
        });
      expect(result.success).toBe(true);
    }

    const { AgentSessionStore } = await import(
      '../../../../src/agent/subagents/AgentSessionStore.js'
    );
    const store = AgentSessionStore.getInstance();
    expect(store.loadSession('agent-root')).toMatchObject({
      rootAgentId: 'agent-root',
      resumeDepth: 0,
    });
    expect(store.loadSession('agent-child')).toMatchObject({
      resumedFrom: 'agent-root',
      rootAgentId: 'agent-root',
      resumeDepth: 1,
    });
    expect(store.loadSession('agent-grandchild')).toMatchObject({
      resumedFrom: 'agent-child',
      rootAgentId: 'agent-root',
      resumeDepth: 2,
    });
  });

  it('fails closed for cross-workspace ownership and conflicting identity', async () => {
    const tool = await taskTool();
    await tool
      .build({
        subagent_type: 'durable-reviewer',
        description: 'Root review',
        prompt: 'Create a durable root run.',
        run_in_background: false,
        subagent_session_id: 'agent-private',
      })
      .execute(new AbortController().signal, undefined, {
        sessionId: 'shared-parent',
        workspaceRoot: workspaceA,
        modelId: 'parent-model',
      });

    const crossWorkspace = await tool
      .build({
        description: 'Unauthorized resume',
        prompt: 'Try to cross the workspace boundary.',
        resume_from: 'agent-private',
        run_in_background: false,
      })
      .execute(new AbortController().signal, undefined, {
        sessionId: 'shared-parent',
        workspaceRoot: workspaceB,
      });
    expect(crossWorkspace.success).toBe(false);
    expect(crossWorkspace.error?.message).toContain(
      'session not found in this workspace'
    );

    const wrongType = await tool
      .build({
        subagent_type: 'other-reviewer',
        description: 'Conflicting resume',
        prompt: 'Try to change the child identity.',
        resume_from: 'agent-private',
        run_in_background: false,
      })
      .execute(new AbortController().signal, undefined, {
        sessionId: 'shared-parent',
        workspaceRoot: workspaceA,
      });
    expect(wrongType.success).toBe(false);
    expect(wrongType.error?.message).toContain('source agent used "durable-reviewer"');
  });
});
