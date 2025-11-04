/**
 * Token 估算和内容截断工具
 *
 * 提供 Token 数量估算和智能内容截断功能
 */

/**
 * Token 估算选项
 */
export interface TokenEstimateOptions {
  /** 平均每个 Token 的字符数（默认 4） */
  charsPerToken?: number;
}

/**
 * 截断选项
 */
export interface TruncateOptions {
  /** 最大 Token 数 */
  maxTokens: number;
  /** 平均每个 Token 的字符数（默认 4） */
  charsPerToken?: number;
  /** 截断策略：head（头部）、tail（尾部）、middle（中间） */
  strategy?: 'head' | 'tail' | 'middle';
  /** 截断提示文本 */
  truncationMessage?: string;
}

/**
 * 截断结果
 */
export interface TruncateResult {
  /** 截断后的内容 */
  content: string;
  /** 是否被截断 */
  truncated: boolean;
  /** 原始 Token 数（估算） */
  originalTokens: number;
  /** 截断后 Token 数（估算） */
  finalTokens: number;
  /** 截断的 Token 数 */
  removedTokens: number;
}

/**
 * Token 估算器
 *
 * 使用简单的启发式方法估算文本的 Token 数量
 * 基于 OpenAI 的粗略规则：1 token ≈ 4 字符（英文）或 1.5 字符（中文）
 */
export class TokenEstimator {
  private static readonly DEFAULT_CHARS_PER_TOKEN = 4;

  /**
   * 估算文本的 Token 数量
   *
   * @param text - 要估算的文本
   * @param options - 估算选项
   * @returns 估算的 Token 数量
   *
   * @example
   * ```typescript
   * TokenEstimator.estimate('Hello, world!')  // => 4
   * TokenEstimator.estimate('你好世界')        // => 6
   * ```
   */
  static estimate(text: string, options: TokenEstimateOptions = {}): number {
    const charsPerToken = options.charsPerToken ?? this.DEFAULT_CHARS_PER_TOKEN;

    // 简单估算：总字符数 / 每 Token 字符数
    // 更精确的方法需要使用 tiktoken 库，但会增加依赖
    const charCount = text.length;
    const estimatedTokens = Math.ceil(charCount / charsPerToken);

    return estimatedTokens;
  }

  /**
   * 检查文本是否超过 Token 限制
   *
   * @param text - 要检查的文本
   * @param maxTokens - 最大 Token 数
   * @param options - 估算选项
   * @returns 是否超过限制
   */
  static exceedsLimit(
    text: string,
    maxTokens: number,
    options: TokenEstimateOptions = {}
  ): boolean {
    const tokens = this.estimate(text, options);
    return tokens > maxTokens;
  }

  /**
   * 截断文本到指定 Token 限制
   *
   * @param text - 要截断的文本
   * @param options - 截断选项
   * @returns 截断结果
   *
   * @example
   * ```typescript
   * TokenEstimator.truncate('Very long text...', { maxTokens: 100 })
   * // => { content: '...', truncated: true, ... }
   * ```
   */
  static truncate(text: string, options: TruncateOptions): TruncateResult {
    const charsPerToken = options.charsPerToken ?? this.DEFAULT_CHARS_PER_TOKEN;
    const strategy = options.strategy ?? 'tail';
    const truncationMessage =
      options.truncationMessage ?? '\n\n[... content truncated ...]';

    const originalTokens = this.estimate(text, { charsPerToken });

    // 如果未超过限制，直接返回
    if (originalTokens <= options.maxTokens) {
      return {
        content: text,
        truncated: false,
        originalTokens,
        finalTokens: originalTokens,
        removedTokens: 0,
      };
    }

    // 计算可保留的字符数（留一些 Token 给截断提示）
    const messageTokens = this.estimate(truncationMessage, { charsPerToken });
    const availableTokens = options.maxTokens - messageTokens;
    const maxChars = Math.max(0, availableTokens * charsPerToken);

    let truncatedContent: string;

    switch (strategy) {
      case 'head':
        // 保留头部
        truncatedContent = text.slice(0, maxChars) + truncationMessage;
        break;

      case 'tail':
        // 保留尾部
        truncatedContent =
          truncationMessage + text.slice(text.length - maxChars);
        break;

      case 'middle':
        // 保留头部和尾部，删除中间
        const halfChars = Math.floor(maxChars / 2);
        const head = text.slice(0, halfChars);
        const tail = text.slice(text.length - halfChars);
        truncatedContent = head + truncationMessage + tail;
        break;
    }

    const finalTokens = this.estimate(truncatedContent, { charsPerToken });

    return {
      content: truncatedContent,
      truncated: true,
      originalTokens,
      finalTokens,
      removedTokens: originalTokens - finalTokens,
    };
  }

