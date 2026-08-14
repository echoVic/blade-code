/**
 * Task Tool - Subagent 调度工具
 *
 * 1. Markdown + YAML frontmatter 配置 subagent
 * 2. 模型决策 - 让模型自己决定用哪个 subagent_type
 * 3. subagent_type 参数必需 - 明确指定要使用的 subagent
 * 4. 工具隔离 - 每个 subagent 配置自己的工具白名单
 * 5. 后台执行 - 支持 run_in_background 参数
 * 6. 会话恢复 - 支持 resume 参数
 */

import path from 'node:path';
import { nanoid } from 'nanoid';
import type { LoopEvent } from '../../../agent/loop/types.js';
import type { SessionAgentResources } from '../../../agent/resources/WorkspaceAgentResources.js';
import type { SessionModelResources } from '../../../agent/resources/WorkspaceModelResources.js';
import {
  type AgentSession,
  type AgentSessionOwner,
  AgentSessionStore,
  createAgentSessionConfigSnapshot,
} from '../../../agent/subagents/AgentSessionStore.js';
import { BackgroundAgentManager } from '../../../agent/subagents/BackgroundAgentManager.js';
import { SubagentExecutor } from '../../../agent/subagents/SubagentExecutor.js';
import {
  getSubagentRegistry,
  type SubagentRegistry,
  subagentRegistry,
} from '../../../agent/subagents/SubagentRegistry.js';
import { buildCompletedSubagentTaskResult } from '../../../agent/subagents/SubagentResultAdoption.js';
import {
  type SubagentIsolationMode,
  SubagentWorktreeLease,
  subagentWorktreeLifecycle,
} from '../../../agent/subagents/SubagentWorktreeLifecycle.js';
import type {
  SubagentConfig,
  SubagentContext,
  SubagentResult,
} from '../../../agent/subagents/types.js';
import {
  type CommunicationStyleSelection,
  PermissionMode,
  type ReasoningEffortSelection,
  type ResponseVerbositySelection,
  type ServiceTierSelection,
} from '../../../config/types.js';
import { HookManager } from '../../../hooks/HookManager.js';
import type { SessionLspResources } from '../../../lsp/WorkspaceLspResources.js';
import { Default, StringEnum, Type } from '../../../schema/index.js';
import { Bus } from '../../../server/bus.js';
import { vanillaStore } from '../../../store/vanilla.js';
import {
  formatToolDisplay,
  renderToolDisplayToString,
} from '../../../ui/utils/toolFormatters.js';
import { getCwd } from '../../../utils/cwd.js';
import { captureProcessIdentity } from '../../../utils/process/ProcessIdentity.js';
import { createSessionId } from '../../../utils/sessionId.js';
import { createTool } from '../../core/createTool.js';
import type { ExecutionContext, ToolResult } from '../../types/index.js';
import { ToolErrorType, ToolKind } from '../../types/index.js';

/**
 * 从错误中提取用户友好的错误信息
 */
function extractUserFriendlyError(error: Error): string {
  const message = error.message || 'Unknown error';

  // 检查是否是 API 限流错误
  if (message.includes('Too Many Requests') || message.includes('429')) {
    // 尝试从错误链中提取更详细的信息
    const cause = (error as { cause?: { responseBody?: string } }).cause;
    if (cause?.responseBody) {
      try {
        const body = JSON.parse(cause.responseBody);
        if (body.message) {
          return body.message;
        }
      } catch {
        // 忽略解析错误
      }
    }
    return 'API 请求过于频繁，请稍后重试';
  }

  // 检查是否是网络错误
  if (message.includes('ECONNREFUSED') || message.includes('ETIMEDOUT')) {
    return '网络连接失败，请检查网络设置';
  }

  // 检查是否是认证错误
  if (message.includes('401') || message.includes('Unauthorized')) {
    return 'API 认证失败，请检查 API Key 配置';
  }

  // 返回简化的错误信息（不包含堆栈）
  return message.split('\n')[0];
}

