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
import { SessionService } from '../services/SessionService.js';
import { getModelDisplayName } from '../services/pi/resolveModelConfig.js';
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
    logger.info(`[BladeAgent] Creating new session: ${sessionId}`);
    logger.debug(`[BladeAgent] Session cwd: ${params.cwd || getCwd()}`);

    // 创建会话实例
    const session = new AcpSession(
      sessionId,
      params.cwd || getCwd(),
      this.connection,
      this.clientCapabilities,
      { mcpServers: params.mcpServers }
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

    return this.buildChildSessionResponse(sessionId);
  }

  async unstable_listSessions(
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
    return this.buildChildSessionResponse(fork.sessionId);
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

    return this.buildSessionSetup();
  }

  private buildChildSessionResponse(
    sessionId: string
  ): acp.NewSessionResponse & acp.ForkSessionResponse {
    return { sessionId, ...this.buildSessionSetup() };
  }

  private assertNotDestroyed(): void {
    if (this.destroyed) throw new Error('BladeAgent is destroyed');
  }

  private buildSessionSetup(): acp.LoadSessionResponse {
    // 获取配置中的模型列表
    const config = getConfig();
    const models = config?.models || [];
    const currentModelId = config?.currentModelId || models[0]?.id;

    // 构建可用模型列表（不稳定 API）
    const availableModels: acp.ModelInfo[] = models.map((m) => ({
      modelId: m.id,
      name: getModelDisplayName(m),
      description: `${m.provider}/${m.model}`,
    }));

    // 构建可用模式列表（权限模式）
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

    return {
      // 返回可用模式（权限控制）
      modes: {
        availableModes,
        currentModeId: 'default',
      },
      // 返回可用模型（不稳定 API）
      models:
        availableModels.length > 0
          ? {
              availableModels,
              currentModelId,
            }
          : undefined,
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
   * 设置会话模型（不稳定 API）
   */
  async unstable_setSessionModel?(
    params: acp.SetSessionModelRequest
  ): Promise<acp.SetSessionModelResponse> {
    logger.info(`[BladeAgent] Setting session model: ${params.modelId}`);
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      throw new Error(`Session not found: ${params.sessionId}`);
    }
    await session.setModel(params.modelId);
    return {};
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
