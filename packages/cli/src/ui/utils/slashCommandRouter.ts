/**
 * Slash 命令路由与分派
 *
 * 将 slash 命令执行结果路由到对应的 UI 操作或转换为 Agent 输入。
 * `SlashRouteResult` 联合类型显式分离"UI 展示什么"和"Agent 实际收到什么"。
 */

import type { Message, UsageInfo } from '../../services/ChatServiceInterface.js';
import { safeExit } from '../../services/GracefulShutdown.js';
import { type SessionMetadata, SessionService } from '../../services/SessionService.js';
import {
  executeSlashCommand,
  isSlashCommand,
  type SlashCommandContext,
} from '../../slash-commands/index.js';
import type { SessionSelectionAction } from '../../slash-commands/types.js';
import type { useAppActions, useSessionActions } from '../../store/selectors/index.js';
import { getCwd } from '../../utils/cwd.js';
import type { ResolvedInput } from '../hooks/useInputBuffer.js';
import type { CleanupAgent } from './sessionActivation.js';
import { activateSessionSelection } from './sessionActivation.js';

// ==================== 类型定义 ====================

export interface CommandResult {
  success: boolean;
  output?: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

/**
 * 显式编码"UI 展示"和"Agent 输入"的分离语义
 *
 * 当前实现中的分离规则：
 * - /skill, invoke_once_model: UI 显示 = Agent 输入 = 改写后的 prompt
 * - /custom, /plugin: UI 显示原始命令, Agent 输入展开后的 prompt
 *
 * 用 userDisplayMessage + agentInput 两个字段显式编码，
 * 替代原来的 resolved 复用 + displayText 隐式约定
 */
export interface AgentContinuation {
  /** UI 中显示给用户看的消息文本（已通过 addUserMessage 添加） */
  userDisplayMessage: string;
  /** 实际发送给 Agent 的 ResolvedInput（text 可能与 displayMessage 不同） */
  agentInput: ResolvedInput;
  /** 用户消息是否已经在路由过程中添加到 UI */
  userMessageAlreadyAdded: boolean;
  /** 一次性模型 ID（invoke_once_model 场景） */
  onceModelId?: string;
  /** Continue from the persisted goal without a durable user prompt. */
  goalContinuationOnly?: boolean;
}

export type SlashRouteResult =
  | { type: 'handled'; commandResult: CommandResult }
  | { type: 'continue_as_agent'; result: AgentContinuation }
  | { type: 'not_slash' };

// ==================== Invoke*Data 接口 ====================

interface InvokeSkillData {
  action: 'invoke_skill';
  skillName: string;
  skillArgs?: string;
}

interface InvokeCustomCommandData {
  action: 'invoke_custom_command';
  commandName: string;
  processedContent: string;
  config: {
    description?: string;
    allowedTools?: string[];
    argumentHint?: string;
    model?: string;
    disableModelInvocation?: boolean;
  };
}

interface InvokePluginCommandData {
  action: 'invoke_plugin_command';
  commandName: string;
  pluginName: string;
  processedContent: string;
  config: {
    description?: string;
    allowedTools?: string[];
    argumentHint?: string;
    model?: string;
    disableModelInvocation?: boolean;
  };
}

interface InvokeOnceModelData {
  action: 'invoke_once_model';
  modelId: string;
  prompt: string;
}

interface GoalContinuationData {
  action: 'start_goal' | 'resume_goal';
  goal: {
    objective: string;
  };
}

interface RewindSessionData {
  action: 'rewind_session';
  sessionId: string;
  messages: Message[];
  visibleMessages: Parameters<SessionActions['restoreSession']>[1];
}

function isSessionMetadata(value: unknown): value is SessionMetadata {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as SessionMetadata).sessionId === 'string' &&
    typeof (value as SessionMetadata).projectPath === 'string' &&
    typeof (value as SessionMetadata).rootId === 'string' &&
    typeof (value as SessionMetadata).messageCount === 'number' &&
    typeof (value as SessionMetadata).firstMessageTime === 'string' &&
    typeof (value as SessionMetadata).lastMessageTime === 'string' &&
    typeof (value as SessionMetadata).hasErrors === 'boolean'
  );
}

// ==================== 类型守卫 ====================

export function isInvokeSkillAction(data: unknown): data is InvokeSkillData {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as InvokeSkillData).action === 'invoke_skill' &&
    typeof (data as InvokeSkillData).skillName === 'string'
  );
}

