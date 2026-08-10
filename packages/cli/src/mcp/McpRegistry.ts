import { EventEmitter } from 'events';
import type { McpServerConfig } from '../config/types.js';
import type { Tool } from '../tools/types/index.js';
import type { McpOAuthLoginHandle, McpOAuthStatus } from './auth/index.js';
import { createMcpTool } from './createMcpTool.js';
import {
  McpClient,
  type McpClientContentCatalogChange,
  type McpClientRuntimeOptions,
  type McpClientToolCatalogChange,
  type McpInteractionContext,
} from './McpClient.js';
import type {
  McpCompletionInput,
  McpNormalizedCompletionResult,
} from './McpCompletion.js';
import type {
  McpClientConnectionLifecycleChange,
  McpRecoveryPhase,
  McpRecoveryReason,
} from './McpConnectionRecovery.js';
import type {
  McpContentCatalogKind,
  McpContentCatalogSnapshot,
  McpNormalizedPromptResult,
  McpNormalizedResourceResult,
  McpPromptDefinition,
  McpResourceDefinition,
  McpResourceTemplateDefinition,
} from './McpContentCatalog.js';
import {
  MAX_MCP_LOG_ENTRIES_PER_SERVER,
  MAX_MCP_LOG_ENTRIES_PER_SESSION,
  type McpClientLogEntry,
  type McpLoggingPolicy,
  type McpLogLevel,
} from './McpLogging.js';
import {
  fitMcpInstructionToSessionBudget,
  MAX_MCP_INSTRUCTION_BYTES_PER_SESSION,
  type McpServerInstruction,
} from './McpServerInstructions.js';
import { McpTaskManager } from './McpTaskManager.js';
import type { McpTaskOwner, McpTaskSnapshot } from './McpTasks.js';
import {
  createMcpProviderToolName,
  hasMcpCatalogChanges,
  type McpToolCatalogDelta,
} from './McpToolCatalog.js';
import { McpConnectionStatus, type McpToolDefinition } from './types.js';

/**
 * MCP服务器信息
 */
export interface McpServerInfo {
  config: McpServerConfig;
  client: McpClient;
  status: McpConnectionStatus;
  connectedAt?: Date;
  lastError?: Error;
  recovery?: McpClientConnectionLifecycleChange;
  tools: McpToolDefinition[];
  contentCatalog: McpContentCatalogSnapshot;
  logging: McpLoggingPolicy;
  instructions?: McpServerInstruction;
}

export interface McpCatalogChange extends McpToolCatalogDelta {
  revision: number;
  serverName: string;
  reason: McpClientToolCatalogChange['reason'] | 'connection' | 'disconnection';
  tools: Tool[];
}

export interface McpContentCatalogChange {
  revision: number;
  serverName: string;
  kind: McpContentCatalogKind;
  reason: McpClientContentCatalogChange['reason'] | 'connection' | 'disconnection';
  added: string[];
  removed: string[];
  updated: string[];
}

export interface McpResourceUpdated {
  revision: number;
  serverName: string;
  uri: string;
}

export interface McpConnectionLifecycleChange {
  revision: number;
  serverName: string;
  phase: McpRecoveryPhase;
  reason: McpRecoveryReason;
  attempt: number;
  maxAttempts: number;
  nextRetryAt?: number;
  error?: string;
}

export interface McpLogEntry extends McpClientLogEntry {
  revision: number;
  serverName: string;
}

export interface McpLogSnapshot {
  revision: number;
  entries: McpLogEntry[];
}

export interface McpRegisteredInstruction extends McpServerInstruction {
  serverName: string;
}

export interface McpInstructionsSnapshot {
  revision: number;
  instructions: McpRegisteredInstruction[];
}

export interface McpInstructionsChange {
  revision: number;
  serverName: string;
  action: 'added' | 'removed';
  reason: 'connection' | 'disconnection';
  instruction?: McpServerInstruction;
}

export type McpRegisteredResource = McpResourceDefinition & { server: string };
export type McpRegisteredResourceTemplate = McpResourceTemplateDefinition & {
  server: string;
};
export type McpRegisteredPrompt = McpPromptDefinition & { server: string };

