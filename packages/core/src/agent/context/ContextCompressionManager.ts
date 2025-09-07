/**
 * 智能上下文压缩管理器
 * 实现Claude Code风格的8段式压缩算法
 */

import { EventEmitter } from 'events';
import type { ChatMessage } from '../../services/ChatService.js';
import { ErrorFactory } from '../../error/index.js';

export interface ContextData {
  messages: ChatMessage[];
  tokenCount: number;
  metadata?: Record<string, unknown>;
}

export interface CompressedContext {
  originalMessages: ChatMessage[];
  compressedMessages: ChatMessage[];
  compressionRatio: number;
  compressionStages: string[];
  metadata: {
    originalTokens: number;
    compressedTokens: number;
    processingTime: number;
    keyPointsExtracted: number;
    duplicatesRemoved: number;
  };
}

export interface CompressionStage {
  name: string;
  description: string;
  execute: (context: ContextData) => Promise<ContextData>;
}

/**
 * 上下文压缩管理器 - 实现Claude Code的8段式压缩算法
 */
export class ContextCompressionManager extends EventEmitter {
  private readonly COMPRESSION_THRESHOLD = 0.92;
  private readonly MAX_TOKEN_LIMIT = 4000;
  private readonly compressionStages: CompressionStage[];
  
  constructor() {
    super();
    this.compressionStages = this.initializeCompressionStages();
  }

  /**
   * 初始化8段式压缩流水线
   */
  private initializeCompressionStages(): CompressionStage[] {
    return [
      {
        name: 'RemoveDuplicates',
        description: '去除重复内容',
        execute: this.removeDuplicates.bind(this),
      },
      {
        name: 'CompressMetadata',
        description: '压缩元数据',
        execute: this.compressMetadata.bind(this),
      },
      {
        name: 'SummarizeHistory',
        description: '历史对话摘要',
        execute: this.summarizeHistory.bind(this),
      },
      {
        name: 'ExtractKeyPoints',
        description: '提取关键点',
        execute: this.extractKeyPoints.bind(this),
      },
      {
        name: 'MergeRelatedContext',
        description: '合并相关上下文',
        execute: this.mergeRelatedContext.bind(this),
      },
      {
        name: 'CompressLongContent',
        description: '长内容压缩',
        execute: this.compressLongContent.bind(this),
      },
      {
        name: 'OptimizeTokenUsage',
        description: 'Token使用优化',
        execute: this.optimizeTokenUsage.bind(this),
      },
      {
        name: 'FinalValidation',
        description: '最终验证',
        execute: this.finalValidation.bind(this),
      },
    ];
  }

  /**
   * 检查是否需要压缩
   */
  public needsCompression(context: ContextData): boolean {
    const usage = this.getContextUsage(context);
    return usage > this.COMPRESSION_THRESHOLD;
  }

  /**
   * 计算上下文使用率
   */
  private getContextUsage(context: ContextData): number {
    return context.tokenCount / this.MAX_TOKEN_LIMIT;
  }

  /**
   * 主压缩接口 - 当需要时执行压缩
   */
  public async compressWhenNeeded(context: ContextData): Promise<CompressedContext> {
    if (!this.needsCompression(context)) {
      return this.createUncompressedResult(context);
    }

    this.emit('compressionStarted', { context });
    const startTime = Date.now();

    try {
      const compressed = await this.executeCompressionPipeline(context);
      const processingTime = Date.now() - startTime;

      const result: CompressedContext = {
        originalMessages: context.messages,
        compressedMessages: compressed.messages,
        compressionRatio: this.calculateCompressionRatio(context, compressed),
        compressionStages: this.compressionStages.map(stage => stage.name),
        metadata: {
          originalTokens: context.tokenCount,
          compressedTokens: compressed.tokenCount,
          processingTime,
          keyPointsExtracted: this.countKeyPoints(compressed),
          duplicatesRemoved: context.messages.length - compressed.messages.length,
        },
      };

      this.emit('compressionCompleted', { result });
      return result;
    } catch (error) {
      this.emit('compressionFailed', { error });
      throw ErrorFactory.createFromError('CONTEXT_COMPRESSION_FAILED', error as Error);
    }
  }