export function isInvokeCustomCommandAction(
  data: unknown
): data is InvokeCustomCommandData {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as InvokeCustomCommandData).action === 'invoke_custom_command' &&
    typeof (data as InvokeCustomCommandData).commandName === 'string' &&
    typeof (data as InvokeCustomCommandData).processedContent === 'string'
  );
}

export function isInvokePluginCommandAction(
  data: unknown
): data is InvokePluginCommandData {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as InvokePluginCommandData).action === 'invoke_plugin_command' &&
    typeof (data as InvokePluginCommandData).commandName === 'string' &&
    typeof (data as InvokePluginCommandData).processedContent === 'string'
  );
}

export function isInvokeOnceModelAction(data: unknown): data is InvokeOnceModelData {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as InvokeOnceModelData).action === 'invoke_once_model' &&
    typeof (data as InvokeOnceModelData).modelId === 'string' &&
    typeof (data as InvokeOnceModelData).prompt === 'string'
  );
}

export function isGoalContinuationAction(data: unknown): data is GoalContinuationData {
  return (
    typeof data === 'object' &&
    data !== null &&
    ['start_goal', 'resume_goal'].includes(
      String((data as GoalContinuationData).action)
    ) &&
    typeof (data as GoalContinuationData).goal?.objective === 'string'
  );
}

export function isRewindSessionAction(data: unknown): data is RewindSessionData {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as RewindSessionData).action === 'rewind_session' &&
    typeof (data as RewindSessionData).sessionId === 'string' &&
    Array.isArray((data as RewindSessionData).messages) &&
    Array.isArray((data as RewindSessionData).visibleMessages)
  );
}

export function isSessionSelectionAction(
  data: unknown
): data is SessionSelectionAction {
  if (typeof data !== 'object' || data === null) {
    return false;
  }

  const intent = (data as { intent?: unknown }).intent;
  if (intent !== 'resume' && intent !== 'fork') {
    return false;
  }

  const action = (data as { action?: unknown }).action;
  if (action === 'select_session') {
    const sessions = (data as { sessions?: unknown }).sessions;
    return (
      Array.isArray(sessions) && sessions.every((session) => isSessionMetadata(session))
    );
  }

  if (action === 'activate_session') {
    return isSessionMetadata((data as { session?: unknown }).session);
  }

  return false;
}

// ==================== handleSlashMessage ====================

type AppActions = ReturnType<typeof useAppActions>;
type SessionActions = ReturnType<typeof useSessionActions>;

/**
 * 处理 slash 命令返回的 UI 消息
 * 直接调用 appActions 而非使用 ActionMapper
 *
 * @returns true 如果消息已处理完成，false 如果未识别的消息类型
 */
function handleSlashMessage(
  message: string,
  data: unknown,
  appActions: AppActions,
  sessionActions: SessionActions
): boolean {
  switch (message) {
    case 'show_theme_selector':
      appActions.setActiveModal('themeSelector');
      return true;
    case 'show_model_selector':
      appActions.setActiveModal('modelSelector');
      return true;
    case 'show_model_add_wizard':
      appActions.setActiveModal('modelAddWizard');
      return true;
    case 'show_permissions_manager':
      appActions.setActiveModal('permissionsManager');
      return true;
    case 'show_agents_manager':
      appActions.setActiveModal('agentsManager');
      return true;
    case 'show_skills_manager':
      appActions.setActiveModal('skillsManager');
      return true;
    case 'show_hooks_manager':
      appActions.setActiveModal('hooksManager');
      return true;
    case 'show_plugins_manager':
      appActions.setActiveModal('pluginsManager');
      return true;
    case 'show_agent_creation_wizard':
      appActions.setActiveModal('agentCreationWizard');
      return true;
    case 'show_session_selector': {
      const sessions = (data as { sessions?: SessionMetadata[] } | undefined)?.sessions;
      appActions.showSessionSelector(sessions ?? [], 'resume');
      return true;
    }
    case 'session_forked': {
      const fork = data as
        | {
            action?: string;
            sessionId?: string;
            messages?: unknown[];
            visibleMessages?: unknown[];
          }
        | undefined;
      if (
        fork?.action !== 'restore_forked_session' ||
        !fork.sessionId ||
        !Array.isArray(fork.messages) ||
        !Array.isArray(fork.visibleMessages)
      ) {
        return false;
      }
      sessionActions.restoreSession(
        fork.sessionId,
        fork.visibleMessages as Parameters<SessionActions['restoreSession']>[1],
        fork.messages as Parameters<SessionActions['restoreSession']>[2]
      );
      return true;
    }
    case 'session_archived': {
      const archived = (data as { session?: SessionMetadata } | undefined)?.session;
      sessionActions.addAssistantMessage(
        archived ? `会话 ${archived.sessionId} 已归档。` : '当前会话已归档。'
      );
      safeExit(0);
      return true;
    }
    case 'clear_screen':
      // 完整重置会话状态（参考 Claude Code 的 /clear 行为）
      sessionActions.clearMessages();
      sessionActions.setError(null);
      sessionActions.resetTokenUsage();
      appActions.setTasks([]);
      return true;
    case 'compact_completed':
    case 'compact_fallback': {
      const compactData = data as
        | {
            compactedMessages?: Message[];
            usage?: UsageInfo;
            maxContextTokens?: number;
          }
        | undefined;
      const compactedMessages = compactData?.compactedMessages;
      if (compactedMessages) {
        sessionActions.setCompactedContext(compactedMessages);
      }
      if (compactData?.usage) {
        sessionActions.updateTokenUsage({
          inputTokens: compactData.usage.promptTokens,
          outputTokens: compactData.usage.completionTokens,
          totalTokens: compactData.usage.totalTokens,
          maxContextTokens: compactData.maxContextTokens,
          cacheReadTokens: compactData.usage.cacheReadInputTokens ?? 0,
          cacheWriteTokens: compactData.usage.cacheCreationInputTokens ?? 0,
          costUsd: compactData.usage.costUsd,
        });
      }
      sessionActions.resetContextUsage();
      return true;
    }
    case 'exit_application':
      safeExit(0);
      return true;
    default:
      return false;
  }
}

