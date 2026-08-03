/**
 * Blade ACP Agent 实现
 *
 * 实现 ACP 协议的 Agent 接口，使 Blade 可以被 Zed、JetBrains 等编辑器调用。
 *
 */

import type * as acp from '@agentclientprotocol/sdk';
import {
  type Agent as AcpAgentInterface,
  type AgentSideConnection,
  PROTOCOL_VERSION,
} from '@agentclientprotocol/sdk';
import { createLogger, LogCategory } from '../logging/Logger.js';
import { McpRegistry } from '../mcp/McpRegistry.js';
import { SessionService } from '../services/SessionService.js';
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
  private clientCapabilities: acp.ClientCapabilities | undefined;

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

    return {
      sessionId,
      ...this.buildSessionState(),
    };
  }

  /**
   * 恢复持久化会话并在响应前按协议回放历史。
   */
  async loadSession(params: acp.LoadSessionRequest): Promise<acp.LoadSessionResponse> {
    logger.info(`[BladeAgent] Loading session: ${params.sessionId}`);

    let messages = await SessionService.loadSession(params.sessionId, params.cwd);
    const existingSession = this.sessions.get(params.sessionId);
    if (existingSession) {
      await existingSession.destroy();
      this.sessions.delete(params.sessionId);
      messages = await SessionService.loadSession(params.sessionId, params.cwd);
    }

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
    } catch (error) {
      await session.destroy().catch(() => undefined);
      throw error;
    }

    this.sessions.set(params.sessionId, session);
    session.sendAvailableCommandsDelayed();

    return this.buildSessionState();
  }

  private buildSessionState(): acp.LoadSessionResponse {
    // 获取配置中的模型列表
    const config = getConfig();
    const models = config?.models || [];
    const currentModelId = config?.currentModelId || models[0]?.id;

    // 构建可用模型列表（不稳定 API）
    const availableModels: acp.ModelInfo[] = models.map((m) => ({
      modelId: m.id,
      name: m.name || m.id,
      description: m.provider ? `Provider: ${m.provider}` : undefined,
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
    for (const session of this.sessions.values()) {
      await session.destroy();
    }
    this.sessions.clear();
    await McpRegistry.getInstance().disconnectAll();
  }
}
