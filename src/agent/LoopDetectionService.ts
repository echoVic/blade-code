/**
 * 循环检测服务 - 参考 Gemini CLI 三层检测机制
 * 融合 Gemini CLI 的最佳实践
 */

import type { ChatCompletionMessageToolCall } from 'openai/resources/chat';
import type { Message } from '../services/OpenAIChatService.js';

export interface LoopDetectionConfig {
  toolCallThreshold: number; // 工具调用重复次数阈值 (默认5)
  contentRepeatThreshold: number; // 内容重复次数阈值 (默认10)
  llmCheckInterval: number; // LLM检测间隔 (默认30轮)
}

export interface LoopDetectionResult {
  detected: boolean;
  reason: string;
  type?: 'tool_call' | 'content' | 'llm';
}

/**
 * 循环检测服务
 */
export class LoopDetectionService {
  // 工具调用历史
  private toolCallHistory: Array<{
    name: string;
    paramsHash: string;
    turn: number;
  }> = [];

  // 内容历史 (用于检测重复)
  private contentHistory: string[] = [];

  // LLM 检测计数器
  private turnsInCurrentPrompt = 0;
  private llmCheckInterval: number;

  constructor(private config: LoopDetectionConfig) {
    this.llmCheckInterval = config.llmCheckInterval;
  }

  /**
   * 主检测方法 - 三层检测机制
   * @param skipContentDetection - 跳过内容循环检测（Plan 模式下推荐）
   */
  async detect(
    toolCalls: ChatCompletionMessageToolCall[],
    currentTurn: number,
    messages: Message[],
    skipContentDetection = false
  ): Promise<LoopDetectionResult | null> {
    this.turnsInCurrentPrompt = currentTurn;

    // === 层1: 工具调用循环检测 ===
    const toolLoop = this.detectToolCallLoop(toolCalls);
    if (toolLoop) {
      return {
        detected: true,
        type: 'tool_call',
        reason: `重复调用工具 ${toolLoop.toolName} ${this.config.toolCallThreshold}次`,
      };
    }

    // === 层2: 内容循环检测 ===
    // Plan 模式下跳过，因为调研阶段输出格式相似是正常现象
    if (!skipContentDetection) {
      const contentLoop = this.detectContentLoop(messages);
      if (contentLoop) {
        return {
          detected: true,
          type: 'content',
          reason: '检测到重复内容模式',
        };
      }
    }

    // === 层3: LLM 智能检测 (暂时禁用，需要集成ChatService) ===
    /*
    if (currentTurn >= this.llmCheckInterval) {
      const llmLoop = await this.detectLlmLoop(messages);
      if (llmLoop) {
        return {
          detected: true,
          type: 'llm',
          reason: 'AI判断陷入认知循环'
        };
      }

      // 动态调整检测间隔 (3-15轮)
      this.llmCheckInterval = Math.min(this.llmCheckInterval + 5, 15);
    }
    */

    return null;
  }

  /**
   * 工具调用循环检测 (Gemini CLI)
   * 检测连续N次相同工具调用
   */
  private detectToolCallLoop(
    toolCalls: ChatCompletionMessageToolCall[]
  ): { toolName: string } | null {
    for (const tc of toolCalls) {
      if (tc.type !== 'function') continue;

      const hash = this.hashParams(tc.function.arguments);
      this.toolCallHistory.push({
        name: tc.function.name,
        paramsHash: hash,
        turn: Date.now(),
      });

      // 检查最近N次
      const threshold = this.config.toolCallThreshold;
      const recent = this.toolCallHistory.slice(-threshold);

      if (
        recent.length === threshold &&
        recent.every((h) => h.name === tc.function.name && h.paramsHash === hash)
      ) {
        return { toolName: tc.function.name };
      }
    }

    return null;
  }

  /**
   * 内容循环检测 (Gemini CLI)
   * 使用滑动窗口检测重复内容块
   */
  private detectContentLoop(messages: Message[]): boolean {
    const recentContent = messages
      .slice(-10)
      .map((m) => (typeof m.content === 'string' ? m.content : ''))
      .join('\n');

    this.contentHistory.push(recentContent);

    // 检查是否有重复块
    if (this.contentHistory.length < this.config.contentRepeatThreshold) {
      return false;
    }

    const recent = this.contentHistory.slice(-this.config.contentRepeatThreshold);
    const hashes = recent.map((c) => this.hashContent(c));

    // 检查是否有超过50%的相似度
    const uniqueHashes = new Set(hashes);
    return uniqueHashes.size < hashes.length / 2;
  }

  /**
   * LLM 智能检测 (Gemini CLI)
   * 使用专门的系统提示让 LLM 分析是否陷入循环
   *
   * TODO: 需要注入 ChatService 实例来调用
   */
  /*
  private async detectLlmLoop(messages: Message[]): Promise<boolean> {
    const LOOP_DETECTION_PROMPT = `你是AI循环诊断专家。分析以下对话历史，判断AI是否陷入无效状态:

无效状态特征:
- 重复操作: 相同工具/响应重复多次
- 认知循环: 无法决定下一步，表达困惑

关键: 区分真正的死循环 vs 正常的渐进式进展

最近对话历史:
${this.formatMessagesForDetection(messages.slice(-10))}

回答 "YES" (陷入循环) 或 "NO" (正常进展)`;

    // TODO: 调用 ChatService 进行判断
    // const response = await this.chatService.chatSimple(LOOP_DETECTION_PROMPT);
    // return response.toLowerCase().includes('yes');

    return false;
  }
  */

  private hashParams(args: string): string {
    // 使用简单的 hash 算法
    let hash = 0;
    for (let i = 0; i < args.length; i++) {
      const char = args.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return hash.toString();
  }

  private hashContent(content: string): string {
    return this.hashParams(content);
  }

  private formatMessagesForDetection(messages: Message[]): string {
    return messages
      .map(
        (m, i) =>
          `[${i + 1}] ${m.role}: ${typeof m.content === 'string' ? m.content.slice(0, 200) : '...'}`
      )
      .join('\n');
  }

  /**
   * 重置检测状态
   */
  reset(): void {
    this.toolCallHistory = [];
    this.contentHistory = [];
    this.turnsInCurrentPrompt = 0;
  }
}
