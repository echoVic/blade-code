import { afterEach, describe, expect, it, vi } from 'vitest';
import { AcpServiceContext } from '../../src/acp/AcpServiceContext.js';
import { createLocalSessionWorkspace } from '../../src/agent/runtime/SessionWorkspace.js';
import { PermissionMode } from '../../src/config/types.js';
import { HookManager } from '../../src/hooks/HookManager.js';
import {
  HookEvent,
  PermissionDecision as HookPermissionDecision,
} from '../../src/hooks/types/HookTypes.js';
import { Type } from '../../src/schema/index.js';
import { createTool } from '../../src/tools/core/createTool.js';
import { ConcurrencyScheduler } from '../../src/tools/execution/ConcurrencyScheduler.js';
import { FileLockManager } from '../../src/tools/execution/FileLockManager.js';
import { ToolExecutor } from '../../src/tools/execution/ToolExecutor.js';
import { createWorkspaceToolPolicy } from '../../src/tools/execution/WorkspaceToolPolicy.js';
import { ToolRegistry } from '../../src/tools/registry/ToolRegistry.js';
import type {
  ConfirmationDetails,
  ExecutionContext,
} from '../../src/tools/types/ExecutionTypes.js';
import { type Tool, ToolErrorType, ToolKind } from '../../src/tools/types/ToolTypes.js';
import { ControlledFileClient } from '../support/acp/ControlledFileClient.js';
import {
  createPairedAcpHarness,
  type PairedAcpHarness,
} from '../support/acp/createPairedAcpHarness.js';

function createTestTool(name = 'TestTool') {
  return createTool({
    name,
    displayName: name,
    kind: ToolKind.Execute,
    description: { short: 'integration tool' },
    schema: Type.Object({ value: Type.String() }),
    async execute(params) {
      return {
        success: true,
        llmContent: `executed:${(params as { value: string }).value}`,
      };
    },
    extractSignatureContent: (params: unknown) => {
      if (typeof params === 'object' && params !== null && 'value' in params) {
        return `integration tool with value: ${(params as { value: string }).value}`;
      }
      return 'integration tool';
    },
  });
}

function createTestBashTool() {
  return createTool({
    name: 'Bash',
    displayName: 'Bash',
    kind: ToolKind.Execute,
    description: { short: 'bash tool' },
    schema: Type.Object({ command: Type.String() }),
    async execute(params) {
      return {
        success: true,
        llmContent: `executed:${(params as { command: string }).command}`,
      };
    },
    extractSignatureContent: (params: unknown) => {
      if (typeof params === 'object' && params !== null && 'command' in params) {
        return String((params as { command: string }).command);
      }
      return 'bash';
    },
  });
}