/**
 * MCP注册表
 * 管理MCP服务器连接和工具发现
 */
export class McpRegistry extends EventEmitter {
  private static instance: McpRegistry | null = null;
  private servers: Map<string, McpServerInfo> = new Map();
  private isDiscovering = false;
  private catalogRevision = 0;
  private contentCatalogRevision = 0;
  private connectionRevision = 0;
  private logRevision = 0;
  private instructionsRevision = 0;
  private logEntries: McpLogEntry[] = [];
  private projectedTools = new Map<string, Tool>();

  private constructor(private readonly runtimeOptions: McpClientRuntimeOptions = {}) {
    super();
  }

  /**
   * 获取单例实例
   */
  static getInstance(): McpRegistry {
    if (!McpRegistry.instance) {
      McpRegistry.instance = new McpRegistry();
    }
    return McpRegistry.instance;
  }

  /**
   * 创建由单个 runtime 独占的注册表，避免会话级 MCP 配置污染全局实例。
   */
  static createIsolated(runtimeOptions: McpClientRuntimeOptions = {}): McpRegistry {
    return new McpRegistry(runtimeOptions);
  }

  /**
   * 注册MCP服务器
   */
  async registerServer(
    name: string,
    config: McpServerConfig,
    options: { connect?: boolean } = {}
  ): Promise<void> {
    if (this.servers.has(name)) {
      throw new Error(`MCP服务器 "${name}" 已经注册`);
    }

    const client = new McpClient(config, name, config.healthCheck, this.runtimeOptions);
    const serverInfo: McpServerInfo = {
      config,
      client,
      status: McpConnectionStatus.DISCONNECTED,
      tools: [],
      contentCatalog: {
        resources: [],
        resourceTemplates: [],
        prompts: [],
      },
      logging: client.logging,
    };

    // 设置客户端事件处理器
    this.setupClientEventHandlers(client, serverInfo, name);

    this.servers.set(name, serverInfo);
    this.emit('serverRegistered', name, serverInfo);

    if (options.connect === false) return;
    try {
      await this.connectServer(name);
    } catch (error) {
      console.warn(`MCP服务器 "${name}" 连接失败:`, error);
    }
  }

  /**
   * 注销MCP服务器
   */
  async unregisterServer(name: string): Promise<void> {
    const serverInfo = this.servers.get(name);
    if (!serverInfo) {
      return;
    }

    try {
      await McpTaskManager.getInstance().cancelClient(serverInfo.client);
      await serverInfo.client.disconnect();
    } catch (error) {
      console.warn(`断开MCP服务器 "${name}" 时出错:`, error);
    }

    this.servers.delete(name);
    this.logEntries = this.logEntries.filter((entry) => entry.serverName !== name);
    this.emit('serverUnregistered', name);
  }

  /**
   * 连接到指定服务器
   */
  async connectServer(name: string): Promise<void> {
    const serverInfo = this.servers.get(name);
    if (!serverInfo) {
      throw new Error(`MCP服务器 "${name}" 未注册`);
    }

    if (serverInfo.status === McpConnectionStatus.CONNECTED) {
      return;
    }

    try {
      serverInfo.status = McpConnectionStatus.CONNECTING;
      await serverInfo.client.connect();
      serverInfo.connectedAt = new Date();
      serverInfo.lastError = undefined;
      serverInfo.tools = serverInfo.client.availableTools;
    } catch (error) {
      serverInfo.lastError = error as Error;
      serverInfo.status = McpConnectionStatus.ERROR;
      throw error;
    }
  }

  /**
   * 断开指定服务器
   */
  async disconnectServer(name: string): Promise<void> {
    const serverInfo = this.servers.get(name);
    if (!serverInfo) {
      return;
    }

    await McpTaskManager.getInstance().cancelClient(serverInfo.client);
    await serverInfo.client.disconnect();
    serverInfo.connectedAt = undefined;
  }

