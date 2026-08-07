/**
 * Blade ACP Agent 实现
 *
 * 实现 ACP 协议的 Agent 接口，使 Blade 可以被 Zed、JetBrains 等编辑器调用。
 *
 */

import path from 'node:path';
import type * as acp from '@agentclientprotocol/sdk';
import {
  type Agent as AcpAgentInterface,
  type AgentSideConnection,
  PROTOCOL_VERSION,
} from '@agentclientprotocol/sdk';
import { createLogger, LogCategory } from '../logging/Logger.js';
import { McpRegistry } from '../mcp/McpRegistry.js';
import { getModelDisplayName } from '../services/pi/resolveModelConfig.js';
import { type SessionMetadata, SessionService } from '../services/SessionService.js';
import { SessionTaskService } from '../services/SessionTaskService.js';
import { getConfig } from '../store/vanilla.js';
import { getCwd } from '../utils/cwd.js';
import { createSessionId } from '../utils/sessionId.js';
import { AcpSession } from './Session.js';

const logger = createLogger(LogCategory.AGENT);

/**
 * Blade ACP Agent
 *
 * 实现 ACP 协议的 Agent 接口，处理来自 IDE 的请求。
 */
export class BladeAgent implements AcpAgentInterface {
  private sessions: Map<string, AcpSession> = new Map();
  private sessionLoadQueues: Map<string, Promise<void>> = new Map();
  private clientCapabilities: acp.ClientCapabilities | undefined;
  private destroyed = false;

  constructor(private connection: AgentSideConnection) {}

