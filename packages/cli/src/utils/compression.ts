export interface CompressionConfig {
  compaction: {
    auto: boolean; // 是否启用自动压缩
    outputTokenMax: number; // 预留的输出 token 数量
    autoContinue: boolean; // 压缩后是否自动继续
    triggerRatio: number; // 触发压缩的比例 (0-1)
  };
  pruning: {
    enabled: boolean; // 是否启用修剪
    protectThreshold: number; // 保护阈值（tokens）
    minimumPrune: number; // 最小修剪量
    protectedTools: string[]; // 受保护的工具列表
    protectTurns: number; // 保护最近 N 轮对话
  };
}

export interface ModelLimit {
  context: number; // 上下文窗口大小
  output: number; // 最大输出 token 数
  input?: number; // 最大输入 token 数（可选）
}

export interface TokenUsage {
  input: number; // 输入 token 数
  output: number; // 输出 token 数
  cacheRead?: number; // 缓存读取 token 数
}

export interface PruneResult {
  pruned: boolean; // 是否进行了修剪
  prunedCount: number; // 修剪的消息数量
  prunedTokens: number; // 修剪的 token 数量
  messages: Message[]; // 修剪后的消息列表
}

export interface CompressResult {
  compressed: boolean; // 是否进行了压缩
  compressedTokens: number; // 压缩的 token 数量
  messages: Message[]; // 压缩后的消息列表
}

export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp?: number;
  toolCalls?: Array<{ name: string; [key: string]: unknown }>;
}

export class Compression {
  private config: CompressionConfig;
  private modelLimit: ModelLimit;

  constructor(config: CompressionConfig, modelLimit: ModelLimit) {
    this.config = config;
    this.modelLimit = modelLimit;
  }

  /**
   * 检测是否需要触发压缩
   * 当输入 token 使用量超过上下文窗口的 triggerRatio 时触发
   */
  isOverflow(tokens: TokenUsage): boolean {
    if (!this.config.compaction.auto) {
      return false;
    }

    const { context } = this.modelLimit;
    if (context === 0) {
      return false;
    }

    // 计算当前输入 token 使用量（包括缓存读取）
    const currentInputTokens = tokens.input + (tokens.cacheRead || 0);

    // 检查是否超过触发比例
    const usageRatio = currentInputTokens / context;
    return usageRatio > this.config.compaction.triggerRatio;
  }

  /**
   * 判断是否需要修剪消息
   */
  shouldPrune(tokens: TokenUsage): boolean {
    if (!this.config.pruning.enabled) {
      return false;
    }

    const currentInputTokens = tokens.input + (tokens.cacheRead || 0);
    const { context } = this.modelLimit;

    // 使用配置的触发比例（与 isOverflow 一致）
    return currentInputTokens > context * this.config.compaction.triggerRatio;
  }

  /**
   * 修剪消息历史
   * 保留最近的 N 轮对话和包含受保护工具的消息
   */
  prune(messages: Message[], protectTurns?: number): PruneResult {
    const turns = protectTurns ?? this.config.pruning.protectTurns;

    if (messages.length === 0) {
      return {
        pruned: false,
        prunedCount: 0,
        prunedTokens: 0,
        messages: [],
      };
    }

    // 计算需要保护的消息数量（每轮 2 条消息：user + assistant）
    const protectCount = turns * 2;

    // 如果消息总数不足保护数量，不修剪
    if (messages.length <= protectCount) {
      return {
        pruned: false,
        prunedCount: 0,
        prunedTokens: 0,
        messages,
      };
    }

    const protectedMessages = new Set<Message>();

    // 1. 保护最近的 N 轮对话
    const recentMessages = messages.slice(-protectCount);
    for (const msg of recentMessages) {
      protectedMessages.add(msg);
    }

    // 2. 保护包含受保护工具调用的消息
    const { protectedTools } = this.config.pruning;
    for (const msg of messages) {
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        for (const toolCall of msg.toolCalls) {
          if (protectedTools.includes(toolCall.name)) {
            protectedMessages.add(msg);
            // 同时保护对应的用户消息
            const msgIndex = messages.indexOf(msg);
            if (msgIndex > 0 && messages[msgIndex - 1].role === 'user') {
              protectedMessages.add(messages[msgIndex - 1]);
            }
            break;
          }
        }
      }
    }