/**
 * 验证 subagent 类型是否有效（运行时验证）
 * 不能使用静态 enum，因为 registry 在模块加载时尚未初始化
 */
function isValidSubagentType(registry: SubagentRegistry, type: string): boolean {
  const types = registry.getAllNames();
  return types.includes(type);
}

function getAvailableSubagentTypesMessage(registry: SubagentRegistry): string {
  const types = registry.getAllNames();
  return types.length > 0 ? types.join(', ') : 'none (registry not initialized)';
}

/**
 * 动态生成 Task 工具的完整描述
 * 必须是函数形式，因为 subagentRegistry 在模块加载时可能还未初始化
 */
function getTaskDescription(registry: SubagentRegistry): string {
  return `
## Task

Launch a new agent to handle complex, multi-step tasks autonomously.

The Task tool launches specialized agents (subprocesses) that autonomously handle complex tasks. Each agent type has specific capabilities and tools available to it.

${registry.getDescriptionsForPrompt()}

For a fresh Task run, specify subagent_type. For resume_from, omit it or pass the exact source type; Blade inherits and validates the durable source identity.

When NOT to use the Task tool:
- If you want to read a specific file path, use the Read or Glob tool instead of the Task tool, to find the match more quickly
- If you are searching for a specific class definition like "class Foo", use the Glob tool instead, to find the match more quickly
- If you are searching for code within a specific file or set of 2-3 files, use the Read tool instead of the Task tool, to find the match more quickly
- Other tasks that are not related to the agent descriptions above


Usage notes:
- Always include a short description (3-5 words) summarizing what the agent will do
- Launch multiple agents concurrently whenever possible, to maximize performance; to do that, use a single message with multiple tool uses
- When the agent is done, it will return a single message back to you. The result returned by the agent is not visible to the user. To show the user the result, you should send a text message back to the user with a concise summary of the result.
- You can optionally run agents in the background using the run_in_background parameter. Continue independent parent work after launch. Blade durably notifies you and resumes the parent when the child reaches a terminal state, so do not poll TaskOutput repeatedly. Use TaskOutput only for an explicit status check, an intentional blocking wait, or when the bounded completion notification says the full durable result is required.
- Agents can be resumed using the \`resume_from\` parameter by passing the agent ID from a previous invocation. The source type, model, permissions, workspace, and full context are inherited. A resume creates a new auditable child run and returns its new agent ID.
- Set \`isolation: "worktree"\` for coding tasks that must not modify the parent workspace. Clean successful worktrees are removed automatically; changed or failed worktrees are preserved and returned.
- When the agent is done, it returns a single message and a \`resume_from_hint\`. Use that ID for follow-up work.
- Provide clear, detailed prompts so the agent can work autonomously and return exactly the information you need.
- Agents with "access to current context" can see the full conversation history before the tool call. When using these agents, you can write concise prompts that reference earlier context (e.g., "investigate the error discussed above") instead of repeating information. The agent will receive all prior messages and understand the context.
- The agent's outputs should generally be trusted
- Clearly tell the agent whether you expect it to write code or just to do research (search, file reads, web fetches, etc.), since it is not aware of the user's intent
- If the agent description mentions that it should be used proactively, then you should try your best to use it without the user having to ask for it first. Use your judgement.
- If the user specifies that they want you to run agents "in parallel", you MUST send a single message with multiple Task tool use content blocks. For example, if you need to launch both a code-reviewer agent and a test-runner agent in parallel, send a single message with both tool calls.
  `.trim();
}

/**
 * TaskTool - Subagent 调度器
 *
 * 核心设计：
 * - subagent_type 参数（必需）- 明确指定使用哪个 subagent
 * - 模型从 subagent 描述中选择合适的类型
 * - 每个 subagent 有独立的系统提示和工具配置
 */