  /**
   * 重连指定服务器（用于从 ERROR 状态恢复）
   * 这个方法可以在首次连接失败或意外断开后使用
   */
  async reconnectServer(name: string): Promise<void> {
    const serverInfo = this.servers.get(name);
    if (!serverInfo) {
      throw new Error(`MCP服务器 "${name}" 未注册`);
    }

    await McpTaskManager.getInstance().cancelClient(serverInfo.client);
    await serverInfo.client.disconnect();

    // 尝试重新连接
    try {
      serverInfo.status = McpConnectionStatus.CONNECTING;
      await serverInfo.client.connect();
      serverInfo.connectedAt = new Date();
      serverInfo.lastError = undefined;
      serverInfo.tools = serverInfo.client.availableTools;
    } catch (error) {
      serverInfo.lastError = error as Error;
      serverInfo.status = McpConnectionStatus.ERROR;
      throw error;
    }
  }

  /**
   * 获取所有可用工具。
   *
   * 工具始终使用 mcp__<server>__<tool> provider 名称。
   */
  async getAvailableTools(): Promise<Tool[]> {
    return [...this.projectedTools.values()];
  }

  getCatalogSnapshot(): {
    revision: number;
    tools: Tool[];
  } {
    return {
      revision: this.catalogRevision,
      tools: [...this.projectedTools.values()],
    };
  }

  async waitForCatalogIdle(): Promise<void> {
    await Promise.all(
      [...this.servers.values()].map((server) => server.client.waitForCatalogRefresh())
    );
  }

  getContentCatalogSnapshot(): {
    revision: number;
    resources: McpRegisteredResource[];
    resourceTemplates: McpRegisteredResourceTemplate[];
    prompts: McpRegisteredPrompt[];
  } {
    const resources: McpRegisteredResource[] = [];
    const resourceTemplates: McpRegisteredResourceTemplate[] = [];
    const prompts: McpRegisteredPrompt[] = [];
    for (const [server, info] of this.servers) {
      if (info.status !== McpConnectionStatus.CONNECTED) continue;
      resources.push(
        ...info.contentCatalog.resources.map((resource) => ({
          server,
          ...structuredClone(resource),
        }))
      );
      resourceTemplates.push(
        ...info.contentCatalog.resourceTemplates.map((template) => ({
          server,
          ...structuredClone(template),
        }))
      );
      prompts.push(
        ...info.contentCatalog.prompts.map((prompt) => ({
          server,
          ...structuredClone(prompt),
        }))
      );
    }
    return {
      revision: this.contentCatalogRevision,
      resources,
      resourceTemplates,
      prompts,
    };
  }

  getLogSnapshot(
    serverName?: string,
    options: { afterRevision?: number; limit?: number } = {}
  ): McpLogSnapshot {
    const afterRevision =
      Number.isSafeInteger(options.afterRevision) && (options.afterRevision ?? 0) >= 0
        ? (options.afterRevision ?? 0)
        : 0;
    const limit =
      Number.isSafeInteger(options.limit) &&
      (options.limit ?? 0) >= 1 &&
      (options.limit ?? 0) <= MAX_MCP_LOG_ENTRIES_PER_SESSION
        ? (options.limit ?? MAX_MCP_LOG_ENTRIES_PER_SESSION)
        : MAX_MCP_LOG_ENTRIES_PER_SESSION;
    const entries = this.logEntries
      .filter(
        (entry) =>
          entry.revision > afterRevision &&
          (!serverName || entry.serverName === serverName)
      )
      .slice(-limit)
      .map((entry) => structuredClone(entry));
    return {
      revision: this.logRevision,
      entries,
    };
  }

  getInstructionsSnapshot(): McpInstructionsSnapshot {
    const instructions: McpRegisteredInstruction[] = [];
    for (const [serverName, server] of this.servers) {
      if (server.status !== McpConnectionStatus.CONNECTED || !server.instructions) {
        continue;
      }
      instructions.push({
        serverName,
        ...structuredClone(server.instructions),
      });
    }
    instructions.sort((left, right) => left.serverName.localeCompare(right.serverName));
    return {
      revision: this.instructionsRevision,
      instructions,
    };
  }

  async refreshContentCatalogs(serverName?: string): Promise<void> {
    if (serverName) {
      const server = this.requireConnectedServer(serverName);
      await server.client.refreshContentCatalogs('manual');
      return;
    }
    await Promise.all(
      [...this.servers.values()]
        .filter((server) => server.status === McpConnectionStatus.CONNECTED)
        .map((server) => server.client.refreshContentCatalogs('manual'))
    );
  }

