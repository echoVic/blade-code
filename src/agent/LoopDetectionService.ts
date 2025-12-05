/**
 * 循环检测服务
 */

import { createHash } from 'crypto';
import type { ChatCompletionMessageToolCall } from 'openai/resources/chat';
import type { PlanModeConfig } from '../config/types.js';
import type { IChatService, Message } from '../services/ChatServiceInterface.js';

export interface LoopDetectionConfig {
  toolCallThreshold: number; // 工具调用重复次数阈值 (默认5)
  contentRepeatThreshold: number; // 内容重复次数阈值 (默认10)
  llmCheckInterval: number; // LLM检测间隔 (默认30轮)
  whitelistedTools?: string[]; // 白名单工具 (不参与循环检测)
  enableDynamicThreshold?: boolean; // 启用动态阈值调整
  enableLlmDetection?: boolean; // 启用LLM智能检测
  maxWarnings?: number; // 最大警告次数 (默认2次,超过后停止)
}

export interface LoopDetectionResult {
  detected: boolean;
  reason: string;
  type?: 'tool_call' | 'content' | 'llm';
  warningCount?: number; // 已发出的警告次数
  shouldStop?: boolean; // 是否应该停止任务
}

/**
 * Plan 模式循环检测结果
 */
export interface PlanModeLoopResult {
  /** 是否应该注入警告 */
  shouldWarn: boolean;
  /** 警告消息（已替换占位符） */
  warningMessage?: string;
  /** 连续无文本输出的轮次数 */
  consecutiveCount: number;
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

  // 警告计数器
  private warningCount = 0;
  private maxWarnings: number;

  // === Plan 模式专用状态 ===
  private consecutiveToolOnlyTurns = 0;
  private planModeConfig?: PlanModeConfig;

  constructor(
    private config: LoopDetectionConfig,
    private chatService?: IChatService
  ) {
    this.llmCheckInterval = config.llmCheckInterval;
    this.maxWarnings = config.maxWarnings ?? 2; // 默认2次警告
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
      this.warningCount++;
      return {
        detected: true,
        type: 'tool_call',
        reason: `重复调用工具 ${toolLoop.toolName} ${this.config.toolCallThreshold}次`,
        warningCount: this.warningCount,
        shouldStop: this.warningCount > this.maxWarnings,
      };
    }

    // === 层2: 内容循环检测 ===
    // Plan 模式下跳过，因为调研阶段输出格式相似是正常现象
    if (!skipContentDetection) {
      const contentLoop = this.detectContentLoop(messages);
      if (contentLoop) {
        this.warningCount++;
        return {
          detected: true,
          type: 'content',
          reason: '检测到重复内容模式',
          warningCount: this.warningCount,
          shouldStop: this.warningCount > this.maxWarnings,
        };
      }
    }

    // === 层2.5: 空响应循环检测 ===
    const silentLoop = this.detectSilentLoop(messages);
    if (silentLoop) {
      // 🔧 修复：空响应循环是严重故障，直接停止（不递增 warningCount）
      // 连续 5 次空响应说明模型已失效，继续运行只会浪费 token
      return {
        detected: true,
        type: 'content',
        reason: 'LLM 连续返回 5 次以上空响应，模型可能失效',
        warningCount: this.maxWarnings + 1, // 直接设置为超过阈值
        shouldStop: true, // 立即停止
      };
    }

    // === 层3: LLM 智能检测 ===
    if (
      this.config.enableLlmDetection !== false &&
      this.chatService &&
      currentTurn >= this.llmCheckInterval
    ) {
      const llmLoop = await this.detectLlmLoop(messages);
      if (llmLoop) {
        this.warningCount++;
        return {
          detected: true,
          type: 'llm',
          reason: 'AI判断陷入认知循环',
          warningCount: this.warningCount,
          shouldStop: this.warningCount > this.maxWarnings,
        };
      }

      // 动态调整检测间隔 (3-15轮)
      this.llmCheckInterval = Math.min(this.llmCheckInterval + 5, 15);
    }