  /**
   * 执行8段式压缩流水线
   */
  private async executeCompressionPipeline(context: ContextData): Promise<ContextData> {
    let compressed = { ...context };

    for (const stage of this.compressionStages) {
      try {
        this.emit('stageStarted', { stage: stage.name });
        compressed = await stage.execute(compressed);
        this.emit('stageCompleted', { stage: stage.name, tokenCount: compressed.tokenCount });
        
        // 如果已经达到目标压缩率，提前退出
        if (!this.needsCompression(compressed)) {
          break;
        }
      } catch (error) {
        this.emit('stageFailed', { stage: stage.name, error });
        console.warn(`压缩阶段 ${stage.name} 失败:`, error);
        // 继续执行下一个阶段，不中断整个流程
      }
    }

    return compressed;
  }

  /**
   * 阶段1: 去除重复内容
   */
  private async removeDuplicates(context: ContextData): Promise<ContextData> {
    const uniqueMessages = new Map<string, ChatMessage>();
    const seenContent = new Set<string>();

    for (const message of context.messages) {
      const contentHash = this.hashMessage(message);
      
      if (!seenContent.has(contentHash)) {
        seenContent.add(contentHash);
        uniqueMessages.set(contentHash, message);
      }
    }

    const deduplicatedMessages = Array.from(uniqueMessages.values());
    
    return {
      messages: deduplicatedMessages,
      tokenCount: this.estimateTokenCount(deduplicatedMessages),
      metadata: {
        ...context.metadata,
        duplicatesRemoved: context.messages.length - deduplicatedMessages.length,
      },
    };
  }

  /**
   * 阶段2: 压缩元数据
   */
  private async compressMetadata(context: ContextData): Promise<ContextData> {
    const compressedMessages = context.messages.map(message => ({
      role: message.role,
      content: message.content,
      // 只保留关键元数据
      metadata: message.metadata ? this.compressMessageMetadata(message.metadata) : undefined,
    }));

    return {
      messages: compressedMessages,
      tokenCount: this.estimateTokenCount(compressedMessages),
      metadata: context.metadata,
    };
  }

  /**
   * 阶段3: 历史对话摘要
   */
  private async summarizeHistory(context: ContextData): Promise<ContextData> {
    const messages = [...context.messages];
    const recentMessages = messages.slice(-10); // 保留最近10条消息
    const olderMessages = messages.slice(0, -10);

    if (olderMessages.length === 0) {
      return context;
    }

    // 创建历史摘要
    const historySummary = this.createHistorySummary(olderMessages);
    const summaryMessage: ChatMessage = {
      role: 'system',
      content: `[历史对话摘要] ${historySummary}`,
      metadata: { compressed: true, originalMessageCount: olderMessages.length },
    };

    const compressedMessages = [summaryMessage, ...recentMessages];

    return {
      messages: compressedMessages,
      tokenCount: this.estimateTokenCount(compressedMessages),
      metadata: context.metadata,
    };
  }

  /**
   * 阶段4: 提取关键点
   */
  private async extractKeyPoints(context: ContextData): Promise<ContextData> {
    const keyPointsMessages = context.messages.map(message => {
      if (message.content.length > 500) {
        const keyPoints = this.extractMessageKeyPoints(message.content);
        return {
          ...message,
          content: keyPoints,
          metadata: {
            ...message.metadata,
            compressed: true,
            originalLength: message.content.length,
          },
        };
      }
      return message;
    });

    return {
      messages: keyPointsMessages,
      tokenCount: this.estimateTokenCount(keyPointsMessages),
      metadata: context.metadata,
    };
  }

