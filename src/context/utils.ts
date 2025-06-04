import { ContextManager } from './ContextManager.js';
import { CompressedContext, ContextData, ContextManagerOptions, ContextMessage } from './types.js';

/**
 * 创建配置好的上下文管理器
 */
export function createContextManager(options: Partial<ContextManagerOptions> = {}): ContextManager {
  return new ContextManager(options);
}

/**
 * 将上下文数据格式化为适合 Prompt 的字符串
 */
export function formatContextForPrompt(
  context: ContextData,
  compressed?: CompressedContext,
  options: {
    includeSystemInfo?: boolean;
    includeToolHistory?: boolean;
    includeWorkspaceInfo?: boolean;
    maxRecentMessages?: number;
  } = {}
): string {
  const {
    includeSystemInfo = true,
    includeToolHistory = true,
    includeWorkspaceInfo = true,
    maxRecentMessages = 20,
  } = options;

  const sections: string[] = [];

  // 系统信息
  if (includeSystemInfo) {
    const systemInfo = `## 系统信息
角色: ${context.layers.system.role}
能力: ${context.layers.system.capabilities.join('、')}
可用工具: ${context.layers.system.tools.join('、')}`;
    sections.push(systemInfo);
  }

  // 会话信息
  const sessionInfo = `## 会话信息
会话ID: ${context.layers.session.sessionId}
开始时间: ${new Date(context.layers.session.startTime).toLocaleString()}`;
  sections.push(sessionInfo);

  // 工作空间信息
  if (includeWorkspaceInfo && context.layers.workspace.projectPath) {
    const workspaceInfo = `## 工作空间
项目路径: ${context.layers.workspace.projectPath}
当前文件: ${context.layers.workspace.currentFiles.length}个
最近文件: ${context.layers.workspace.recentFiles.slice(0, 5).join('、')}`;
    sections.push(workspaceInfo);
  }

  // 对话历史
  if (compressed) {
    // 使用压缩后的上下文
    const conversationInfo = `## 对话历史摘要
${compressed.summary}

### 关键要点
${compressed.keyPoints.map(point => `- ${point}`).join('\n')}

### 最近消息
${formatMessages(compressed.recentMessages, maxRecentMessages)}`;
    sections.push(conversationInfo);

    // 工具使用摘要
    if (includeToolHistory && compressed.toolSummary) {
      sections.push(`## 工具使用历史\n${compressed.toolSummary}`);
    }
  } else {
    // 使用完整的上下文
    const messages = context.layers.conversation.messages;
    const recentMessages = messages.slice(-maxRecentMessages);

    const conversationInfo = `## 对话历史
总消息数: ${messages.length}
主题: ${context.layers.conversation.topics.join('、')}

### 最近消息
${formatMessages(recentMessages)}`;
    sections.push(conversationInfo);

    // 工具调用历史
    if (includeToolHistory && context.layers.tool.recentCalls.length > 0) {
      const toolHistory = formatToolHistory(context.layers.tool.recentCalls);
      sections.push(`## 工具调用历史\n${toolHistory}`);
    }
  }

  return sections.join('\n\n');
}

/**
 * 格式化消息列表
 */
function formatMessages(messages: ContextMessage[], limit?: number): string {
  const messagesToFormat = limit ? messages.slice(-limit) : messages;

  return messagesToFormat
    .map(msg => {
      const time = new Date(msg.timestamp).toLocaleTimeString();
      const role = getRoleDisplayName(msg.role);
      return `[${time}] ${role}: ${msg.content}`;
    })
    .join('\n');
}

/**
 * 格式化工具调用历史
 */
function formatToolHistory(toolCalls: any[]): string {
  const recentCalls = toolCalls.slice(-10); // 最近10次调用

  return recentCalls
    .map(call => {
      const time = new Date(call.timestamp).toLocaleTimeString();
      const status = call.status === 'success' ? '✅' : '❌';
      return `[${time}] ${status} ${call.name}`;
    })
    .join('\n');
}

/**
 * 获取角色显示名称
 */
function getRoleDisplayName(role: string): string {
  const roleMap: Record<string, string> = {
    user: '用户',
    assistant: '助手',
    system: '系统',
    tool: '工具',
  };

  return roleMap[role] || role;
}

/**
 * 创建默认的上下文管理器配置
 */
export function createDefaultConfig(): ContextManagerOptions {
  return {
    storage: {
      maxMemorySize: 1000,
      persistentPath: './blade-context',
      cacheSize: 100,
      compressionEnabled: true,
    },
    defaultFilter: {
      maxTokens: 4000,
      maxMessages: 50,
      timeWindow: 24 * 60 * 60 * 1000, // 24小时
      priority: 1,
      includeTools: true,
      includeWorkspace: true,
    },
    compressionThreshold: 6000,
    enableVectorSearch: false,
  };
}

/**
 * 验证上下文数据的完整性
 */
export function validateContextData(data: any): data is ContextData {
  if (!data || typeof data !== 'object') {
    return false;
  }

  // 检查必需的层级结构
  const requiredLayers = ['system', 'session', 'conversation', 'tool', 'workspace'];
  const hasAllLayers = requiredLayers.every(
    layer => data.layers && typeof data.layers[layer] === 'object'
  );

  // 检查元数据
  const hasMetadata =
    data.metadata &&
    typeof data.metadata.totalTokens === 'number' &&
    typeof data.metadata.lastUpdated === 'number';

  return hasAllLayers && hasMetadata;
}

/**
 * 计算上下文数据的大小估算
 */
export function estimateContextSize(data: ContextData): {
  totalTokens: number;
  messageCount: number;
  toolCallCount: number;
  memoryUsage: number; // 字节
} {
  const messageCount = data.layers.conversation.messages.length;
  const toolCallCount = data.layers.tool.recentCalls.length;

  // 简单的内存使用估算
  const dataString = JSON.stringify(data);
  const memoryUsage = Buffer.byteLength(dataString, 'utf8');

  // Token 估算（中文按4字符1个token计算）
  let totalChars = 0;
  data.layers.conversation.messages.forEach(msg => {
    totalChars += msg.content.length;
  });

  const totalTokens = Math.ceil(totalChars / 4);

  return {
    totalTokens,
    messageCount,
    toolCallCount,
    memoryUsage,
  };
}

/**
 * 创建空的上下文数据结构
 */
export function createEmptyContext(sessionId: string): ContextData {
  const now = Date.now();

  return {
    layers: {
      system: {
        role: 'AI助手',
        capabilities: [],
        tools: [],
        version: '1.0.0',
      },
      session: {
        sessionId,
        startTime: now,
        preferences: {},
        configuration: {},
      },
      conversation: {
        messages: [],
        topics: [],
        lastActivity: now,
      },
      tool: {
        recentCalls: [],
        toolStates: {},
        dependencies: {},
      },
      workspace: {
        currentFiles: [],
        recentFiles: [],
        environment: {},
      },
    },
    metadata: {
      totalTokens: 0,
      priority: 1,
      lastUpdated: now,
    },
  };
}

/**
 * 深度克隆上下文数据
 */
export function cloneContextData(data: ContextData): ContextData {
  return JSON.parse(JSON.stringify(data));
}

/**
 * 合并两个上下文数据
 */
export function mergeContextData(base: ContextData, overlay: Partial<ContextData>): ContextData {
  const merged = cloneContextData(base);

  if (overlay.layers) {
    Object.assign(merged.layers, overlay.layers);
  }

  if (overlay.metadata) {
    Object.assign(merged.metadata, overlay.metadata);
  }

  merged.metadata.lastUpdated = Date.now();

  return merged;
}