    // 3. 执行修剪
    const prunedMessages: Message[] = [];
    let prunedCount = 0;
    let prunedTokens = 0;

    for (const msg of messages) {
      if (protectedMessages.has(msg)) {
        prunedMessages.push(msg);
      } else {
        prunedCount++;
        prunedTokens += this.calculateTokens(msg.content);
      }
    }

    // 检查是否达到最小修剪量
    const { minimumPrune } = this.config.pruning;
    if (prunedTokens < minimumPrune && prunedCount > 0) {
      // 如果修剪量不够，尝试修剪更多
      // 这里简化处理，返回已修剪的结果
    }

    return {
      pruned: prunedCount > 0,
      prunedCount,
      prunedTokens,
      messages: prunedMessages,
    };
  }

  /**
   * 压缩消息历史
   * 将旧的消息压缩为摘要，保留最近的对话
   */
  compress(messages: Message[], keepTurns: number): CompressResult {
    if (messages.length <= 1) {
      return {
        compressed: false,
        compressedTokens: 0,
        messages,
      };
    }

    // 计算需要保留的消息数量
    const keepCount = keepTurns * 2;

    // 如果消息数量不足，不压缩
    if (messages.length <= keepCount) {
      return {
        compressed: false,
        compressedTokens: 0,
        messages,
      };
    }

    // 分离出需要压缩的消息和保留的消息
    const toCompress = messages.slice(0, -keepCount);
    const toKeep = messages.slice(-keepCount);

    // 生成摘要
    const summary = this.generateSummary(toCompress);
    const summaryMessage: Message = {
      role: 'system',
      content: `[对话历史摘要]\n${summary}`,
      timestamp: Date.now(),
    };

    // 计算压缩的 token 数量
    const compressedTokens = toCompress.reduce(
      (sum, msg) => sum + this.calculateTokens(msg.content),
      0
    );

    return {
      compressed: true,
      compressedTokens,
      messages: [summaryMessage, ...toKeep],
    };
  }

  /**
   * 生成消息历史摘要
   */
  private generateSummary(messages: Message[]): string {
    const summaryParts: string[] = [];
    let currentTopic = '';

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role === 'user') {
        // 提取用户的主要请求
        const request = msg.content.slice(0, 100);
        currentTopic = request;
      } else if (msg.role === 'assistant') {
        // 提取助手的主要回应
        const response = msg.content.slice(0, 100);
        if (currentTopic) {
          summaryParts.push(`- 讨论: ${currentTopic}\n  回应: ${response}...`);
          currentTopic = '';
        }
      }
    }

    return summaryParts.join('\n') || '之前的对话内容';
  }

  /**
   * 估算文本的 token 数量
   * 使用简单的启发式方法：
   * - 英文单词约 1.3 tokens
   * - 中文字符约 2 tokens
   */
  calculateTokens(text: string): number {
    if (!text) {
      return 0;
    }

    // 分离中文和英文
    const chineseChars = text.match(/[一-龥]/g) || [];
    const englishWords = text.match(/[a-zA-Z]+/g) || [];
    const otherChars = text.length - chineseChars.length - englishWords.join('').length;

    // 估算 token 数量
    const chineseTokens = chineseChars.length * 2;
    const englishTokens = englishWords.length * 1.3;
    const otherTokens = otherChars * 0.5;

    return Math.ceil(chineseTokens + englishTokens + otherTokens);
  }

  /**
   * 更新压缩配置
   */
  updateConfig(config: CompressionConfig): void {
    this.config = config;
  }

  /**
   * 更新模型限制
   */
  updateModelLimit(limit: ModelLimit): void {
    this.modelLimit = limit;
  }

  /**
   * 获取当前配置
   */
  getConfig(): CompressionConfig {
    return { ...this.config };
  }

  /**
   * 获取模型限制
   */
  getModelLimit(): ModelLimit {
    return { ...this.modelLimit };
  }
}
