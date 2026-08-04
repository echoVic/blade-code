/**
 * slashCommandRouter — processSlashCommand 单元测试
 *
 * 覆盖 plan.md 中的 4 个中优先级 slash 命令语义场景：
 * 1. /custom-cmd args — UI 显示原始命令，Agent 收到展开后的 prompt
 * 2. /plugin:cmd args — UI 显示原始命令，Agent 收到展开后的 prompt
 * 3. /skill-name args — UI 显示和 Agent 输入都是改写后的 skill prompt
 * 4. invoke_once_model — 正确传递 onceModelId
 *
 * 同时覆盖：
 * - 非 slash 命令直接返回 not_slash
 * - UI 消息路由（show_model_selector 等）
 * - 错误处理
 * - 类型守卫函数
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  processSlashCommand,
  isInvokeSkillAction,
  isInvokeCustomCommandAction,
  isInvokePluginCommandAction,
  isInvokeOnceModelAction,
  type SlashRouteResult,
} from '../../../../../src/ui/utils/slashCommandRouter.js';
import type { ResolvedInput } from '../../../../../src/ui/hooks/useInputBuffer.js';

// Mock slash-commands 模块
vi.mock('../../../../../src/slash-commands/index.js', () => ({
  isSlashCommand: vi.fn((input: string) => input.trim().startsWith('/')),
  executeSlashCommand: vi.fn(),
}));

// Mock GracefulShutdown
vi.mock('../../../../../src/services/GracefulShutdown.js', () => ({
  safeExit: vi.fn(),
}));

// ==================== 测试工具 ====================

function createResolvedInput(text: string): ResolvedInput {
  return {
    displayText: text,
    text,
    images: [],
    parts: [{ type: 'text', text }],
  };
}

function createMockAppActions() {
  return {
    setActiveModal: vi.fn(),
    showSessionSelector: vi.fn(),
    setTasks: vi.fn(),
  } as any;
}

function createMockSessionActions() {
  return {
    addUserMessage: vi.fn(),
    addAssistantMessage: vi.fn(),
    clearMessages: vi.fn(),
    setError: vi.fn(),
    resetTokenUsage: vi.fn(),
    restoreSession: vi.fn(),
  } as any;
}

// ==================== 测试 ====================

describe('processSlashCommand', () => {
  let executeSlashCommand: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const slashModule = await import('../../../../../src/slash-commands/index.js');
    executeSlashCommand = vi.mocked(slashModule.executeSlashCommand);
    executeSlashCommand.mockReset();
  });

  // ==================== 非 slash 命令 ====================

  describe('非 slash 命令', () => {
    it('非 / 开头的输入应该返回 not_slash', async () => {
      const result = await processSlashCommand(
        createResolvedInput('hello world'),
        createMockAppActions(),
        createMockSessionActions(),
        new AbortController().signal
      );

      expect(result.type).toBe('not_slash');
    });
  });

  describe('session context', () => {
    it('应将当前 session ID 传给 slash command handler', async () => {
      executeSlashCommand.mockResolvedValue({ success: true });

      await processSlashCommand(
        createResolvedInput('/tasks'),
        createMockAppActions(),
        createMockSessionActions(),
        new AbortController().signal,
        'session-owner'
      );

      expect(executeSlashCommand).toHaveBeenCalledWith(
        '/tasks',
        expect.objectContaining({ sessionId: 'session-owner' })
      );
    });
  });

  // ==================== 场景 1: invoke_custom_command ====================

  describe('/custom-cmd — UI 显示原始命令，Agent 收到展开后的 prompt', () => {
    it('应该分离 UI 显示和 Agent 输入', async () => {
      executeSlashCommand.mockResolvedValue({
        success: true,
        data: {
          action: 'invoke_custom_command',
          commandName: 'deploy',
          processedContent: 'Run the deployment pipeline with staging config',
          config: {},
        },
      });

      const sessionActions = createMockSessionActions();
      const result = await processSlashCommand(
        createResolvedInput('/deploy staging'),
        createMockAppActions(),
        sessionActions,
        new AbortController().signal
      );

      expect(result.type).toBe('continue_as_agent');
      if (result.type !== 'continue_as_agent') return;

      // UI 显示原始命令
      expect(sessionActions.addUserMessage).toHaveBeenCalledWith('/deploy staging');
      expect(result.result.userDisplayMessage).toBe('/deploy staging');
      expect(result.result.userMessageAlreadyAdded).toBe(true);

      // Agent 收到展开后的 prompt（不同于 UI 显示）
      expect(result.result.agentInput.text).toContain('Custom Command: /deploy');
      expect(result.result.agentInput.text).toContain('Run the deployment pipeline');
      expect(result.result.agentInput.text).not.toBe('/deploy staging');
    });
  });

  // ==================== 场景 2: invoke_plugin_command ====================

  describe('/plugin:cmd — UI 显示原始命令，Agent 收到展开后的 prompt', () => {
    it('应该分离 UI 显示和 Agent 输入', async () => {
      executeSlashCommand.mockResolvedValue({
        success: true,
        data: {
          action: 'invoke_plugin_command',
          commandName: 'lint',
          pluginName: 'code-quality',
          processedContent: 'Run ESLint on all TypeScript files',
          config: {},
        },
      });

      const sessionActions = createMockSessionActions();
      const result = await processSlashCommand(
        createResolvedInput('/lint src/'),
        createMockAppActions(),
        sessionActions,
        new AbortController().signal
      );

      expect(result.type).toBe('continue_as_agent');
      if (result.type !== 'continue_as_agent') return;

      // UI 显示原始命令
      expect(sessionActions.addUserMessage).toHaveBeenCalledWith('/lint src/');
      expect(result.result.userDisplayMessage).toBe('/lint src/');

      // Agent 收到展开后的 prompt
      expect(result.result.agentInput.text).toContain('Plugin Command: /lint');
      expect(result.result.agentInput.text).toContain('plugin "code-quality"');
      expect(result.result.agentInput.text).toContain(
        'Run ESLint on all TypeScript files'
      );
    });
  });

  // ==================== 场景 3: invoke_skill ====================

  describe('/skill-name — UI 和 Agent 都是改写后的 skill prompt', () => {
    it('有参数时应该生成带参数的 skill prompt', async () => {
      executeSlashCommand.mockResolvedValue({
        success: true,
        data: {
          action: 'invoke_skill',
          skillName: 'code-review',
          skillArgs: 'review the last commit',
        },
      });

      const sessionActions = createMockSessionActions();
      const result = await processSlashCommand(
        createResolvedInput('/code-review review the last commit'),
        createMockAppActions(),
        sessionActions,
        new AbortController().signal
      );

      expect(result.type).toBe('continue_as_agent');
      if (result.type !== 'continue_as_agent') return;

      // UI 显示和 Agent 输入都是改写后的 skill prompt
      const expectedPrompt =
        'Please use the "code-review" skill to help me with: review the last commit';
      expect(result.result.userDisplayMessage).toBe(expectedPrompt);
      expect(result.result.agentInput.text).toBe(expectedPrompt);
      expect(sessionActions.addUserMessage).toHaveBeenCalledWith(expectedPrompt);
      expect(result.result.userMessageAlreadyAdded).toBe(true);
    });

    it('无参数时应该生成简短 skill prompt', async () => {
      executeSlashCommand.mockResolvedValue({
        success: true,
        data: {
          action: 'invoke_skill',
          skillName: 'tdd',
        },
      });

      const sessionActions = createMockSessionActions();
      const result = await processSlashCommand(
        createResolvedInput('/tdd'),
        createMockAppActions(),
        sessionActions,
        new AbortController().signal
      );

      expect(result.type).toBe('continue_as_agent');
      if (result.type !== 'continue_as_agent') return;

      expect(result.result.userDisplayMessage).toBe('Please use the "tdd" skill.');
      expect(result.result.agentInput.text).toBe('Please use the "tdd" skill.');
    });
  });

  // ==================== 场景 4: invoke_once_model ====================

  describe('invoke_once_model — 正确传递 onceModelId', () => {
    it('应该设置 onceModelId', async () => {
      executeSlashCommand.mockResolvedValue({
        success: true,
        data: {
          action: 'invoke_once_model',
          modelId: 'gpt-4o',
          prompt: 'explain this code',
        },
      });

      const sessionActions = createMockSessionActions();
      const result = await processSlashCommand(
        createResolvedInput('/model gpt-4o explain this code'),
        createMockAppActions(),
        sessionActions,
        new AbortController().signal
      );

      expect(result.type).toBe('continue_as_agent');
      if (result.type !== 'continue_as_agent') return;

      expect(result.result.onceModelId).toBe('gpt-4o');
      expect(result.result.agentInput.text).toBe('explain this code');
      expect(sessionActions.addUserMessage).toHaveBeenCalledWith('explain this code');
    });
  });

  describe('goal continuation', () => {
    it('starts a transient Agent continuation while displaying the slash command', async () => {
      executeSlashCommand.mockResolvedValue({
        success: true,
        data: {
          action: 'start_goal',
          goal: { objective: 'finish the migration' },
        },
      });
      const sessionActions = createMockSessionActions();

      const result = await processSlashCommand(
        createResolvedInput('/goal finish the migration'),
        createMockAppActions(),
        sessionActions,
        new AbortController().signal
      );

      expect(result.type).toBe('continue_as_agent');
      if (result.type !== 'continue_as_agent') return;
      expect(result.result.goalContinuationOnly).toBe(true);
      expect(result.result.agentInput.text).toBe('finish the migration');
      expect(sessionActions.addUserMessage).toHaveBeenCalledWith(
        '/goal finish the migration'
      );
    });
  });

  // ==================== UI 消息路由 ====================

  describe('UI 消息路由', () => {
    it('session_forked 应该原子切换到子会话', async () => {
      const rawMessages = [{ id: 'raw-1', role: 'user', content: 'context' }];
      const visibleMessages = [
        { id: 'visible-1', role: 'user', content: 'context', timestamp: 1 },
      ];
      executeSlashCommand.mockResolvedValue({
        success: true,
        message: 'session_forked',
        data: {
          action: 'restore_forked_session',
          sessionId: 'child-session',
          messages: rawMessages,
          visibleMessages,
        },
      });

      const sessionActions = createMockSessionActions();
      const result = await processSlashCommand(
        createResolvedInput('/branch'),
        createMockAppActions(),
        sessionActions,
        new AbortController().signal,
        'parent-session'
      );

      expect(result.type).toBe('handled');
      expect(sessionActions.restoreSession).toHaveBeenCalledWith(
        'child-session',
        visibleMessages,
        rawMessages
      );
    });

    it('show_model_selector 应该返回 handled', async () => {
      executeSlashCommand.mockResolvedValue({
        success: true,
        message: 'show_model_selector',
      });

      const appActions = createMockAppActions();
      const result = await processSlashCommand(
        createResolvedInput('/model'),
        appActions,
        createMockSessionActions(),
        new AbortController().signal
      );

      expect(result.type).toBe('handled');
      expect(appActions.setActiveModal).toHaveBeenCalledWith('modelSelector');
    });

    it('clear_screen 应该清空消息和重置状态', async () => {
      executeSlashCommand.mockResolvedValue({
        success: true,
        message: 'clear_screen',
      });

      const sessionActions = createMockSessionActions();
      const appActions = createMockAppActions();
      const result = await processSlashCommand(
        createResolvedInput('/clear'),
        appActions,
        sessionActions,
        new AbortController().signal
      );

      expect(result.type).toBe('handled');
      expect(sessionActions.clearMessages).toHaveBeenCalled();
      expect(sessionActions.setError).toHaveBeenCalledWith(null);
      expect(sessionActions.resetTokenUsage).toHaveBeenCalled();
      expect(appActions.setTasks).toHaveBeenCalledWith([]);
    });
  });

  // ==================== 错误处理 ====================

  describe('错误处理', () => {
    it('slash command 失败时应该显示错误消息', async () => {
      executeSlashCommand.mockResolvedValue({
        success: false,
        error: 'Unknown command: /foobar',
      });

      const sessionActions = createMockSessionActions();
      const result = await processSlashCommand(
        createResolvedInput('/foobar'),
        createMockAppActions(),
        sessionActions,
        new AbortController().signal
      );

      expect(result.type).toBe('handled');
      if (result.type !== 'handled') return;
      expect(result.commandResult.success).toBe(false);
      expect(sessionActions.addAssistantMessage).toHaveBeenCalledWith(
        'Unknown command: /foobar'
      );
    });

    it('成功的 slash command 有 message 时应该显示', async () => {
      executeSlashCommand.mockResolvedValue({
        success: true,
        message: 'Help content displayed',
      });

      const sessionActions = createMockSessionActions();
      const result = await processSlashCommand(
        createResolvedInput('/help'),
        createMockAppActions(),
        sessionActions,
        new AbortController().signal
      );

      expect(result.type).toBe('handled');
      expect(sessionActions.addAssistantMessage).toHaveBeenCalledWith(
        'Help content displayed'
      );
    });
  });
});

// ==================== 类型守卫测试 ====================

describe('类型守卫函数', () => {
  describe('isInvokeSkillAction', () => {
    it('有效的 invoke_skill 数据应该返回 true', () => {
      expect(
        isInvokeSkillAction({
          action: 'invoke_skill',
          skillName: 'tdd',
          skillArgs: 'arg',
        })
      ).toBe(true);
    });

    it('null 应该返回 false', () => {
      expect(isInvokeSkillAction(null)).toBe(false);
    });

    it('缺少 skillName 应该返回 false', () => {
      expect(isInvokeSkillAction({ action: 'invoke_skill' })).toBe(false);
    });
  });

  describe('isInvokeCustomCommandAction', () => {
    it('有效数据应该返回 true', () => {
      expect(
        isInvokeCustomCommandAction({
          action: 'invoke_custom_command',
          commandName: 'deploy',
          processedContent: 'content',
          config: {},
        })
      ).toBe(true);
    });

    it('缺少 processedContent 应该返回 false', () => {
      expect(
        isInvokeCustomCommandAction({
          action: 'invoke_custom_command',
          commandName: 'deploy',
        })
      ).toBe(false);
    });
  });

  describe('isInvokePluginCommandAction', () => {
    it('有效数据应该返回 true', () => {
      expect(
        isInvokePluginCommandAction({
          action: 'invoke_plugin_command',
          commandName: 'lint',
          processedContent: 'content',
          config: {},
        })
      ).toBe(true);
    });

    it('action 不匹配应该返回 false', () => {
      expect(
        isInvokePluginCommandAction({
          action: 'invoke_skill',
          commandName: 'lint',
          processedContent: 'content',
        })
      ).toBe(false);
    });
  });

  describe('isInvokeOnceModelAction', () => {
    it('有效数据应该返回 true', () => {
      expect(
        isInvokeOnceModelAction({
          action: 'invoke_once_model',
          modelId: 'gpt-4o',
          prompt: 'hello',
        })
      ).toBe(true);
    });

    it('缺少 prompt 应该返回 false', () => {
      expect(
        isInvokeOnceModelAction({
          action: 'invoke_once_model',
          modelId: 'gpt-4o',
        })
      ).toBe(false);
    });
  });
});