  /**
   * 阶段5: 合并相关上下文
   */
  private async mergeRelatedContext(context: ContextData): Promise<ContextData> {
    const mergedMessages: ChatMessage[] = [];
    let currentGroup: ChatMessage[] = [];
    let lastRole = '';

    for (const message of context.messages) {
      if (message.role === lastRole && message.role !== 'system') {
        currentGroup.push(message);
      } else {
        if (currentGroup.length > 0) {
          mergedMessages.push(this.mergeMessageGroup(currentGroup));
        }
        currentGroup = [message];
        lastRole = message.role;
      }
    }

    if (currentGroup.length > 0) {
      mergedMessages.push(this.mergeMessageGroup(currentGroup));
    }

    return {
      messages: mergedMessages,
      tokenCount: this.estimateTokenCount(mergedMessages),
      metadata: context.metadata,
    };
  }

  /**
   * 阶段6: 长内容压缩
   */
  private async compressLongContent(context: ContextData): Promise<ContextData> {
    const compressedMessages = context.messages.map(message => {
      if (message.content.length > 1000) {
        const compressed = this.compressLongText(message.content);
        return {
          ...message,
          content: compressed,
          metadata: {
            ...message.metadata,
            compressed: true,
            originalLength: message.content.length,
          },
        };
      }
      return message;
    });

    return {
      messages: compressedMessages,
      tokenCount: this.estimateTokenCount(compressedMessages),
      metadata: context.metadata,
    };
  }

  /**
   * 阶段7: Token使用优化
   */
  private async optimizeTokenUsage(context: ContextData): Promise<ContextData> {
    // 按重要性排序消息
    const prioritizedMessages = this.prioritizeMessages(context.messages);
    
    // 保留最重要的消息，直到达到Token限制
    const optimizedMessages: ChatMessage[] = [];
    let tokenCount = 0;
    const targetTokens = this.MAX_TOKEN_LIMIT * 0.8; // 目标80%使用率

    for (const message of prioritizedMessages) {
      const messageTokens = this.estimateMessageTokens(message);
      if (tokenCount + messageTokens <= targetTokens) {
        optimizedMessages.push(message);
        tokenCount += messageTokens;
      } else {
        break;
      }
    }

    // 保持对话的时间顺序
    optimizedMessages.sort((a, b) => {
      const aTime = a.metadata?.timestamp || 0;
      const bTime = b.metadata?.timestamp || 0;
      return Number(aTime) - Number(bTime);
    });

    return {
      messages: optimizedMessages,
      tokenCount: this.estimateTokenCount(optimizedMessages),
      metadata: context.metadata,
    };
  }

  /**
   * 阶段8: 最终验证
   */
  private async finalValidation(context: ContextData): Promise<ContextData> {
    // 确保关键信息完整性
    const validatedMessages = this.validateMessageIntegrity(context.messages);
    
    // 最终Token计数验证
    const finalTokenCount = this.estimateTokenCount(validatedMessages);
    
    if (finalTokenCount > this.MAX_TOKEN_LIMIT) {
      // 如果仍然超限，进行最后的截断
      return this.emergencyTruncation(validatedMessages);
    }

    return {
      messages: validatedMessages,
      tokenCount: finalTokenCount,
      metadata: {
        ...context.metadata,
        validated: true,
      },
    };
  }

  // 辅助方法实现

  private hashMessage(message: ChatMessage): string {
    return `${message.role}:${message.content.slice(0, 100)}`;
  }

  private estimateTokenCount(messages: ChatMessage[]): number {
    return messages.reduce((total, message) => {
      return total + this.estimateMessageTokens(message);
    }, 0);
  }

  private estimateMessageTokens(message: ChatMessage): number {
    // 简单的Token估算：约4个字符 = 1个Token
    return Math.ceil(message.content.length / 4);
  }