    return null;
  }

  /**
   * 工具调用循环检测
   * 检测连续N次相同工具调用
   */
  private detectToolCallLoop(
    toolCalls: ChatCompletionMessageToolCall[]
  ): { toolName: string } | null {
    for (const tc of toolCalls) {
      if (tc.type !== 'function') continue;

      // 跳过白名单工具
      if (this.config.whitelistedTools?.includes(tc.function.name)) {
        continue;
      }

      const hash = this.hashParams(tc.function.arguments);
      this.toolCallHistory.push({
        name: tc.function.name,
        paramsHash: hash,
        turn: Date.now(),
      });

      // 动态阈值调整
      const threshold = this.getDynamicThreshold('tool');
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
   * 内容循环检测
   * 使用滑动窗口检测重复内容块
   */
  private detectContentLoop(messages: Message[]): boolean {
    const recentContent = messages
      .slice(-10)
      .map((m) => (typeof m.content === 'string' ? m.content : ''))
      .join('\n');

    this.contentHistory.push(recentContent);

    // 动态阈值
    const threshold = this.getDynamicThreshold('content');
    const similarityRatio = this.getDynamicSimilarityRatio();

    // 检查是否有重复块
    if (this.contentHistory.length < threshold) {
      return false;
    }

    const recent = this.contentHistory.slice(-threshold);
    const hashes = recent.map((c) => this.hashContent(c));

    // 动态相似度阈值
    const uniqueHashes = new Set(hashes);
    return uniqueHashes.size < hashes.length * similarityRatio;
  }

  /**
   * 检测连续空响应（LLM 陷入沉默循环）
   *
   * 关键改进：
   * 1. 区分"完全空响应"和"仅工具调用响应"
   *    - 仅工具调用（无 content 但有 tool_calls）是正常的探索行为
   *    - 既无 content 也无 tool_calls 才是真正的异常
   * 2. 只统计 assistant 消息，用户消息不影响计数
   *    - 修复：之前在遇到用户消息时重置计数，导致永远无法累积
   */
  private detectSilentLoop(messages: Message[]): boolean {
    // 只提取最近的 assistant 消息
    const recentAssistantMessages = messages
      .slice(-20) // 扩大窗口到最近 20 条消息
      .filter((m) => m.role === 'assistant')
      .slice(-10); // 取最近 10 条 assistant 消息

    if (recentAssistantMessages.length < 5) {
      return false; // 消息不足，无法判断
    }

    // 统计连续的真正空响应（既无 content 也无 tool_calls）
    let consecutiveEmpty = 0;

    for (const msg of recentAssistantMessages.reverse()) {
      const hasContent = msg.content && msg.content.trim() !== '';
      const hasToolCalls = msg.tool_calls && msg.tool_calls.length > 0;

      if (hasContent || hasToolCalls) {
        // 有内容或工具调用，重置计数
        consecutiveEmpty = 0;
      } else {
        // 真正的空响应
        consecutiveEmpty++;
      }

      // 连续 5 次真正的空响应 → 异常
      if (consecutiveEmpty >= 5) {
        return true;
      }
    }

    return false;
  }

  /**
   * LLM 智能检测
   * 使用专门的系统提示让 LLM 分析是否陷入循环
   */
  private async detectLlmLoop(messages: Message[]): Promise<boolean> {
    if (!this.chatService) {
      return false; // 无 ChatService 则跳过
    }

    const LOOP_DETECTION_PROMPT = `你是AI循环诊断专家。分析以下对话历史，判断AI是否陷入无效状态:

无效状态特征:
- 重复操作: 相同工具/响应重复多次
- 认知循环: 无法决定下一步，表达困惑

关键: 区分真正的死循环 vs 正常的渐进式进展

最近对话历史:
${this.formatMessagesForDetection(messages.slice(-10))}

回答 "YES" (陷入循环) 或 "NO" (正常进展)`;

    try {
      const response = await this.chatService.chat([
        { role: 'user', content: LOOP_DETECTION_PROMPT },
      ]);

      return response.content.toLowerCase().includes('yes');
    } catch (error) {
      console.warn('LLM 循环检测失败:', error);
      return false; // 检测失败不影响主流程
    }
  }

  /**
   * 使用 MD5 哈希算法 (避免碰撞)
   */
  private hashParams(args: string): string {
    return createHash('md5').update(args).digest('hex');
  }

  private hashContent(content: string): string {
    return createHash('md5').update(content).digest('hex');
  }

  /**
   * 动态阈值调整 (基于任务长度)
   */
  private getDynamicThreshold(type: 'tool' | 'content'): number {
    if (!this.config.enableDynamicThreshold) {
      return type === 'tool'
        ? this.config.toolCallThreshold
        : this.config.contentRepeatThreshold;
    }

    const turns = this.turnsInCurrentPrompt;

    if (type === 'tool') {
      // 短任务(< 10轮): 阈值 = 3
      // 中等任务(10-30轮): 阈值 = 5
      // 长任务(> 30轮): 阈值 = 7
      if (turns < 10) return 3;
      if (turns < 30) return 5;
      return 7;
    } else {
      // content 阈值
      if (turns < 10) return 5;
      if (turns < 30) return 10;
      return 15;
    }
  }

  /**
   * 动态相似度比例
   */
  private getDynamicSimilarityRatio(): number {
    if (!this.config.enableDynamicThreshold) {
      return 0.5; // 默认 50%
    }

    const turns = this.turnsInCurrentPrompt;

    // 短任务更严格 (60%)
    // 长任务更宽松 (40%)
    if (turns < 10) return 0.6;
    if (turns < 30) return 0.5;
    return 0.4;
  }

  private formatMessagesForDetection(messages: Message[]): string {
    return messages
      .map(
        (m, i) =>
          `[${i + 1}] ${m.role}: ${typeof m.content === 'string' ? m.content.slice(0, 200) : '...'}`
      )
      .join('\n');
  }

  // ========================================
  // Plan 模式专用检测方法
  // ========================================

  /**
   * 设置 Plan 模式配置
   * 应在进入 Plan 模式时调用
   */
  setPlanModeConfig(config: PlanModeConfig): void {
    this.planModeConfig = config;
    this.consecutiveToolOnlyTurns = 0;
  }

  /**
   * 检测 Plan 模式下的工具循环（连续无文本输出）
   *
   * @param hasTextOutput - 当前轮次是否有文本输出
   * @returns 检测结果，包含是否需要警告和警告消息
   */
  detectPlanModeToolOnlyLoop(hasTextOutput: boolean): PlanModeLoopResult {
    // 未配置 Plan 模式时，跳过检测
    if (!this.planModeConfig) {
      return {
        shouldWarn: false,
        consecutiveCount: 0,
      };
    }

    if (hasTextOutput) {
      // 有文本输出，重置计数器
      this.consecutiveToolOnlyTurns = 0;
      return {
        shouldWarn: false,
        consecutiveCount: 0,
      };
    }

    // 无文本输出，增加计数器
    this.consecutiveToolOnlyTurns++;

    // 检查是否达到阈值
    if (this.consecutiveToolOnlyTurns >= this.planModeConfig.toolOnlyThreshold) {
      const warningMessage = this.planModeConfig.warningMessage.replace(
        '{count}',
        String(this.consecutiveToolOnlyTurns)
      );

      // 重置计数器，给 LLM 机会改正
      const count = this.consecutiveToolOnlyTurns;
      this.consecutiveToolOnlyTurns = 0;

      return {
        shouldWarn: true,
        warningMessage,
        consecutiveCount: count,
      };
    }

    return {
      shouldWarn: false,
      consecutiveCount: this.consecutiveToolOnlyTurns,
    };
  }

  /**
   * 获取当前连续无文本输出的轮次数
   */
  getConsecutiveToolOnlyTurns(): number {
    return this.consecutiveToolOnlyTurns;
  }

  /**
   * 重置检测状态
   */
  reset(): void {
    this.toolCallHistory = [];
    this.contentHistory = [];
    this.turnsInCurrentPrompt = 0;
    this.warningCount = 0;
    // Plan 模式状态重置
    this.consecutiveToolOnlyTurns = 0;
  }

  /**
   * 重置 Plan 模式状态
   * 在退出 Plan 模式时调用
   */
  resetPlanMode(): void {
    this.consecutiveToolOnlyTurns = 0;
    this.planModeConfig = undefined;
  }
}