export function createTaskTool(
  registry: SubagentRegistry = getSubagentRegistry(),
  agentResources?: SessionAgentResources,
  modelResources?: SessionModelResources,
  lspResources?: SessionLspResources,
  getReasoningEffort?: () => ReasoningEffortSelection,
  getServiceTier?: () => ServiceTierSelection,
  getResponseVerbosity?: () => ResponseVerbositySelection,
  getCommunicationStyle?: () => CommunicationStyleSelection
) {
  return createTool({
    name: 'Task',
    displayName: 'Subagent Scheduler',
    kind: ToolKind.ReadOnly, // Plan 模式下允许：子 Agent 的工具使用受各自模式限制
    isReadOnly: true,
    // Each Task owns an independent durable child session. Coding agents should
    // still use worktree isolation, as required by the tool contract below.
    isConcurrencySafe: false,
    parallelism: 'shared',

    schema: Type.Object({
      subagent_type: Type.Optional(
        Type.Refine(
          Type.String({
            description:
              'Subagent type to use. Required for a fresh run; optional for resume_from.',
          }),
          (value) => isValidSubagentType(registry, value),
          (value) =>
            `Invalid subagent type: "${value}". Available: ${getAvailableSubagentTypesMessage(registry)}`
        )
      ),
      description: Type.String({
        minLength: 3,
        maxLength: 100,
        description: 'Short task description (3-5 words)',
      }),
      prompt: Type.String({
        minLength: 10,
        description: 'Detailed task instructions',
      }),
      run_in_background: Default(
        Type.Boolean({
          description:
            'Set true to run in the background. Blade will deliver a durable terminal notification; use TaskOutput only for explicit status or full-result reads.',
        }),
        false
      ),
      isolation: Type.Optional(
        StringEnum(['none', 'worktree'], {
          description:
            'Filesystem isolation. Use worktree to prevent edits affecting the parent workspace.',
        })
      ),
      resume: Type.Optional(
        Type.String({
          description: 'Deprecated alias for resume_from.',
        })
      ),
      resume_from: Type.Optional(
        Type.String({
          description:
            'Completed agent ID to resume. The source type, model, permissions, workspace, and transcript are inherited.',
        })
      ),
      subagent_session_id: Type.Optional(
        Type.String({ description: 'Internal subagent session id for tracking' })
      ),
    }),

    // 工具描述
    description: {
      short: 'Launch a new agent to handle complex, multi-step tasks autonomously',
      // 使用 getter 动态生成描述，确保 subagentRegistry 已初始化
      get long() {
        return getTaskDescription(registry);
      },
      usageNotes: [
        'subagent_type is required - choose from available agent types',
        'description should be 3-5 words (e.g., "Explore error handling")',
        'prompt should contain a highly detailed task description and specify exactly what information to return',
        'Launch multiple agents concurrently when possible for better performance',
        'Use isolation="worktree" for parallel coding agents that may edit files',
      ],
      examples: [
        {
          description: 'Explore codebase for API endpoints',
          params: {
            subagent_type: 'Explore',
            description: 'Find API endpoints',
            prompt:
              'Search the codebase for all API endpoint definitions. Look for route handlers, REST endpoints, and GraphQL resolvers. Return a structured list with file paths, endpoint URLs, HTTP methods, and descriptions.',
          },
        },
        {
          description: 'Plan authentication feature',
          params: {
            subagent_type: 'Plan',
            description: 'Plan user auth',
            prompt:
              'Create a detailed implementation plan for adding user authentication to this project. Analyze the existing architecture, then provide step-by-step instructions including: 1) Database schema changes 2) API routes to create 3) Frontend components needed 4) Security considerations 5) Testing strategy. Be specific about file names and code locations.',
          },
        },
      ],
    },

    // 执行函数
    async execute(params, context: ExecutionContext): Promise<ToolResult> {
      const {
        subagent_type,
        description,
        prompt,
        run_in_background = false,
        isolation,
        resume,
        resume_from,
        subagent_session_id,
      } = params;
      const resumeFrom = resume_from ?? resume;
      const owner = getTaskOwner(context);
      if (!owner) {
        return taskError(
          'Task requires an active parent session and absolute workspace',
          'Subagent 缺少 durable parent session owner'
        );
      }
      const reasoningEffort = getReasoningEffort?.();
      const serviceTier = getServiceTier?.();
      const responseVerbosity = getResponseVerbosity?.();
      const communicationStyle = getCommunicationStyle?.();
      const manager = BackgroundAgentManager.getInstance();
      const source = resumeFrom ? manager.getAgent(resumeFrom, owner) : undefined;
      if (resumeFrom && !source) {
        return taskError(
          `Cannot resume agent ${resumeFrom}: session not found in this workspace`,
          `恢复 Agent 失败: 会话不存在 ${resumeFrom}`
        );
      }
      if (source && (manager.isRunning(source.id) || source.status === 'running')) {
        return taskError(
          `Cannot resume agent ${source.id}: it is still running`,
          `恢复 Agent 失败: 仍在运行 ${source.id}`
        );
      }
      if (source && subagent_type && source.subagentType !== subagent_type) {
        return taskError(
          `Cannot resume with subagent_type "${subagent_type}": source agent used "${source.subagentType}"`,
          '恢复 Agent 失败: subagent 类型与源运行不一致'
        );
      }

      const effectiveType = source?.subagentType ?? subagent_type;
      if (!effectiveType) {
        return taskError(
          'subagent_type is required for a fresh Task run',
          '启动 Agent 失败: 缺少 subagent_type'
        );
      }

      const registeredConfig = registry.getSubagent(effectiveType);
      const restoredConfig = source?.configSnapshot
        ? ({ ...source.configSnapshot } as SubagentConfig)
        : undefined;
      const baseConfig = restoredConfig ?? registeredConfig;
      if (!baseConfig) {
        return taskError(
          `Unknown subagent type: ${effectiveType}. Available types: ${registry.getAllNames().join(', ') || 'none'}`,
          `未知的 subagent 类型: ${effectiveType}`
        );
      }
      const subagentConfig: SubagentConfig = {
        ...baseConfig,
        model:
          baseConfig.model && baseConfig.model !== 'inherit'
            ? baseConfig.model
            : (context.modelId ?? baseConfig.model),
        permissionMode: baseConfig.permissionMode ?? context.permissionMode,
      };
      const subagentSessionId =
        typeof subagent_session_id === 'string' && subagent_session_id.length > 0
          ? subagent_session_id
          : createSessionId('agent');
      const effectiveIsolation =
        source?.isolation ??
        (isolation as SubagentIsolationMode | undefined) ??
        subagentConfig.isolation ??
        'none';
      const rootAgentId = source?.rootAgentId ?? subagentSessionId;
      const resumeDepth = source ? source.resumeDepth + 1 : 0;
      const eventBridge = createSubagentEventBridge({
        owner,
        subagentSessionId,
        type: subagentConfig.name,
        description,
        background: run_in_background,
        resumedFrom: source?.id,
        rootAgentId,
        resumeDepth,
        notifyBackgroundSubagentCompleted: context.notifyBackgroundSubagentCompleted,
      });

      if (run_in_background) {
        const startedId = source
          ? manager.resumeAgent({
              agentId: source.id,
              prompt,
              config: subagentConfig,
              owner,
              permissionMode: context.permissionMode,
              reasoningEffort,
              serviceTier,
              responseVerbosity,
              communicationStyle,
              newAgentId: subagentSessionId,
              agentResources,
              modelResources,
              lspResources,
              onEvent: eventBridge.onEvent,
              onCompleted: eventBridge.onCompleted,
            })?.agentId
          : manager.startBackgroundAgent({
              config: subagentConfig,
              description,
              prompt,
              parentSessionId: owner.sessionId,
              parentProjectPath: owner.projectPath,
              permissionMode: context.permissionMode,
              reasoningEffort,
              serviceTier,
              responseVerbosity,
              communicationStyle,
              agentId: subagentSessionId,
              workspaceRoot: owner.projectPath,
              isolation: effectiveIsolation,
              agentResources,
              modelResources,
              lspResources,
              onEvent: eventBridge.onEvent,
              onCompleted: eventBridge.onCompleted,
            });
        if (!startedId) {
          return taskError(
            `Failed to resume agent ${source?.id ?? subagentSessionId}`,
            '恢复 Agent 失败'
          );
        }
        context.registerBackgroundSubagent?.(startedId);
        eventBridge.onStarted();
        return buildRunningTaskResult({
          sessionId: startedId,
          config: subagentConfig,
          description,
          isolation: effectiveIsolation,
          resumedFrom: source?.id,
          rootAgentId,
          resumeDepth,
        });
      }

      return executeForegroundTask({
        config: subagentConfig,
        description,
        prompt,
        context,
        owner,
        subagentSessionId,
        isolation: effectiveIsolation,
        source,
        eventBridge,
        agentResources,
        modelResources,
        lspResources,
        reasoningEffort,
        serviceTier,
        responseVerbosity,
        communicationStyle,
      });
    },

    version: '5.0.0',
    category: 'Subagent',
    tags: ['task', 'subagent', 'delegation', 'explore', 'plan'],

    extractSignatureContent: (params) =>
      `${params.subagent_type || 'resume'}:${params.resume_from || params.resume || ''}:${params.description}`,
    abstractPermissionRule: () => '',
  });
}