  /**
   * 按行截断文本
   *
   * 与 truncate 不同，此方法保证不会在行中间截断
   *
   * @param text - 要截断的文本
   * @param options - 截断选项
   * @returns 截断结果
   */
  static truncateByLines(
    text: string,
    options: TruncateOptions
  ): TruncateResult {
    const charsPerToken = options.charsPerToken ?? this.DEFAULT_CHARS_PER_TOKEN;
    const strategy = options.strategy ?? 'tail';
    const truncationMessage =
      options.truncationMessage ?? '\n[... content truncated ...]';

    const lines = text.split('\n');
    const originalTokens = this.estimate(text, { charsPerToken });

    // 如果未超过限制，直接返回
    if (originalTokens <= options.maxTokens) {
      return {
        content: text,
        truncated: false,
        originalTokens,
        finalTokens: originalTokens,
        removedTokens: 0,
      };
    }

    const messageTokens = this.estimate(truncationMessage, { charsPerToken });
    const availableTokens = options.maxTokens - messageTokens;

    let selectedLines: string[];
    let currentTokens = 0;

    switch (strategy) {
      case 'head':
        // 从头部开始选择行
        selectedLines = [];
        for (const line of lines) {
          const lineTokens = this.estimate(line + '\n', { charsPerToken });
          if (currentTokens + lineTokens > availableTokens) break;
          selectedLines.push(line);
          currentTokens += lineTokens;
        }
        break;

      case 'tail':
        // 从尾部开始选择行
        selectedLines = [];
        for (let i = lines.length - 1; i >= 0; i--) {
          const lineTokens = this.estimate(lines[i] + '\n', { charsPerToken });
          if (currentTokens + lineTokens > availableTokens) break;
          selectedLines.unshift(lines[i]);
          currentTokens += lineTokens;
        }
        break;

      case 'middle':
        // 从头尾各选一半
        const halfTokens = Math.floor(availableTokens / 2);
        const headLines: string[] = [];
        const tailLines: string[] = [];

        // 选择头部
        let headTokens = 0;
        for (const line of lines) {
          const lineTokens = this.estimate(line + '\n', { charsPerToken });
          if (headTokens + lineTokens > halfTokens) break;
          headLines.push(line);
          headTokens += lineTokens;
        }

        // 选择尾部
        let tailTokens = 0;
        for (let i = lines.length - 1; i >= 0; i--) {
          const lineTokens = this.estimate(lines[i] + '\n', { charsPerToken });
          if (tailTokens + lineTokens > halfTokens) break;
          tailLines.unshift(lines[i]);
          tailTokens += lineTokens;
        }

        selectedLines = headLines;
        currentTokens = headTokens + tailTokens;
        break;
    }

    const truncatedContent =
      strategy === 'tail'
        ? truncationMessage + '\n' + selectedLines.join('\n')
        : strategy === 'head'
          ? selectedLines.join('\n') + '\n' + truncationMessage
          : selectedLines.join('\n') + '\n' + truncationMessage;

    const finalTokens = this.estimate(truncatedContent, { charsPerToken });

    return {
      content: truncatedContent,
      truncated: true,
      originalTokens,
      finalTokens,
      removedTokens: originalTokens - finalTokens,
    };
  }

  /**
   * 批量估算多个文本的总 Token 数
   *
   * @param texts - 文本数组
   * @param options - 估算选项
   * @returns 总 Token 数
   */
  static estimateBatch(
    texts: string[],
    options: TokenEstimateOptions = {}
  ): number {
    return texts.reduce((total, text) => total + this.estimate(text, options), 0);
  }

  /**
   * 估算消息数组的总 Token 数（包括消息格式开销）
   *
   * @param messages - 消息数组
   * @param options - 估算选项
   * @returns 总 Token 数
   */
  static estimateMessages(
    messages: Array<{ role: string; content: string }>,
    options: TokenEstimateOptions = {}
  ): number {
    let total = 0;

    for (const message of messages) {
      // 内容 Token
      total += this.estimate(message.content, options);
      // 消息格式开销（role, formatting 等，粗略估算为 4 tokens）
      total += 4;
    }

    // 消息数组格式开销
    total += 3;

    return total;
  }

  /**
   * 智能截断：根据内容类型选择最佳策略
   *
   * @param text - 要截断的文本
   * @param maxTokens - 最大 Token 数
   * @param contentType - 内容类型提示
   * @returns 截断结果
   */
  static smartTruncate(
    text: string,
    maxTokens: number,
    contentType: 'code' | 'text' | 'log' = 'text'
  ): TruncateResult {
    const options: TruncateOptions = { maxTokens };

    switch (contentType) {
      case 'code':
        // 代码：保留头部和尾部（函数定义和结尾）
        options.strategy = 'middle';
        options.truncationMessage = '\n// ... code truncated ...\n';
        return this.truncateByLines(text, options);

      case 'log':
        // 日志：保留尾部（最新的日志）
        options.strategy = 'tail';
        options.truncationMessage = '[... earlier logs truncated ...]\n';
        return this.truncateByLines(text, options);

      case 'text':
      default:
        // 普通文本：保留头部
        options.strategy = 'head';
        return this.truncate(text, options);
    }
  }
}