  async readResource(
    serverName: string,
    uri: string
  ): Promise<McpNormalizedResourceResult> {
    return this.requireConnectedServer(serverName).client.readResource(uri);
  }

  async getPrompt(
    serverName: string,
    name: string,
    arguments_: Record<string, string> = {}
  ): Promise<McpNormalizedPromptResult> {
    return this.requireConnectedServer(serverName).client.getPrompt(name, arguments_);
  }

  async complete(
    serverName: string,
    input: McpCompletionInput,
    signal?: AbortSignal
  ): Promise<McpNormalizedCompletionResult> {
    return this.requireConnectedServer(serverName).client.complete(input, signal);
  }

  async startTask(
    serverName: string,
    toolName: string,
    arguments_: Record<string, unknown>,
    owner: McpTaskOwner,
    interactionContext: McpInteractionContext,
    signal?: AbortSignal,
    ttlMs?: number
  ): Promise<McpTaskSnapshot> {
    const server = this.requireConnectedServer(serverName);
    if (!server.tools.some((tool) => tool.name === toolName)) {
      throw new Error(
        `MCP tool "${toolName}" is not present in server "${serverName}" catalog`
      );
    }
    return McpTaskManager.getInstance().start({
      client: server.client,
      serverName,
      toolName,
      arguments: arguments_,
      owner,
      interactionContext,
      signal,
      ttlMs,
    });
  }

  listTasks(owner: McpTaskOwner, serverName?: string): McpTaskSnapshot[] {
    return McpTaskManager.getInstance().list(owner, serverName);
  }

  getTask(taskId: string, owner: McpTaskOwner): McpTaskSnapshot | undefined {
    return McpTaskManager.getInstance().get(taskId, owner);
  }