/** @deprecated Use createTaskTool(registry). */
export const taskTool = createTaskTool(subagentRegistry);

interface SubagentEventBridge {
  onStarted: () => void;
  onEvent: (event: LoopEvent) => void;
  onCompleted: (session: AgentSession) => Promise<void>;
}

interface ForegroundTaskInput {
  config: SubagentConfig;
  description: string;
  prompt: string;
  context: ExecutionContext;
  owner: AgentSessionOwner;
  subagentSessionId: string;
  isolation: SubagentIsolationMode;
  source?: AgentSession;
  eventBridge: SubagentEventBridge;
  agentResources?: SessionAgentResources;
  modelResources?: SessionModelResources;
  lspResources?: SessionLspResources;
  reasoningEffort?: ReasoningEffortSelection;
  serviceTier?: ServiceTierSelection;
  responseVerbosity?: ResponseVerbositySelection;
  communicationStyle?: CommunicationStyleSelection;
}

function getTaskOwner(context: ExecutionContext): AgentSessionOwner | undefined {
  if (!context.sessionId) return undefined;
  const projectPath = context.workspaceRoot || getCwd();
  if (!path.isAbsolute(projectPath)) return undefined;
  return {
    sessionId: context.sessionId,
    projectPath: path.resolve(projectPath),
  };
}