  /**
   * 初始化连接，协商协议版本和能力
   */
  async initialize(params: acp.InitializeRequest): Promise<acp.InitializeResponse> {
    logger.info('[BladeAgent] Initializing ACP connection');
    logger.debug(
      `[BladeAgent] Client capabilities: ${JSON.stringify(params.clientCapabilities)}`
    );

    // 保存客户端能力，用于后续判断是否使用 IDE 的文件系统
    this.clientCapabilities = params.clientCapabilities;

    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: {
          list: {},
          fork: {},
        },
        // 支持的提示能力
        promptCapabilities: {
          image: true, // 支持图片
          audio: false, // 暂不支持音频
          embeddedContext: true, // 支持嵌入上下文
        },
        // MCP 能力（Blade 已有 MCP 支持）
        mcpCapabilities: {
          http: true,
          sse: true,
        },
      },
    };
  }

  /**
   * 认证（Blade 目前不需要认证）
   */
  async authenticate(
    _params: acp.AuthenticateRequest
  ): Promise<acp.AuthenticateResponse | void> {
    // Blade 使用环境变量中的 API Key，不需要额外认证
    return;
  }

  /**
   * 创建新会话
   */
  async newSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
    this.assertNotDestroyed();
    const sessionId = createSessionId('acp');
    const sourceCwd = params.cwd || getCwd();
    const requestedIsolation = params._meta?.['blade/taskIsolation'];
    const taskIsolation =
      requestedIsolation === 'local' || requestedIsolation === 'worktree'
        ? requestedIsolation
        : undefined;
    const requestedPrompt = params._meta?.['blade/taskPrompt'];
    const createdTask = taskIsolation
      ? await SessionTaskService.createSessionTask({
          sessionId,
          prompt:
            typeof requestedPrompt === 'string' && requestedPrompt.trim()
              ? requestedPrompt
              : 'ACP task session',
          sourceProjectPath: sourceCwd,
          isolation: taskIsolation,
        })
      : undefined;
    const sessionCwd = createdTask?.metadata.projectPath ?? sourceCwd;
    logger.info(`[BladeAgent] Creating new session: ${sessionId}`);
    logger.debug(`[BladeAgent] Session cwd: ${sessionCwd}`);

    // 创建会话实例
    const session = new AcpSession(
      sessionId,
      sessionCwd,
      this.connection,
      this.clientCapabilities,
      {
        mcpServers: params.mcpServers,
        ...(createdTask?.taskWorktree
          ? { taskWorktree: createdTask.taskWorktree }
          : {}),
        ...(createdTask?.metadata.taskIsolation
          ? { taskIsolation: createdTask.metadata.taskIsolation }
          : {}),
      }
    );

    try {
      // 初始化会话（创建 Agent 等）
      await session.initialize();
      this.assertNotDestroyed();
    } catch (error) {
      await session.destroy().catch(() => undefined);
      throw error;
    }

    this.sessions.set(sessionId, session);

    logger.info(
      `[BladeAgent] Session ${sessionId} created, scheduling available commands update`
    );

    // 延迟发送 available_commands_update，确保在响应后
    session.sendAvailableCommandsDelayed();

    return this.buildChildSessionResponse(
      sessionId,
      createdTask?.metadata,
      session.getCurrentModelId()
    );
  }

  async listSessions(
    params: acp.ListSessionsRequest
  ): Promise<acp.ListSessionsResponse> {
    if (params.cwd != null && !path.isAbsolute(params.cwd)) {
      throw new Error('ACP session list cwd must be absolute');
    }

    const page = await SessionService.listSessionPage({
      cwd: params.cwd ?? undefined,
      cursor: params.cursor ?? undefined,
      limit: 50,
      includeSubagents: false,
    });

    return {
      sessions: page.sessions.map((session) => ({
        sessionId: session.sessionId,
        cwd: session.projectPath,
        title: session.title ?? null,
        updatedAt: session.lastMessageTime,
        _meta: {
          'blade/taskStatus': session.taskStatus,
          ...(session.taskStatusReason
            ? { 'blade/taskStatusReason': session.taskStatusReason }
            : {}),
          ...(session.taskFailure ? { 'blade/taskFailure': session.taskFailure } : {}),
          ...(session.taskStartedAt
            ? { 'blade/taskStartedAt': session.taskStartedAt }
            : {}),
          ...(session.taskCompletedAt
            ? { 'blade/taskCompletedAt': session.taskCompletedAt }
            : {}),
          ...(session.taskModelId ? { 'blade/taskModelId': session.taskModelId } : {}),
          ...(session.taskRetryAvailable ? { 'blade/taskRetryAvailable': true } : {}),
          ...(session.taskRetriedFrom
            ? { 'blade/taskRetriedFrom': session.taskRetriedFrom }
            : {}),
          ...(session.taskDelivery
            ? { 'blade/taskDelivery': session.taskDelivery }
            : {}),
          ...(session.taskIsolation
            ? { 'blade/taskIsolation': session.taskIsolation }
            : {}),
          ...(session.taskSourceProjectPath
            ? { 'blade/taskSourceProjectPath': session.taskSourceProjectPath }
            : {}),
          ...(session.taskWorktreeBranch
            ? { 'blade/taskWorktreeBranch': session.taskWorktreeBranch }
            : {}),
          ...(session.taskBaseCommit
            ? { 'blade/taskBaseCommit': session.taskBaseCommit }
            : {}),
          ...(session.taskDiffStat
            ? { 'blade/taskDiffStat': session.taskDiffStat }
            : {}),
          ...(session.taskQueuePosition
            ? { 'blade/taskQueuePosition': session.taskQueuePosition }
            : {}),
          ...(session.taskQueueDepth !== undefined
            ? { 'blade/taskQueueDepth': session.taskQueueDepth }
            : {}),
          ...(session.taskConcurrencyLimit !== undefined
            ? {
                'blade/taskConcurrencyLimit': session.taskConcurrencyLimit,
              }
            : {}),
        },
      })),
      nextCursor: page.nextCursor,
    };
  }

  async unstable_forkSession(
    params: acp.ForkSessionRequest
  ): Promise<acp.ForkSessionResponse> {
    this.assertNotDestroyed();
    if (!path.isAbsolute(params.cwd)) {
      throw new Error('ACP session fork cwd must be absolute');
    }

    const fork = await SessionService.forkSession(params.sessionId, {
      sourceProjectPath: params.cwd,
      targetProjectPath: params.cwd,
    });
    this.assertNotDestroyed();
    const session = new AcpSession(
      fork.sessionId,
      params.cwd,
      this.connection,
      this.clientCapabilities,
      { initialMessages: fork.messages, mcpServers: params.mcpServers }
    );

    try {
      await session.initialize();
      this.assertNotDestroyed();
    } catch (error) {
      await session.destroy().catch(() => undefined);
      throw error;
    }

    this.sessions.set(fork.sessionId, session);
    session.sendAvailableCommandsDelayed();
    return this.buildChildSessionResponse(
      fork.sessionId,
      fork.metadata,
      session.getCurrentModelId()
    );
  }

  /**
   * 恢复持久化会话并在响应前按协议回放历史。
   */
  async loadSession(params: acp.LoadSessionRequest): Promise<acp.LoadSessionResponse> {
    this.assertNotDestroyed();
    logger.info(`[BladeAgent] Loading session: ${params.sessionId}`);
    const previousLoad = this.sessionLoadQueues.get(params.sessionId);
    const load = (previousLoad ?? Promise.resolve()).then(() =>
      this.replaceSession(params)
    );
    const queueTail = load.then(
      () => undefined,
      () => undefined
    );
    this.sessionLoadQueues.set(params.sessionId, queueTail);

    try {
      return await load;
    } finally {
      if (this.sessionLoadQueues.get(params.sessionId) === queueTail) {
        this.sessionLoadQueues.delete(params.sessionId);
      }
    }
  }

  private async replaceSession(
    params: acp.LoadSessionRequest
  ): Promise<acp.LoadSessionResponse> {
    this.assertNotDestroyed();
    const existingSession = this.sessions.get(params.sessionId);
    if (existingSession) {
      try {
        await existingSession.destroy();
      } finally {
        if (this.sessions.get(params.sessionId) === existingSession) {
          this.sessions.delete(params.sessionId);
        }
      }
    }
    const messages = await SessionService.loadSession(params.sessionId, params.cwd);

    const session = new AcpSession(
      params.sessionId,
      params.cwd,
      this.connection,
      this.clientCapabilities,
      { initialMessages: messages, mcpServers: params.mcpServers }
    );

    try {
      await session.initialize();
      await session.replayHistory();
      this.assertNotDestroyed();
    } catch (error) {
      await session.destroy().catch(() => undefined);
      throw error;
    }

    this.sessions.set(params.sessionId, session);
    session.sendAvailableCommandsDelayed();

    return this.buildSessionSetup(session.getCurrentModelId());
  }

  private buildChildSessionResponse(
    sessionId: string,
    taskMetadata?: SessionMetadata,
    selectedModelId?: string
  ): acp.NewSessionResponse & acp.ForkSessionResponse {
    return {
      sessionId,
      ...this.buildSessionSetup(selectedModelId),
      ...(taskMetadata
        ? {
            _meta: {
              'blade/taskIsolation': taskMetadata.taskIsolation,
              'blade/taskSourceProjectPath': taskMetadata.taskSourceProjectPath,
              'blade/taskProjectPath': taskMetadata.projectPath,
              ...(taskMetadata.taskModelId
                ? { 'blade/taskModelId': taskMetadata.taskModelId }
                : {}),
              ...(taskMetadata.taskRetryAvailable
                ? { 'blade/taskRetryAvailable': true }
                : {}),
              ...(taskMetadata.taskRetriedFrom
                ? { 'blade/taskRetriedFrom': taskMetadata.taskRetriedFrom }
                : {}),
              ...(taskMetadata.taskDelivery
                ? { 'blade/taskDelivery': taskMetadata.taskDelivery }
                : {}),
              ...(taskMetadata.taskWorktreeBranch
                ? {
                    'blade/taskWorktreeBranch': taskMetadata.taskWorktreeBranch,
                  }
                : {}),
              ...(taskMetadata.taskBaseCommit
                ? { 'blade/taskBaseCommit': taskMetadata.taskBaseCommit }
                : {}),
            },
          }
        : {}),
    };
  }

  private assertNotDestroyed(): void {
    if (this.destroyed) throw new Error('BladeAgent is destroyed');
  }

  private buildSessionSetup(selectedModelId?: string): acp.LoadSessionResponse {
    const config = getConfig();
    const models = config?.models || [];
    const currentModelId =
      (selectedModelId && models.some((model) => model.id === selectedModelId)
        ? selectedModelId
        : undefined) ??
      config?.currentModelId ??
      models[0]?.id;

    const availableModes: acp.SessionMode[] = [
      {
        id: 'default',
        name: 'Default',
        description: 'Ask for confirmation before all file edits and commands',
      },
      {
        id: 'auto-edit',
        name: 'Auto Edit',
        description: 'Auto-approve file edits, ask for shell commands',
      },
      {
        id: 'yolo',
        name: 'Full Auto',
        description: 'Auto-approve everything without confirmation',
      },
      {
        id: 'plan',
        name: 'Plan Only',
        description: 'Read-only mode, no file changes or commands',
      },
    ];

    const configOptions: acp.SessionConfigOption[] = [];
    if (models.length > 0) {
      configOptions.push({
        type: 'select',
        id: 'model',
        name: 'Model',
        description: 'Active language model',
        category: 'model',
        currentValue: currentModelId,
        options: models.map((m) => ({
          value: m.id,
          name: getModelDisplayName(m),
          description: `${m.provider}/${m.model}`,
        })),
      });
    }

    return {
      modes: {
        availableModes,
        currentModeId: 'default',
      },
      configOptions: configOptions.length > 0 ? configOptions : undefined,
    };
  }

  /**
   * 处理提示请求
   */
  async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      throw new Error(`Session not found: ${params.sessionId}`);
    }

    return session.prompt(params);
  }

  /**
   * 取消当前操作
   */
  async cancel(params: acp.CancelNotification): Promise<void> {
    logger.info(
      `[BladeAgent] Cancel notification received for session: ${params.sessionId}`
    );
    const session = this.sessions.get(params.sessionId);
    if (session) {
      logger.info(`[BladeAgent] Found session, calling session.cancel()`);
      session.cancel();
    } else {
      logger.warn(`[BladeAgent] Session not found for cancel: ${params.sessionId}`);
    }
  }

  /**
   * 设置会话模式（权限模式）
   */
  async setSessionMode(
    params: acp.SetSessionModeRequest
  ): Promise<acp.SetSessionModeResponse> {
    logger.info(`[BladeAgent] Setting session mode: ${params.modeId}`);
    const session = this.sessions.get(params.sessionId);
    if (session) {
      await session.setMode(params.modeId);
    }
    return {};
  }

  /**
   * 设置会话配置选项（如模型切换）
   */
  async setSessionConfigOption?(
    params: acp.SetSessionConfigOptionRequest
  ): Promise<acp.SetSessionConfigOptionResponse> {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      throw new Error(`Session not found: ${params.sessionId}`);
    }
    if (
      params.configId === 'model' &&
      'value' in params &&
      typeof params.value === 'string'
    ) {
      logger.info(`[BladeAgent] Setting session model: ${params.value}`);
      await session.setModel(params.value);
    }
    return { configOptions: [] };
  }

  /**
   * 清理资源
   */
  async destroy(): Promise<void> {
    this.destroyed = true;
    await Promise.all([...this.sessionLoadQueues.values()]);
    this.sessionLoadQueues.clear();

    let firstError: unknown;
    for (const session of this.sessions.values()) {
      try {
        await session.destroy();
      } catch (error) {
        firstError ??= error;
      }
    }
    this.sessions.clear();
    try {
      await McpRegistry.getInstance().disconnectAll();
    } catch (error) {
      firstError ??= error;
    }
    if (firstError !== undefined) throw firstError;
  }
}