  waitForTask(
    taskId: string,
    owner: McpTaskOwner,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<McpTaskSnapshot | undefined> {
    return McpTaskManager.getInstance().wait(taskId, owner, timeoutMs, signal);
  }

  cancelTask(
    taskId: string,
    owner: McpTaskOwner,
    signal?: AbortSignal
  ): Promise<McpTaskSnapshot | undefined> {
    return McpTaskManager.getInstance().cancel(taskId, owner, signal);
  }

  async setResourceSubscription(
    serverName: string,
    uri: string,
    subscribe: boolean
  ): Promise<void> {
    await this.requireConnectedServer(serverName).client.setResourceSubscription(
      uri,
      subscribe
    );
  }

  async setServerLoggingLevel(serverName: string, level: McpLogLevel): Promise<void> {
    const server = this.requireConnectedServer(serverName);
    await server.client.setLoggingLevel(level);
    server.logging = server.client.logging;
  }

  /**
   * 根据名称查找工具
   */
  async findTool(toolName: string): Promise<Tool | null> {
    return this.projectedTools.get(toolName) ?? null;
  }

  /**
   * 按服务器获取工具
   */
  getToolsByServer(serverName: string): Tool[] {
    const serverInfo = this.servers.get(serverName);
    if (!serverInfo || serverInfo.status !== McpConnectionStatus.CONNECTED) {
      return [];
    }

    return serverInfo.tools.map((mcpTool) =>
      createMcpTool(
        serverInfo.client,
        serverName,
        mcpTool,
        createMcpProviderToolName(serverName, mcpTool.name),
        this.runtimeOptions.artifactWriter
      )
    );
  }

  /**
   * 获取服务器状态
   */
  getServerStatus(name: string): McpServerInfo | null {
    return this.servers.get(name) || null;
  }

  /**
   * 获取所有服务器信息
   */
  getAllServers(): Map<string, McpServerInfo> {
    return new Map(this.servers);
  }

  async getServerOAuthStatus(name: string): Promise<McpOAuthStatus> {
    const serverInfo = this.servers.get(name);
    if (!serverInfo) {
      throw new Error(`MCP服务器 "${name}" 未注册`);
    }
    return serverInfo.client.getOAuthStatus();
  }

  async beginOAuthLogin(
    name: string,
    options: { openBrowser?: boolean } = {}
  ): Promise<McpOAuthLoginHandle> {
    const serverInfo = this.servers.get(name);
    if (!serverInfo) {
      throw new Error(`MCP服务器 "${name}" 未注册`);
    }
    const handle = await serverInfo.client.beginOAuthLogin(options);
    this.emit('serverOAuthStatusChanged', name, 'authorizing');
    const completion = handle.completion.then(
      async () => {
        this.emit('serverOAuthCompleted', name);
        this.emit('serverOAuthStatusChanged', name, 'authenticated');
        try {
          await this.reconnectServer(name);
        } catch (error) {
          serverInfo.lastError =
            error instanceof Error ? error : new Error(String(error));
          serverInfo.status = McpConnectionStatus.ERROR;
          this.emit('serverError', name, serverInfo.lastError);
        }
      },
      (error) => {
        serverInfo.lastError =
          error instanceof Error ? error : new Error(String(error));
        this.emit('serverOAuthError', name, serverInfo.lastError);
        this.emit('serverOAuthStatusChanged', name, 'error');
        throw serverInfo.lastError;
      }
    );
    void completion.catch(() => undefined);
    return { ...handle, completion };
  }

  async logoutOAuth(name: string): Promise<void> {
    const serverInfo = this.servers.get(name);
    if (!serverInfo) {
      throw new Error(`MCP服务器 "${name}" 未注册`);
    }
    await serverInfo.client.logoutOAuth();
    serverInfo.status = McpConnectionStatus.DISCONNECTED;
    serverInfo.connectedAt = undefined;
    serverInfo.lastError = undefined;
    serverInfo.tools = [];
    this.emit('serverOAuthStatusChanged', name, 'unauthenticated');
  }

  /**
   * 刷新所有服务器工具列表
   */
  async refreshAllTools(): Promise<void> {
    const refreshPromises: Promise<void>[] = [];

    for (const [serverName, serverInfo] of this.servers) {
      if (serverInfo.status === McpConnectionStatus.CONNECTED) {
        refreshPromises.push(this.refreshServerTools(serverName));
      }
    }

    await Promise.allSettled(refreshPromises);
  }

  /**
   * 刷新指定服务器工具列表
   */
  async refreshServerTools(name: string): Promise<void> {
    const serverInfo = this.servers.get(name);
    if (!serverInfo || serverInfo.status !== McpConnectionStatus.CONNECTED) {
      return;
    }

    try {
      await serverInfo.client.refreshTools('manual');
    } catch (error) {
      console.warn(`刷新服务器 "${name}" 工具列表失败:`, error);
      throw error;
    }
  }

  /**
   * 设置客户端事件处理器
   */
  private setupClientEventHandlers(
    client: McpClient,
    serverInfo: McpServerInfo,
    name: string
  ): void {
    client.on('connected', (server) => {
      serverInfo.status = McpConnectionStatus.CONNECTED;
      serverInfo.connectedAt = new Date();
      serverInfo.lastError = undefined;
      serverInfo.tools = client.availableTools;
      serverInfo.contentCatalog = client.contentCatalog;
      serverInfo.logging = client.logging;
      serverInfo.instructions = this.fitInstructionBudget(name, client.instructions);
      this.publishCatalog(name, 'connection');
      this.publishInitialContentCatalog(name, serverInfo.contentCatalog);
      if (serverInfo.instructions) {
        this.publishInstructions(name, 'added', 'connection', serverInfo.instructions);
      }
      this.emit('serverConnected', name, server);
    });

    client.on('disconnected', () => {
      serverInfo.status = McpConnectionStatus.DISCONNECTED;
      serverInfo.connectedAt = undefined;
      serverInfo.lastError = undefined;
      serverInfo.recovery = undefined;
      this.invalidateServerProjection(name, serverInfo);
      this.emit('serverDisconnected', name);
    });

    client.on('error', (error) => {
      serverInfo.status = McpConnectionStatus.ERROR;
      serverInfo.lastError = error;
      this.invalidateServerProjection(name, serverInfo);
      this.emit('serverError', name, error);
    });

    client.on(
      'connectionLifecycleChanged',
      (change: McpClientConnectionLifecycleChange) => {
        serverInfo.recovery = structuredClone(change);
        if (change.phase === 'reconnecting') {
          serverInfo.status = McpConnectionStatus.RECONNECTING;
          serverInfo.connectedAt = undefined;
          serverInfo.lastError = change.error
            ? new Error(change.error)
            : serverInfo.lastError;
          this.invalidateServerProjection(name, serverInfo);
        } else if (change.phase === 'recovered') {
          serverInfo.status = McpConnectionStatus.CONNECTED;
          serverInfo.lastError = undefined;
        } else {
          serverInfo.status = McpConnectionStatus.ERROR;
          serverInfo.connectedAt = undefined;
          serverInfo.lastError = change.error
            ? new Error(change.error)
            : serverInfo.lastError;
        }
        this.publishConnectionLifecycle(name, change);
      }
    );

    client.on(
      'toolsUpdated',
      (tools, change: McpClientToolCatalogChange | undefined) => {
        const oldToolsCount = serverInfo.tools.length;
        serverInfo.tools = tools;
        if (serverInfo.status === McpConnectionStatus.CONNECTED && change) {
          this.publishCatalog(name, change.reason);
        }
        this.emit('toolsUpdated', name, tools, oldToolsCount);
      }
    );
    client.on('toolsRefreshFailed', (details) => {
      this.emit('catalogRefreshFailed', {
        serverName: name,
        ...details,
      });
    });
    client.on(
      'contentCatalogUpdated',
      (snapshot: McpContentCatalogSnapshot, change: McpClientContentCatalogChange) => {
        serverInfo.contentCatalog = snapshot;
        if (serverInfo.status !== McpConnectionStatus.CONNECTED) return;
        this.publishContentCatalogChange(name, change.kind, change.reason, {
          added: change.added,
          removed: change.removed,
          updated: change.updated,
        });
      }
    );
    client.on('contentCatalogRefreshFailed', (details) => {
      this.emit('contentCatalogRefreshFailed', {
        serverName: name,
        ...details,
      });
    });
    client.on('resourceUpdated', (details: { serverName: string; uri: string }) => {
      if (serverInfo.status !== McpConnectionStatus.CONNECTED) return;
      this.contentCatalogRevision++;
      const update: McpResourceUpdated = {
        revision: this.contentCatalogRevision,
        serverName: name,
        uri: details.uri,
      };
      this.emit('resourceUpdated', update);
    });

    client.on('statusChanged', (newStatus, oldStatus) => {
      serverInfo.status = newStatus;
      if (
        newStatus === McpConnectionStatus.RECONNECTING &&
        oldStatus === McpConnectionStatus.CONNECTED
      ) {
        serverInfo.connectedAt = undefined;
        this.invalidateServerProjection(name, serverInfo);
      }
      this.emit('serverStatusChanged', name, newStatus, oldStatus);
    });
    client.on('loggingLevelChanged', () => {
      serverInfo.logging = client.logging;
      this.emit('serverLoggingLevelChanged', name, serverInfo.logging.level);
    });
    client.on('log', (entry: McpClientLogEntry) => {
      this.publishLog(name, entry);
    });
  }

  private publishLog(serverName: string, entry: McpClientLogEntry): void {
    this.logRevision++;
    const projected: McpLogEntry = {
      revision: this.logRevision,
      serverName,
      ...structuredClone(entry),
    };
    this.logEntries.push(projected);
    let serverEntries = 0;
    for (let index = this.logEntries.length - 1; index >= 0; index--) {
      if (this.logEntries[index]?.serverName !== serverName) continue;
      serverEntries++;
      if (serverEntries > MAX_MCP_LOG_ENTRIES_PER_SERVER) {
        this.logEntries.splice(index, 1);
      }
    }
    while (this.logEntries.length > MAX_MCP_LOG_ENTRIES_PER_SESSION) {
      this.logEntries.shift();
    }
    this.emit('log', structuredClone(projected));
  }

  private invalidateServerProjection(name: string, serverInfo: McpServerInfo): void {
    const previousContent = serverInfo.contentCatalog;
    const hadInstructions = serverInfo.instructions !== undefined;
    serverInfo.tools = [];
    serverInfo.contentCatalog = {
      resources: [],
      resourceTemplates: [],
      prompts: [],
    };
    serverInfo.instructions = undefined;
    this.publishCatalog(name, 'disconnection');
    this.publishRemovedContentCatalog(name, previousContent);
    if (hadInstructions) {
      this.publishInstructions(name, 'removed', 'disconnection');
    }
  }

  private fitInstructionBudget(
    serverName: string,
    instruction: McpServerInstruction | undefined
  ): McpServerInstruction | undefined {
    if (!instruction) return undefined;
    let usedBytes = 0;
    for (const [name, server] of this.servers) {
      if (name === serverName) continue;
      usedBytes += server.instructions?.projectedBytes ?? 0;
    }
    return fitMcpInstructionToSessionBudget(
      instruction,
      Math.max(0, MAX_MCP_INSTRUCTION_BYTES_PER_SESSION - usedBytes)
    );
  }

  private publishInstructions(
    serverName: string,
    action: McpInstructionsChange['action'],
    reason: McpInstructionsChange['reason'],
    instruction?: McpServerInstruction
  ): void {
    this.instructionsRevision++;
    const change: McpInstructionsChange = {
      revision: this.instructionsRevision,
      serverName,
      action,
      reason,
      ...(instruction ? { instruction: structuredClone(instruction) } : {}),
    };
    this.emit('instructionsChanged', change);
  }

  private publishConnectionLifecycle(
    serverName: string,
    change: McpClientConnectionLifecycleChange
  ): void {
    this.connectionRevision++;
    const event: McpConnectionLifecycleChange = {
      revision: this.connectionRevision,
      serverName,
      ...structuredClone(change),
    };
    this.emit('connectionLifecycleChanged', event);
  }

  private publishCatalog(serverName: string, reason: McpCatalogChange['reason']): void {
    const next = new Map<string, Tool>();
    for (const [name, serverInfo] of this.servers) {
      if (serverInfo.status !== McpConnectionStatus.CONNECTED) continue;
      for (const definition of serverInfo.tools) {
        const providerName = createMcpProviderToolName(name, definition.name);
        if (next.has(providerName)) {
          throw new Error(`Duplicate projected MCP tool "${providerName}"`);
        }
        next.set(
          providerName,
          createMcpTool(
            serverInfo.client,
            name,
            definition,
            providerName,
            this.runtimeOptions.artifactWriter
          )
        );
      }
    }

    const previousSignatures = new Map(
      [...this.projectedTools].map(([name, tool]) => [
        name,
        JSON.stringify(tool.getFunctionDeclaration()),
      ])
    );
    const nextSignatures = new Map(
      [...next].map(([name, tool]) => [
        name,
        JSON.stringify(tool.getFunctionDeclaration()),
      ])
    );
    const delta: McpToolCatalogDelta = {
      added: [...next.keys()].filter((name) => !this.projectedTools.has(name)).sort(),
      removed: [...this.projectedTools.keys()].filter((name) => !next.has(name)).sort(),
      updated: [...next.keys()]
        .filter(
          (name) =>
            this.projectedTools.has(name) &&
            previousSignatures.get(name) !== nextSignatures.get(name)
        )
        .sort(),
    };
    this.projectedTools = next;
    if (!hasMcpCatalogChanges(delta)) return;

    this.catalogRevision++;
    const change: McpCatalogChange = {
      revision: this.catalogRevision,
      serverName,
      reason,
      tools: [...next.values()],
      ...delta,
    };
    this.emit('catalogChanged', change);
  }

  private publishInitialContentCatalog(
    serverName: string,
    snapshot: McpContentCatalogSnapshot
  ): void {
    this.publishContentCatalogChange(serverName, 'resources', 'connection', {
      added: snapshot.resources.map((resource) => resource.uri).sort(),
      removed: [],
      updated: [],
    });
    this.publishContentCatalogChange(serverName, 'resourceTemplates', 'connection', {
      added: snapshot.resourceTemplates.map((template) => template.uriTemplate).sort(),
      removed: [],
      updated: [],
    });
    this.publishContentCatalogChange(serverName, 'prompts', 'connection', {
      added: snapshot.prompts.map((prompt) => prompt.name).sort(),
      removed: [],
      updated: [],
    });
  }

  private publishRemovedContentCatalog(
    serverName: string,
    snapshot: McpContentCatalogSnapshot
  ): void {
    this.publishContentCatalogChange(serverName, 'resources', 'disconnection', {
      added: [],
      removed: snapshot.resources.map((resource) => resource.uri).sort(),
      updated: [],
    });
    this.publishContentCatalogChange(serverName, 'resourceTemplates', 'disconnection', {
      added: [],
      removed: snapshot.resourceTemplates
        .map((template) => template.uriTemplate)
        .sort(),
      updated: [],
    });
    this.publishContentCatalogChange(serverName, 'prompts', 'disconnection', {
      added: [],
      removed: snapshot.prompts.map((prompt) => prompt.name).sort(),
      updated: [],
    });
  }

  private publishContentCatalogChange(
    serverName: string,
    kind: McpContentCatalogKind,
    reason: McpContentCatalogChange['reason'],
    delta: Pick<McpContentCatalogChange, 'added' | 'removed' | 'updated'>
  ): void {
    if (
      delta.added.length === 0 &&
      delta.removed.length === 0 &&
      delta.updated.length === 0
    ) {
      return;
    }
    this.contentCatalogRevision++;
    const change: McpContentCatalogChange = {
      revision: this.contentCatalogRevision,
      serverName,
      kind,
      reason,
      ...delta,
    };
    this.emit('contentCatalogChanged', change);
  }

  private requireConnectedServer(name: string): McpServerInfo {
    const server = this.servers.get(name);
    if (!server) throw new Error(`MCP服务器 "${name}" 未注册`);
    if (server.status !== McpConnectionStatus.CONNECTED) {
      throw new Error(`MCP服务器 "${name}" 未连接`);
    }
    return server;
  }

  /**
   * 自动发现MCP服务器 (基础实现，可扩展)
   */
  async discoverServers(): Promise<McpServerInfo[]> {
    if (this.isDiscovering) {
      return Array.from(this.servers.values());
    }

    this.isDiscovering = true;
    this.emit('discoveryStarted');

    try {
      // 这里可以实现自动发现逻辑
      // 例如扫描常见的MCP服务器安装位置
      // 或者读取配置文件中的服务器列表

      // 目前返回已注册的服务器
      return Array.from(this.servers.values());
    } finally {
      this.isDiscovering = false;
      this.emit('discoveryCompleted');
    }
  }

  /**
   * 批量注册服务器
   */
  async registerServers(servers: Record<string, McpServerConfig>): Promise<void> {
    const registrationPromises = Object.entries(servers).map(([name, config]) =>
      this.registerServer(name, config).catch((error) => {
        console.warn(`注册MCP服务器 "${name}" 失败:`, error);
        return error;
      })
    );

    await Promise.allSettled(registrationPromises);
  }

  /**
   * 获取统计信息
   */
  getStatistics() {
    let connectedCount = 0;
    let totalTools = 0;
    let errorCount = 0;

    for (const serverInfo of this.servers.values()) {
      if (serverInfo.status === McpConnectionStatus.CONNECTED) {
        connectedCount++;
        totalTools += serverInfo.tools.length;
      } else if (serverInfo.status === McpConnectionStatus.ERROR) {
        errorCount++;
      }
    }

    return {
      totalServers: this.servers.size,
      connectedServers: connectedCount,
      errorServers: errorCount,
      totalTools,
      isDiscovering: this.isDiscovering,
    };
  }

  /**
   * 断开所有 MCP 服务器连接
   * 在应用退出时调用
   */
  async disconnectAll(): Promise<void> {
    const disconnectPromises: Promise<void>[] = [];

    for (const [name, serverInfo] of this.servers) {
      disconnectPromises.push(
        McpTaskManager.getInstance()
          .cancelClient(serverInfo.client)
          .then(() => serverInfo.client.disconnect())
          .catch((error) => {
            console.warn(`断开 MCP 服务器 "${name}" 时出错:`, error);
          })
      );
    }

    await Promise.allSettled(disconnectPromises);
    this.servers.clear();
    this.projectedTools.clear();
    this.logEntries = [];
  }
}