function taskError(message: string, summary: string): ToolResult {
  return {
    success: false,
    llmContent: message,
    error: {
      type: ToolErrorType.EXECUTION_ERROR,
      message,
    },
    metadata: { summary },
  };
}

function createSubagentEventBridge(input: {
  owner: AgentSessionOwner;
  subagentSessionId: string;
  type: string;
  description: string;
  background: boolean;
  resumedFrom?: string;
  rootAgentId: string;
  resumeDepth: number;
  notifyBackgroundSubagentCompleted?: (agentId: string) => Promise<void>;
}): SubagentEventBridge {
  const progressId = nanoid(8);
  let completed = false;
  const lineage = {
    resumedFrom: input.resumedFrom,
    rootAgentId: input.rootAgentId,
    resumeDepth: input.resumeDepth,
  };
  return {
    onStarted: () => {
      vanillaStore
        .getState()
        .app.actions.startSubagentProgress(progressId, input.type, input.description);
      Bus.publish(input.owner, 'subagent.start', {
        subagentId: progressId,
        subagentSessionId: input.subagentSessionId,
        type: input.type,
        description: input.description,
        ...lineage,
      });
    },
    onEvent: (event) => {
      switch (event.kind) {
        case 'tool_start': {
          const toolCall = event.toolCall;
          const toolName = 'function' in toolCall ? toolCall.function.name : 'Unknown';
          vanillaStore.getState().app.actions.updateSubagentTool(progressId, toolName);
          Bus.publish(input.owner, 'subagent.update', {
            subagentSessionId: input.subagentSessionId,
            toolName,
          });
          if ('function' in toolCall) {
            Bus.publish(input.owner, 'subagent.tool.start', {
              subagentSessionId: input.subagentSessionId,
              toolCallId: toolCall.id,
              toolName,
              arguments: toolCall.function.arguments,
              toolKind: event.toolKind,
            });
          }
          break;
        }
        case 'tool_result': {
          const toolCall = event.toolCall;
          if (!('function' in toolCall)) break;
          Bus.publish(input.owner, 'subagent.tool.result', {
            subagentSessionId: input.subagentSessionId,
            toolCallId: toolCall.id,
            toolName: toolCall.function.name,
            success: !event.result.error,
            summary: event.result.metadata?.summary,
            output: renderToolDisplayToString(
              formatToolDisplay(toolCall.function.name, event.result)
            ),
            metadata: event.result.metadata,
          });
          break;
        }
        case 'tool_progress': {
          const toolCall = event.toolCall;
          if (!('function' in toolCall)) break;
          Bus.publish(input.owner, 'subagent.tool.progress', {
            subagentSessionId: input.subagentSessionId,
            toolCallId: toolCall.id,
            toolName: toolCall.function.name,
            ...event.update,
          });
          break;
        }
        case 'content_delta':
          Bus.publish(input.owner, 'subagent.delta', {
            subagentSessionId: input.subagentSessionId,
            delta: event.delta,
          });
          break;
        case 'thinking_delta':
          Bus.publish(input.owner, 'subagent.thinking.delta', {
            subagentSessionId: input.subagentSessionId,
            delta: event.delta,
          });
          break;
        case 'stream_end':
          Bus.publish(input.owner, 'subagent.stream.end', {
            subagentSessionId: input.subagentSessionId,
          });
          break;
        default:
          break;
      }
    },
    onCompleted: async (session) => {
      if (completed) return;
      completed = true;
      if (input.background) {
        try {
          await input.notifyBackgroundSubagentCompleted?.(session.id);
        } catch (error) {
          console.warn(
            `[Task] Failed to enqueue background completion for ${session.id}:`,
            error
          );
        }
      }
      vanillaStore
        .getState()
        .app.actions.completeSubagentProgress(
          progressId,
          session.status === 'completed'
        );
      Bus.publish(input.owner, 'subagent.complete', {
        subagentSessionId: input.subagentSessionId,
        success: session.status === 'completed',
        status: session.status,
        summary: session.result?.message?.slice(0, 500),
        type: session.subagentType,
        verificationVerdict: session.result?.verificationVerdict,
        ...lineage,
      });
    },
  };
}