  private compressMessageMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
    // 只保留关键元数据
    const important = ['timestamp', 'priority', 'type'];
    return Object.fromEntries(
      Object.entries(metadata).filter(([key]) => important.includes(key))
    );
  }

  private createHistorySummary(messages: ChatMessage[]): string {
    const summaryPoints = messages
      .map(msg => msg.content.slice(0, 100))
      .filter(content => content.trim().length > 0);
    
    return `包含 ${messages.length} 条历史消息的摘要：${summaryPoints.slice(0, 3).join('; ')}...`;
  }

  private extractMessageKeyPoints(content: string): string {
    // 简单的关键点提取：保留问题、答案和重要语句
    const sentences = content.split(/[.!?。！？]/);
    const keyPoints = sentences
      .filter(sentence => 
        sentence.includes('?') || 
        sentence.includes('？') || 
        sentence.length < 100
      )
      .slice(0, 3);
    
    return keyPoints.join('. ').trim();
  }

  private mergeMessageGroup(messages: ChatMessage[]): ChatMessage {
    if (messages.length === 1) return messages[0];
    
    const mergedContent = messages.map(msg => msg.content).join('\n');
    return {
      ...messages[0],
      content: mergedContent,
      metadata: {
        ...messages[0].metadata,
        merged: true,
        originalCount: messages.length,
      },
    };
  }

  private compressLongText(text: string): string {
    // 简单的文本压缩：保留开头和结尾，中间用省略号
    if (text.length <= 1000) return text;
    
    const start = text.slice(0, 300);
    const end = text.slice(-200);
    return `${start}...[省略${text.length - 500}个字符]...${end}`;
  }

  private prioritizeMessages(messages: ChatMessage[]): ChatMessage[] {
    return messages.sort((a, b) => {
      // 优先级排序：system > user > assistant
      const priority = { system: 3, user: 2, assistant: 1 };
      const aPriority = priority[a.role] || 0;
      const bPriority = priority[b.role] || 0;
      
      if (aPriority !== bPriority) {
        return bPriority - aPriority;
      }
      
      // 相同角色按时间排序
      const aTime = a.metadata?.timestamp || 0;
      const bTime = b.metadata?.timestamp || 0;
      return Number(bTime) - Number(aTime);
    });
  }

  private validateMessageIntegrity(messages: ChatMessage[]): ChatMessage[] {
    // 确保对话结构完整
    return messages.filter(message => {
      return message.content && 
             message.content.trim().length > 0 && 
             ['system', 'user', 'assistant'].includes(message.role);
    });
  }

  private emergencyTruncation(messages: ChatMessage[]): ContextData {
    // 紧急截断：保留最重要的消息
    const systemMessages = messages.filter(m => m.role === 'system');
    const recentMessages = messages.filter(m => m.role !== 'system').slice(-5);
    
    const truncatedMessages = [...systemMessages, ...recentMessages];
    
    return {
      messages: truncatedMessages,
      tokenCount: this.estimateTokenCount(truncatedMessages),
      metadata: { emergencyTruncated: true },
    };
  }

  private calculateCompressionRatio(original: ContextData, compressed: ContextData): number {
    if (original.tokenCount === 0) return 0;
    return (original.tokenCount - compressed.tokenCount) / original.tokenCount;
  }

  private countKeyPoints(context: ContextData): number {
    return context.messages.filter(msg => 
      msg.metadata?.compressed || msg.metadata?.keyPoints
    ).length;
  }

  private createUncompressedResult(context: ContextData): CompressedContext {
    return {
      originalMessages: context.messages,
      compressedMessages: context.messages,
      compressionRatio: 0,
      compressionStages: [],
      metadata: {
        originalTokens: context.tokenCount,
        compressedTokens: context.tokenCount,
        processingTime: 0,
        keyPointsExtracted: 0,
        duplicatesRemoved: 0,
      },
    };
  }

  /**
   * 获取压缩统计信息
   */
  public getCompressionStats(): {
    threshold: number;
    maxTokens: number;
    stageCount: number;
  } {
    return {
      threshold: this.COMPRESSION_THRESHOLD,
      maxTokens: this.MAX_TOKEN_LIMIT,
      stageCount: this.compressionStages.length,
    };
  }
}