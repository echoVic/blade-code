import { CompressedContext, ContextData, ContextMessage, ToolCall } from '../types.js';

/**
 * 上下文压缩器 - 智能压缩上下文以节省 token 使用
 */
export class ContextCompressor {
  private readonly maxSummaryLength: number;
  private readonly keyPointsLimit: number;
  private readonly recentMessagesLimit: number;

  constructor(
    maxSummaryLength: number = 500,
    keyPointsLimit: number = 10,
    recentMessagesLimit: number = 20
  ) {
    this.maxSummaryLength = maxSummaryLength;
    this.keyPointsLimit = keyPointsLimit;
    this.recentMessagesLimit = recentMessagesLimit;
  }

  /**
   * 压缩上下文数据
   */
  async compress(contextData: ContextData): Promise<CompressedContext> {
    const messages = contextData.layers.conversation.messages;
    const toolCalls = contextData.layers.tool.recentCalls;

    // 分离系统消息和用户/助手消息
    const systemMessages = messages.filter(m => m.role === 'system');
    const conversationMessages = messages.filter(m => m.role !== 'system');

    // 获取最近的消息（保持完整）
    const recentMessages = this.getRecentMessages(conversationMessages);

    // 压缩较旧的消息
    const olderMessages = conversationMessages.slice(0, -this.recentMessagesLimit);
    const summary = await this.generateSummary(olderMessages);

    // 提取关键要点
    const keyPoints = this.extractKeyPoints(olderMessages, toolCalls);

    // 生成工具摘要
    const toolSummary = this.generateToolSummary(toolCalls);

    // 估算 token 数量
    const tokenCount = this.estimateTokenCount(summary, keyPoints, recentMessages, toolSummary);

    return {
      summary,
      keyPoints,
      recentMessages: [...systemMessages, ...recentMessages],
      toolSummary,
      tokenCount,
    };
  }

  /**
   * 获取最近的消息
   */
  private getRecentMessages(messages: ContextMessage[]): ContextMessage[] {
    return messages.slice(-this.recentMessagesLimit);
  }

  /**
   * 生成对话摘要
   */
  private async generateSummary(messages: ContextMessage[]): Promise<string> {
    if (messages.length === 0) {
      return '';
    }

    // 简单的摘要生成策略（可以后续接入 LLM 进行更智能的摘要）
    const topics = new Set<string>();
    const actions = new Set<string>();
    const decisions = new Set<string>();

    for (const message of messages) {
      const content = message.content.toLowerCase();

      // 检测主题关键词
      const topicKeywords = ['关于', '讨论', '问题', '项目', '功能', '需求'];
      topicKeywords.forEach(keyword => {
        if (content.includes(keyword)) {
          const context = this.extractContext(content, keyword, 50);
          if (context) topics.add(context);
        }
      });

      // 检测动作关键词
      const actionKeywords = ['创建', '删除', '修改', '更新', '实现', '开发'];
      actionKeywords.forEach(keyword => {
        if (content.includes(keyword)) {
          const context = this.extractContext(content, keyword, 30);
          if (context) actions.add(context);
        }
      });

      // 检测决策关键词
      const decisionKeywords = ['决定', '选择', '确定', '采用', '使用'];
      decisionKeywords.forEach(keyword => {
        if (content.includes(keyword)) {
          const context = this.extractContext(content, keyword, 40);
          if (context) decisions.add(context);
        }
      });
    }

    // 构建摘要
    let summary = `对话涉及 ${messages.length} 条消息。`;

    if (topics.size > 0) {
      summary += ` 主要讨论：${Array.from(topics).slice(0, 3).join('、')}。`;
    }

    if (actions.size > 0) {
      summary += ` 执行操作：${Array.from(actions).slice(0, 3).join('、')}。`;
    }

    if (decisions.size > 0) {
      summary += ` 关键决策：${Array.from(decisions).slice(0, 2).join('、')}。`;
    }

    return summary.length > this.maxSummaryLength
      ? summary.substring(0, this.maxSummaryLength) + '...'
      : summary;
  }

  /**
   * 提取关键要点
   */
  private extractKeyPoints(messages: ContextMessage[], toolCalls: ToolCall[]): string[] {
    const keyPoints: Set<string> = new Set();

    // 从消息中提取关键点
    for (const message of messages) {
      if (message.role === 'user') {
        // 用户的问题和请求
        const questions = this.extractQuestions(message.content);
        questions.forEach(q => keyPoints.add(`用户问题：${q}`));

        const requests = this.extractRequests(message.content);
        requests.forEach(r => keyPoints.add(`用户请求：${r}`));
      } else if (message.role === 'assistant') {
        // 助手的重要建议和解决方案
        const solutions = this.extractSolutions(message.content);
        solutions.forEach(s => keyPoints.add(`解决方案：${s}`));
      }
    }

    // 从工具调用中提取关键点
    const toolUsage = this.summarizeToolUsage(toolCalls);
    toolUsage.forEach(usage => keyPoints.add(`工具使用：${usage}`));

    return Array.from(keyPoints).slice(0, this.keyPointsLimit);
  }