async function executeForegroundTask(input: ForegroundTaskInput): Promise<ToolResult> {
  const {
    config,
    description,
    prompt,
    context,
    owner,
    subagentSessionId,
    isolation,
    source,
    eventBridge,
    agentResources,
    modelResources,
    lspResources,
  } = input;
  const sessionStore = AgentSessionStore.getInstance();
  const sourceWorkspaceRoot = source?.workspaceRoot ?? owner.projectPath;
  const rootAgentId = source?.rootAgentId ?? subagentSessionId;
  const resumeDepth = source ? source.resumeDepth + 1 : 0;
  let worktreeLease: SubagentWorktreeLease | undefined;
  let worktreeFinalized = false;
  let sessionSaved = false;
  const finalizeWorktree = async (success: boolean) => {
    if (!worktreeLease || worktreeFinalized) return undefined;
    const outcome = await subagentWorktreeLifecycle.finalize({
      agentId: subagentSessionId,
      lease: worktreeLease,
      success,
    });
    worktreeFinalized = true;
    return outcome;
  };

  try {
    worktreeLease = await subagentWorktreeLifecycle.prepare({
      agentId: subagentSessionId,
      sourceWorkspaceRoot,
      isolation,
      restoredWorktree: source?.worktree,
    });
    const now = Date.now();
    sessionStore.saveSession({
      schemaVersion: 2,
      id: subagentSessionId,
      subagentType: config.name,
      description,
      prompt,
      messages: [...(source?.messages ?? [])],
      status: 'running',
      background: false,
      createdAt: now,
      lastActiveAt: now,
      processId: process.pid,
      processIdentity: captureProcessIdentity(process.pid),
      parentSessionId: owner.sessionId,
      parentProjectPath: owner.projectPath,
      rootAgentId,
      resumedFrom: source?.id,
      resumeDepth,
      configSnapshot: createAgentSessionConfigSnapshot(config),
      workspaceRoot: sourceWorkspaceRoot,
      isolation,
      worktree: worktreeLease.worktree,
    });
    sessionSaved = true;
    eventBridge.onStarted();
    context.updateOutput?.(
      `${source ? '恢复' : '启动'} ${config.name} subagent: ${description}`
    );

    const executor = new SubagentExecutor(
      config,
      agentResources,
      modelResources,
      lspResources
    );
    const subagentContext: SubagentContext = {
      prompt,
      parentSessionId: owner.sessionId,
      permissionMode: config.permissionMode ?? context.permissionMode,
      reasoningEffort: input.reasoningEffort,
      serviceTier: input.serviceTier,
      responseVerbosity: input.responseVerbosity,
      communicationStyle: input.communicationStyle,
      subagentSessionId,
      resumedFrom: source?.id,
      rootAgentId,
      resumeDepth,
      workspaceRoot: worktreeLease.workspaceRoot,
      worktreeActive: Boolean(worktreeLease.worktree),
      existingMessages: source?.messages,
      onEvent: eventBridge.onEvent,
    };
    const startTime = Date.now();
    let result: SubagentResult = await executor.execute(subagentContext);

    try {
      const stopResult = await HookManager.getInstance().executeSubagentStopHooks(
        config.name,
        {
          projectDir: worktreeLease.workspaceRoot,
          sessionId: owner.sessionId,
          permissionMode:
            config.permissionMode ?? context.permissionMode ?? PermissionMode.DEFAULT,
          taskDescription: description,
          success: result.success,
          resultSummary: result.message.slice(0, 500),
          error: result.error,
        }
      );
      if (!stopResult.shouldStop && stopResult.continueReason) {
        result = await executor.execute({
          ...subagentContext,
          prompt: stopResult.continueReason,
          existingMessages: result.messages,
        });
      }
      if (stopResult.warning) {
        console.warn(`[Task] SubagentStop hook warning: ${stopResult.warning}`);
      }
    } catch (hookError) {
      console.warn('[Task] SubagentStop hook execution failed:', hookError);
    }

    const worktreeOutcome = await finalizeWorktree(result.success);
    if (worktreeOutcome?.preserved) {
      result.worktreePath = worktreeOutcome.worktreePath;
      result.worktreeBranch = worktreeOutcome.worktreeBranch;
      result.worktree = worktreeOutcome.worktree;
    }
    sessionStore.updateSession(subagentSessionId, {
      messages: result.messages ?? [],
      worktree: worktreeOutcome?.worktree,
    });
    const completedSession = sessionStore.markCompleted(
      subagentSessionId,
      {
        success: result.success,
        message: result.message,
        error: result.error,
        verificationCommands: result.verificationCommands,
        verificationVerdict: result.verificationVerdict,
        modifiedFiles: result.modifiedFiles,
      },
      {
        ...result.stats,
        duration: Date.now() - startTime,
      }
    );
    if (completedSession) await eventBridge.onCompleted(completedSession);
    return buildCompletedTaskResult({
      result,
      sessionId: subagentSessionId,
      config,
      description,
      isolation,
      resumedFrom: source?.id,
      rootAgentId,
      resumeDepth,
    });
  } catch (error) {
    const err = error as Error;
    let worktreeOutcome: Awaited<ReturnType<typeof finalizeWorktree>> | undefined;
    try {
      worktreeOutcome = await finalizeWorktree(false);
    } catch (finalizeError) {
      console.warn('[Task] Failed to preserve subagent worktree:', finalizeError);
    }
    if (sessionSaved) {
      const failedSession = sessionStore.markCompleted(subagentSessionId, {
        success: false,
        message: '',
        error: err.message,
      });
      if (failedSession) await eventBridge.onCompleted(failedSession);
    }
    return {
      ...taskError(
        `Subagent execution error: ${err.message}`,
        `Subagent 执行异常: ${extractUserFriendlyError(err)}`
      ),
      metadata: {
        summary: `Subagent 执行异常: ${extractUserFriendlyError(err)}`,
        subagentSessionId,
        subagentType: config.name,
        subagentStatus: 'failed',
        subagentResumedFrom: source?.id,
        subagentRootId: rootAgentId,
        subagentResumeDepth: resumeDepth,
        isolation,
        worktreePath: worktreeOutcome?.worktreePath,
        worktreeBranch: worktreeOutcome?.worktreeBranch,
      },
    };
  }
}