// ==================== processSlashCommand ====================

/**
 * 处理 slash 命令路由
 *
 * 将 slash 命令执行结果路由到对应的 UI 操作，
 * 或转换为 Agent 输入（invoke_skill / invoke_custom_command / invoke_plugin_command / invoke_once_model）。
 *
 * 只接收 signal，不接收 commandActions — 遵循架构约束，
 * 子模块不应自行创建 AbortController。
 *
 * 注意：调用方应在调用此函数前执行 ensureStoreInitialized()。
 */
export async function processSlashCommand(
  resolved: ResolvedInput,
  appActions: AppActions,
  sessionActions: SessionActions,
  signal: AbortSignal,
  cleanupAgent: CleanupAgent,
  sessionId?: string,
  messages?: Message[],
  rewind?: SlashCommandContext['rewind'],
  subagents?: SlashCommandContext['subagents'],
  mcp?: SlashCommandContext['mcp'],
  reasoning?: SlashCommandContext['reasoning'],
  serviceTier?: SlashCommandContext['serviceTier'],
  responseVerbosity?: SlashCommandContext['responseVerbosity'],
  communicationStyle?: SlashCommandContext['communicationStyle'],
  workspaceRoot: string = getCwd()
): Promise<SlashRouteResult> {
  const { text: command } = resolved;

  if (!isSlashCommand(command)) {
    return { type: 'not_slash' };
  }

  const slashContext: SlashCommandContext = {
    cwd: workspaceRoot,
    surface: 'tui',
    workspaceRoot,
    sessionId,
    messages,
    rewind,
    lifecycle:
      sessionId === undefined
        ? undefined
        : {
            archiveCurrent: async () => {
              await cleanupAgent();
              return SessionService.archiveSession(sessionId, workspaceRoot);
            },
          },
    subagents,
    mcp,
    reasoning,
    serviceTier,
    responseVerbosity,
    communicationStyle,
    signal,
  };

  const slashResult = await executeSlashCommand(command, slashContext);

  if (slashResult.success && isSessionSelectionAction(slashResult.data)) {
    if (slashResult.data.action === 'select_session') {
      appActions.showSessionSelector(
        slashResult.data.sessions,
        slashResult.data.intent
      );
      return { type: 'handled', commandResult: { success: true } };
    }

    await activateSessionSelection(
      slashResult.data,
      workspaceRoot,
      sessionActions,
      cleanupAgent
    );
    return { type: 'handled', commandResult: { success: true } };
  }

  if (slashResult.success && isRewindSessionAction(slashResult.data)) {
    sessionActions.restoreSession(
      slashResult.data.sessionId,
      slashResult.data.visibleMessages,
      slashResult.data.messages
    );
    appActions.setTasks([]);
    return { type: 'handled', commandResult: { success: true } };
  }

  // 处理 UI 消息（show modal / clear / exit 等）
  if (slashResult.message) {
    const handled = handleSlashMessage(
      slashResult.message,
      slashResult.data,
      appActions,
      sessionActions
    );
    if (handled) {
      return { type: 'handled', commandResult: { success: true } };
    }
  }

  // 处理 invoke_skill action
  if (isInvokeSkillAction(slashResult.data)) {
    const { skillName, skillArgs } = slashResult.data;
    const skillPrompt = skillArgs
      ? `Please use the "${skillName}" skill to help me with: ${skillArgs}`
      : `Please use the "${skillName}" skill.`;

    sessionActions.addUserMessage(skillPrompt);

    return {
      type: 'continue_as_agent',
      result: {
        userDisplayMessage: skillPrompt,
        agentInput: {
          displayText: skillPrompt,
          text: skillPrompt,
          images: [],
          parts: [{ type: 'text', text: skillPrompt }],
        },
        userMessageAlreadyAdded: true,
      },
    };
  }

  // 处理 invoke_custom_command action
  if (isInvokeCustomCommandAction(slashResult.data)) {
    const { commandName, processedContent } = slashResult.data;

    // UI 显示原始命令
    sessionActions.addUserMessage(command);

    // Agent 收到展开后的 prompt（与 UI 显示不同）
    const commandPrompt = `# Custom Command: /${commandName}

The user has invoked the custom command "/${commandName}". Follow the instructions below to complete the task.

---

${processedContent}

---

Remember: Follow the above instructions carefully to complete the user's request.`;

    return {
      type: 'continue_as_agent',
      result: {
        userDisplayMessage: command,
        agentInput: {
          displayText: command,
          text: commandPrompt,
          images: [],
          parts: [{ type: 'text', text: commandPrompt }],
        },
        userMessageAlreadyAdded: true,
      },
    };
  }

  // 处理 invoke_plugin_command action
  if (isInvokePluginCommandAction(slashResult.data)) {
    const { commandName, pluginName, processedContent } = slashResult.data;

    // UI 显示原始命令
    sessionActions.addUserMessage(command);

    // Agent 收到展开后的 prompt（与 UI 显示不同）
    const commandPrompt = `# Plugin Command: /${commandName}

The user has invoked the plugin command "/${commandName}" from plugin "${pluginName}". Follow the instructions below to complete the task.

---

${processedContent}

---

Remember: Follow the above instructions carefully to complete the user's request.`;

    return {
      type: 'continue_as_agent',
      result: {
        userDisplayMessage: command,
        agentInput: {
          displayText: command,
          text: commandPrompt,
          images: [],
          parts: [{ type: 'text', text: commandPrompt }],
        },
        userMessageAlreadyAdded: true,
      },
    };
  }

  // 处理 invoke_once_model action
  if (isInvokeOnceModelAction(slashResult.data)) {
    const { modelId, prompt } = slashResult.data;

    sessionActions.addUserMessage(prompt);

    return {
      type: 'continue_as_agent',
      result: {
        userDisplayMessage: prompt,
        agentInput: {
          displayText: prompt,
          text: prompt,
          images: [],
          parts: [{ type: 'text', text: prompt }],
        },
        userMessageAlreadyAdded: true,
        onceModelId: modelId,
      },
    };
  }

  if (isGoalContinuationAction(slashResult.data)) {
    const objective = slashResult.data.goal.objective;
    sessionActions.addUserMessage(command);
    return {
      type: 'continue_as_agent',
      result: {
        userDisplayMessage: command,
        agentInput: {
          displayText: command,
          text: objective,
          images: [],
          parts: [{ type: 'text', text: objective }],
        },
        userMessageAlreadyAdded: true,
        goalContinuationOnly: true,
      },
    };
  }

  // 非 invoke_* 的 slash command，正常处理
  if (!slashResult.success && slashResult.error) {
    sessionActions.addAssistantMessage(`${slashResult.error}`);
    return {
      type: 'handled',
      commandResult: {
        success: slashResult.success,
        output: slashResult.message,
        error: slashResult.error,
        metadata: slashResult.data,
      },
    };
  }

  // 显示命令返回的消息
  const slashMessage = slashResult.message;
  if (
    slashResult.success &&
    typeof slashMessage === 'string' &&
    slashMessage.trim() !== ''
  ) {
    sessionActions.addAssistantMessage(slashMessage);
  }

  return {
    type: 'handled',
    commandResult: {
      success: slashResult.success,
      output: slashResult.message,
      error: slashResult.error,
      metadata: slashResult.data,
    },
  };
}