  /**
   * 生成工具调用摘要
   */
  private generateToolSummary(toolCalls: ToolCall[]): string {
    if (toolCalls.length === 0) {
      return '';
    }

    const toolStats = new Map<string, { count: number; success: number; recent: number }>();
    const recentTime = Date.now() - 10 * 60 * 1000; // 最近10分钟

    for (const call of toolCalls) {
      const stats = toolStats.get(call.name) || { count: 0, success: 0, recent: 0 };
      stats.count++;
      if (call.status === 'success') stats.success++;
      if (call.timestamp > recentTime) stats.recent++;
      toolStats.set(call.name, stats);
    }

    const summaryParts: string[] = [];
    for (const [toolName, stats] of Array.from(toolStats.entries())) {
      const successRate = Math.round((stats.success / stats.count) * 100);
      summaryParts.push(`${toolName}(${stats.count}次,成功率${successRate}%)`);
    }

    return `工具调用：${summaryParts.join('、')}`;
  }

  /**
   * 估算 token 数量（简单估算）
   */
  private estimateTokenCount(
    summary: string,
    keyPoints: string[],
    recentMessages: ContextMessage[],
    toolSummary?: string
  ): number {
    let totalLength = summary.length + keyPoints.join(' ').length;

    if (toolSummary) {
      totalLength += toolSummary.length;
    }

    for (const message of recentMessages) {
      totalLength += message.content.length;
    }

    // 粗略估算：4个字符 ≈ 1个 token（对于中文）
    return Math.ceil(totalLength / 4);
  }

  /**
   * 从内容中提取上下文
   */
  private extractContext(content: string, keyword: string, maxLength: number): string | null {
    const index = content.indexOf(keyword);
    if (index === -1) return null;

    const start = Math.max(0, index - maxLength / 2);
    const end = Math.min(content.length, index + maxLength / 2);

    return content.substring(start, end).trim();
  }

  /**
   * 提取问题
   */
  private extractQuestions(content: string): string[] {
    const questions: string[] = [];
    const questionMarkers = ['?', '？', '如何', '怎么', '什么', '为什么'];

    const sentences = content.split(/[。！.!]/);
    for (const sentence of sentences) {
      if (questionMarkers.some(marker => sentence.includes(marker))) {
        const cleaned = sentence.trim();
        if (cleaned.length > 5 && cleaned.length < 100) {
          questions.push(cleaned);
        }
      }
    }

    return questions.slice(0, 3); // 最多返回3个问题
  }

  /**
   * 提取请求
   */
  private extractRequests(content: string): string[] {
    const requests: string[] = [];
    const requestMarkers = ['请', '帮我', '需要', '想要', '希望', '能否'];

    const sentences = content.split(/[。！.!]/);
    for (const sentence of sentences) {
      if (requestMarkers.some(marker => sentence.includes(marker))) {
        const cleaned = sentence.trim();
        if (cleaned.length > 5 && cleaned.length < 100) {
          requests.push(cleaned);
        }
      }
    }

    return requests.slice(0, 3); // 最多返回3个请求
  }

  /**
   * 提取解决方案
   */
  private extractSolutions(content: string): string[] {
    const solutions: string[] = [];
    const solutionMarkers = ['可以', '建议', '推荐', '应该', '最好', '解决方案'];

    const sentences = content.split(/[。！.!]/);
    for (const sentence of sentences) {
      if (solutionMarkers.some(marker => sentence.includes(marker))) {
        const cleaned = sentence.trim();
        if (cleaned.length > 10 && cleaned.length < 150) {
          solutions.push(cleaned);
        }
      }
    }

    return solutions.slice(0, 3); // 最多返回3个解决方案
  }

  /**
   * 总结工具使用情况
   */
  private summarizeToolUsage(toolCalls: ToolCall[]): string[] {
    const summary: string[] = [];
    const recentCalls = toolCalls.filter(
      call => Date.now() - call.timestamp < 30 * 60 * 1000 // 最近30分钟
    );

    if (recentCalls.length > 0) {
      const toolGroups = new Map<string, ToolCall[]>();
      recentCalls.forEach(call => {
        const group = toolGroups.get(call.name) || [];
        group.push(call);
        toolGroups.set(call.name, group);
      });

      for (const [toolName, calls] of Array.from(toolGroups.entries())) {
        const successCount = calls.filter(c => c.status === 'success').length;
        summary.push(`${toolName}(${calls.length}次,${successCount}成功)`);
      }
    }

    return summary.slice(0, 5); // 最多返回5个工具使用摘要
  }

  /**
   * 检查是否需要压缩
   */
  shouldCompress(contextData: ContextData, maxTokens: number): boolean {
    const estimatedTokens = this.estimateCurrentTokens(contextData);
    return estimatedTokens > maxTokens * 0.8; // 当超过80%限制时开始压缩
  }

  /**
   * 估算当前上下文的 token 数量
   */
  private estimateCurrentTokens(contextData: ContextData): number {
    const messages = contextData.layers.conversation.messages;
    const totalLength = messages.reduce((sum, msg) => sum + msg.content.length, 0);
    return Math.ceil(totalLength / 4); // 简单估算
  }
}