function buildRunningTaskResult(input: {
  sessionId: string;
  config: SubagentConfig;
  description: string;
  isolation: SubagentIsolationMode;
  resumedFrom?: string;
  rootAgentId: string;
  resumeDepth: number;
}): ToolResult {
  return {
    success: true,
    llmContent: {
      agent_id: input.sessionId,
      status: 'running',
      resumed_from: input.resumedFrom,
      resume_from_hint: input.sessionId,
      message: `Agent ${input.resumedFrom ? 'resumed' : 'started'} in background. Blade will notify this parent when it reaches a terminal state.`,
      notification:
        'Blade will deliver a durable completion notification automatically. Continue independent parent work and do not poll repeatedly.',
    },
    metadata: {
      summary: `${input.resumedFrom ? '恢复' : '启动'}后台 Agent: ${input.sessionId}`,
      agent_id: input.sessionId,
      resume_from_hint: input.sessionId,
      resumed_from: input.resumedFrom,
      subagent_type: input.config.name,
      description: input.description,
      background: true,
      isolation: input.isolation,
      subagentSessionId: input.sessionId,
      subagentType: input.config.name,
      subagentStatus: 'running',
      subagentResumedFrom: input.resumedFrom,
      subagentRootId: input.rootAgentId,
      subagentResumeDepth: input.resumeDepth,
    },
  };
}

function buildCompletedTaskResult(input: {
  result: SubagentResult;
  sessionId: string;
  config: SubagentConfig;
  description: string;
  isolation: SubagentIsolationMode;
  resumedFrom?: string;
  rootAgentId: string;
  resumeDepth: number;
}): ToolResult {
  const canonical = buildCompletedSubagentTaskResult({
    result: input.result,
    sessionId: input.sessionId,
    subagentType: input.config.name,
    subagentSource: input.config.source,
    description: input.description,
    isolation: input.isolation,
    resumedFrom: input.resumedFrom,
    rootAgentId: input.rootAgentId,
    resumeDepth: input.resumeDepth,
  });
  if (canonical.success) {
    return {
      success: true,
      llmContent: canonical.llmContent,
      metadata: canonical.metadata,
    };
  }
  return {
    success: false,
    llmContent: canonical.llmContent,
    error: {
      type: ToolErrorType.EXECUTION_ERROR,
      message: canonical.errorMessage ?? 'Unknown error',
    },
    metadata: canonical.metadata,
  };
}