describe('ToolExecutor 权限集成', () => {
  const task7Harnesses: PairedAcpHarness[] = [];
  const task7SessionIds = new Set<string>();

  afterEach(async () => {
    for (const sessionId of task7SessionIds) {
      AcpServiceContext.destroySession(sessionId);
    }
    task7SessionIds.clear();
    await Promise.all(task7Harnesses.splice(0).map((harness) => harness.close()));
    FileLockManager.resetInstance();
    HookManager.resetInstance();
    vi.restoreAllMocks();
  });

  it('ALLOW 规则应直接执行并跳过确认', async () => {
    const registry = new ToolRegistry();
    registry.register(createTestTool() as any);

    const pipeline = new ToolExecutor(registry, {
      permissionConfig: {
        allow: ['TestTool'],
        ask: [],
        deny: [],
      },
    });

    const context: ExecutionContext = {
      signal: new AbortController().signal,
    };

    const result = await pipeline.execute('TestTool', { value: 'ok' } as any, context);

    expect(result.success).toBe(true);
    expect(String(result.llmContent)).toContain('executed:ok');
  });

  it('ASK 规则应触发确认并记住会话批准', async () => {
    const registry = new ToolRegistry();
    registry.register(createTestTool() as any);

    const pipeline = new ToolExecutor(registry, {
      permissionConfig: {
        allow: [],
        ask: ['TestTool'],
        deny: [],
      },
    });

    const confirmation = vi.fn(async () => ({
      approved: true,
      scope: 'session' as const,
    }));

    const context: ExecutionContext = {
      signal: new AbortController().signal,
      confirmationHandler: {
        requestConfirmation: confirmation,
      },
    };

    // 使用相同的参数，这样第二次调用会使用会话批准
    const first = await pipeline.execute('TestTool', { value: 'same' } as any, context);
    expect(first.success).toBe(true);
    expect(confirmation).toHaveBeenCalledTimes(1);

    const second = await pipeline.execute(
      'TestTool',
      { value: 'same' } as any,
      context
    );
    expect(second.success).toBe(true);
    expect(confirmation).toHaveBeenCalledTimes(1);
  });

  it('ASK 确认应把原因放在 message 而不是红色 risks 中', async () => {
    const registry = new ToolRegistry();
    registry.register(createTestTool() as any);

    const pipeline = new ToolExecutor(registry, {
      permissionConfig: {
        allow: [],
        ask: ['TestTool'],
        deny: [],
      },
    });

    let confirmationDetails: ConfirmationDetails | undefined;
    const confirmation = vi.fn(async (details: ConfirmationDetails) => {
      confirmationDetails = details;
      return {
        approved: true,
        scope: 'once' as const,
      };
    });

    const context: ExecutionContext = {
      signal: new AbortController().signal,
      confirmationHandler: {
        requestConfirmation: confirmation,
      },
    };

    const result = await pipeline.execute(
      'TestTool',
      { value: 'same' } as any,
      context
    );

    expect(result.success).toBe(true);
    expect(confirmation).toHaveBeenCalledTimes(1);
    expect(confirmationDetails?.message).toContain('工具调用需要用户确认');
    expect(confirmationDetails?.risks).toEqual([]);
  });

  it('低风险 Bash 确认不应把工具替代建议渲染成 risks', async () => {
    const registry = new ToolRegistry();
    registry.register(createTestBashTool() as any);

    const pipeline = new ToolExecutor(registry, {
      permissionConfig: {
        allow: [],
        ask: ['Bash(grep *)'],
        deny: [],
      },
    });

    let confirmationDetails: ConfirmationDetails | undefined;
    const confirmation = vi.fn(async (details: ConfirmationDetails) => {
      confirmationDetails = details;
      return {
        approved: true,
        scope: 'once' as const,
      };
    });

    const context: ExecutionContext = {
      signal: new AbortController().signal,
      confirmationHandler: {
        requestConfirmation: confirmation,
      },
    };

    const result = await pipeline.execute(
      'Bash',
      { command: 'grep TODO src/index.ts' } as any,
      context
    );

    expect(result.success).toBe(true);
    expect(confirmation).toHaveBeenCalledTimes(1);
    expect(confirmationDetails?.message).toContain('工具调用需要用户确认');
    expect(confirmationDetails?.risks).toEqual([]);
  });

  it('危险 Bash 命令应继续显示红色 risks', async () => {
    const registry = new ToolRegistry();
    registry.register(createTestBashTool() as any);

    const pipeline = new ToolExecutor(registry, {
      permissionConfig: {
        allow: [],
        ask: ['Bash(*)'],
        deny: [],
      },
    });

    let confirmationDetails: ConfirmationDetails | undefined;
    const confirmation = vi.fn(async (details: ConfirmationDetails) => {
      confirmationDetails = details;
      return {
        approved: true,
        scope: 'once' as const,
      };
    });

    const context: ExecutionContext = {
      signal: new AbortController().signal,
      confirmationHandler: {
        requestConfirmation: confirmation,
      },
    };

    const result = await pipeline.execute(
      'Bash',
      { command: 'sudo rm -rf /tmp/demo && git push origin main' } as any,
      context
    );

    expect(result.success).toBe(true);
    expect(confirmation).toHaveBeenCalledTimes(1);
    expect(confirmationDetails?.message).toContain('工具调用需要用户确认');
    expect(confirmationDetails?.risks).toEqual([
      '[WARN] 此命令可能删除文件',
      '[WARN] 此命令需要管理员权限',
      '[WARN] 此命令将推送代码到远程仓库',
    ]);
  });

  it('共享审批状态时应跨 turn 的 executor 复用 session 批准', async () => {
    const registry = new ToolRegistry();
    registry.register(createTestTool() as any);

    const approvals = new Set<string>();
    const approvalStore = {
      has: vi.fn((signature: string) => approvals.has(signature)),
      add: vi.fn((signature: string) => {
        approvals.add(signature);
      }),
      clear: vi.fn(() => {
        approvals.clear();
      }),
    };

    const firstPipeline = new ToolExecutor(registry, {
      permissionConfig: {
        allow: [],
        ask: ['TestTool'],
        deny: [],
      },
      approvalStore,
    });

    const secondPipeline = new ToolExecutor(registry, {
      permissionConfig: {
        allow: [],
        ask: ['TestTool'],
        deny: [],
      },
      approvalStore,
    });

    const confirmation = vi.fn(async () => ({
      approved: true,
      scope: 'session' as const,
    }));

    const context: ExecutionContext = {
      signal: new AbortController().signal,
      confirmationHandler: {
        requestConfirmation: confirmation,
      },
    };

    const first = await firstPipeline.execute(
      'TestTool',
      { value: 'same' } as any,
      context
    );
    const second = await secondPipeline.execute(
      'TestTool',
      { value: 'same' } as any,
      context
    );

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(approvalStore.has).toHaveBeenCalled();
    expect(approvalStore.add).toHaveBeenCalledTimes(1);
    expect(confirmation).toHaveBeenCalledTimes(1);
  });

  it('ASK 确认被拒绝时应返回人类可读的取消回执', async () => {
    const registry = new ToolRegistry();
    registry.register(createTestTool() as any);

    const pipeline = new ToolExecutor(registry, {
      permissionConfig: {
        allow: [],
        ask: ['TestTool'],
        deny: [],
      },
    });

    const confirmation = vi.fn(async () => ({
      approved: false,
      reason: '用户拒绝授权',
    }));

    const context: ExecutionContext = {
      signal: new AbortController().signal,
      confirmationHandler: {
        requestConfirmation: confirmation,
      },
    };

    const result = await pipeline.execute(
      'TestTool',
      { value: 'same' } as any,
      context
    );

    expect(result.success).toBe(false);
    expect(result.metadata?.shouldExitLoop).toBe(true);
    expect(String(result.llmContent)).toBe('已取消工具执行');
    expect(result.metadata?.summary).toBe('已取消工具执行');
    expect(result.error?.message).toBe('用户拒绝授权');
  });

  it('已中止 signal 在执行前应标记 abortedBeforeLaunch', async () => {
    const registry = new ToolRegistry();
    registry.register(createTestTool() as any);

    const pipeline = new ToolExecutor(registry, {
      permissionConfig: {
        allow: ['TestTool'],
        ask: [],
        deny: [],
      },
    });

    const controller = new AbortController();
    controller.abort('user-cancel');

    const context: ExecutionContext = {
      signal: controller.signal,
    };

    const result = await pipeline.execute(
      'TestTool',
      { value: 'same' } as any,
      context
    );

    expect(result.success).toBe(false);
    expect(result.metadata?.shouldExitLoop).toBe(true);
    expect(result.metadata?.abortedBeforeLaunch).toBe(true);
    expect(result.error?.message).toBe('任务已被用户中止');
  });

  it('DENY 规则应直接拒绝执行', async () => {
    const registry = new ToolRegistry();
    registry.register(createTestTool() as any);

    const pipeline = new ToolExecutor(registry, {
      permissionConfig: {
        allow: [],
        ask: [],
        deny: ['TestTool'],
      },
    });

    const context: ExecutionContext = {
      signal: new AbortController().signal,
    };

    const result = await pipeline.execute(
      'TestTool',
      { value: 'nope' } as any,
      context
    );

    expect(result.success).toBe(false);
    expect(String(result.llmContent)).toContain('工具调用被拒绝规则阻止');
  });

  it('Hook 修改输入后应重新执行权限检查', async () => {
    const hookManager = HookManager.getInstance();
    hookManager.loadConfig({ enabled: true });
    const unregister = hookManager.registerFunction(
      HookEvent.PreToolUse,
      { tools: 'Bash' },
      async () => ({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: HookPermissionDecision.Allow,
          updatedInput: { command: 'rm -rf /tmp/blocked-by-policy' },
        },
      })
    );

    try {
      const registry = new ToolRegistry();
      registry.register(createTestBashTool() as any);
      const executor = new ToolExecutor(registry, {
        permissionConfig: {
          allow: ['Bash(echo *)'],
          ask: [],
          deny: ['Bash(rm *)'],
        },
      });

      const result = await executor.execute(
        'Bash',
        { command: 'echo safe' },
        { signal: new AbortController().signal }
      );

      expect(result.success).toBe(false);
      expect(result.error?.type).toBe('permission_denied');
      expect(String(result.llmContent)).toContain('工具调用被拒绝规则阻止');
    } finally {
      unregister();
      hookManager.loadConfig({ enabled: false });
    }
  });

  it('可信 local executor 不允许 caller 伪造 remote kind 跳过 deny hook', async () => {
    const projectDir = '/private/trusted-local-project';
    const hookManager = HookManager.getInstance();
    hookManager.loadConfig({ enabled: true }, projectDir);
    const hookSpy = vi.fn(async () => ({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse' as const,
        permissionDecision: HookPermissionDecision.Deny,
        permissionDecisionReason: 'blocked by trusted local hook',
      },
    }));
    const unregister = hookManager.registerFunction(
      HookEvent.PreToolUse,
      { tools: 'TestTool' },
      hookSpy,
      { projectDir }
    );
    const invocationSpy = vi.fn();
    const tool = createTool({
      name: 'TestTool',
      displayName: 'TestTool',
      kind: ToolKind.Execute,
      description: { short: 'trusted local authority probe' },
      schema: Type.Object({ value: Type.String() }),
      async execute() {
        invocationSpy();
        return { success: true, llmContent: 'local invocation ran' };
      },
    });
    const registry = new ToolRegistry();
    registry.register(tool as unknown as Tool);
    const executor = new ToolExecutor(registry, {
      permissionMode: PermissionMode.YOLO,
      workspaceToolPolicy: createWorkspaceToolPolicy(
        createLocalSessionWorkspace(projectDir)
      ),
      contextDefaults: {
        sessionId: 'trusted-local-session',
        workspaceKind: 'local',
        workspaceRoot: projectDir,
        executionRoot: projectDir,
      },
    });

    try {
      const result = await executor.execute(
        'TestTool',
        { value: 'blocked' },
        {
          workspaceKind: 'acp-remote',
          workspaceRoot: projectDir,
          executionRoot: 'C:\\forged-remote',
        }
      );

      expect(hookSpy).toHaveBeenCalledTimes(1);
      expect(invocationSpy).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        success: false,
        error: {
          type: ToolErrorType.PERMISSION_DENIED,
          message: 'blocked by trusted local hook',
        },
      });
    } finally {
      unregister();
      hookManager.loadConfig({ enabled: false }, projectDir);
    }
  });

  it('远端执行应忽略真实 PreToolUse hook 并保持 runtime-owned 路由', async () => {
    const sessionId = 'remote-post-hook-path-validation';
    const root = 'C:\\workspace';
    const rejectedPath = 'C:\\workspace\\secret.txt:$DATA';
    const projectDir = '/private/remote-state';
    const client = new ControlledFileClient();
    const harness = createPairedAcpHarness(client);
    task7Harnesses.push(harness);
    task7SessionIds.add(sessionId);
    AcpServiceContext.initializeSession(
      harness.agentConnection,
      sessionId,
      { fs: { readTextFile: true, writeTextFile: true } },
      root
    );

    const invocationSpy = vi.fn();
    const tool = createTool({
      name: 'Write',
      displayName: 'Write',
      kind: ToolKind.Write,
      isConcurrencySafe: false,
      parallelism: 'shared',
      schema: Type.Object({
        file_path: Type.String(),
        content: Type.String(),
      }),
      description: { short: 'typed remote hook validation probe' },
      affectedPaths: (params) => [params.file_path],
      async execute() {
        invocationSpy();
        return { success: true, llmContent: 'remote invocation ran' };
      },
    });
    const registry = new ToolRegistry();
    registry.register(tool as Tool);

    const hookManager = HookManager.getInstance();
    hookManager.loadConfig({ enabled: true }, projectDir);
    const hookSpy = vi.fn(async () => ({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse' as const,
        permissionDecision: HookPermissionDecision.Allow,
        updatedInput: { file_path: rejectedPath },
      },
    }));
    hookManager.registerFunction(HookEvent.PreToolUse, { tools: 'Write' }, hookSpy, {
      projectDir,
    });

    const scheduler = new ConcurrencyScheduler();
    const scheduleSpy = vi.spyOn(scheduler, 'schedule');
    const hostLockSpy = vi.spyOn(FileLockManager.prototype, 'acquireLock');
    const opaqueLockSpy = vi.spyOn(FileLockManager.prototype, 'acquireOpaqueLock');
    const executor = new ToolExecutor(registry, {
      permissionMode: PermissionMode.YOLO,
      scheduler,
      workspaceToolPolicy: {
        kind: 'acp-remote',
        readTextFile: true,
        writeTextFile: true,
        terminal: false,
        pathStyle: 'win32',
      },
      contextDefaults: {
        sessionId,
        workspaceKind: 'acp-remote',
        workspaceRoot: projectDir,
        executionRoot: root,
      },
    });

    const result = await executor.execute(
      'Write',
      { file_path: 'C:\\workspace\\safe.txt', content: 'safe' },
      {
        sessionId,
        workspaceKind: 'local',
        workspaceRoot: '/tmp/caller-workspace',
        worktreeActive: true,
      }
    );

    expect(hookSpy).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: true,
      llmContent: 'remote invocation ran',
    });
    expect(String(result.llmContent)).not.toContain(rejectedPath);
    expect(scheduleSpy).toHaveBeenCalledTimes(1);
    expect(hostLockSpy).not.toHaveBeenCalled();
    expect(opaqueLockSpy).toHaveBeenCalledTimes(1);
    expect(invocationSpy).toHaveBeenCalledTimes(1);
    expect(client.requests).toEqual([]);

    hostLockSpy.mockRestore();
    opaqueLockSpy.mockRestore();
  });

  it('排队期间取消时不应启动工具', async () => {
    let releaseFirst: (() => void) | undefined;
    let markFirstStarted: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const execute = vi.fn(async () => {
      markFirstStarted?.();
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      return { success: true, llmContent: 'done' };
    });
    const tool = createTool({
      name: 'QueuedTool',
      displayName: 'QueuedTool',
      kind: ToolKind.Execute,
      description: { short: 'queued tool' },
      schema: Type.Object({}),
      execute,
    });
    const registry = new ToolRegistry();
    registry.register(tool as unknown as Tool);
    const executor = new ToolExecutor(registry, {
      permissionMode: PermissionMode.YOLO,
      concurrencyLimits: { execute: 1 },
    });

    const first = executor.execute('QueuedTool', {}, {});
    await firstStarted;

    const controller = new AbortController();
    const second = executor.execute(
      'QueuedTool',
      {},
      {
        signal: controller.signal,
      }
    );
    controller.abort();
    releaseFirst?.();

    const [, secondResult] = await Promise.all([first, second]);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(secondResult.success).toBe(false);
    expect(secondResult.metadata?.abortedBeforeLaunch).toBe(true);
  });
});
