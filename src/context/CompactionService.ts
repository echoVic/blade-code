/**
 * 上下文压缩服务
 * 负责协调整个压缩流程：分析文件、生成总结、创建压缩消息
 */

import { nanoid } from 'nanoid';
import { PermissionMode } from '../config/types.js';
import { HookManager } from '../hooks/HookManager.js';
import {
  createChatServiceAsync,
  type Message,
} from '../services/ChatServiceInterface.js';
import { FileAnalyzer, type FileContent } from './FileAnalyzer.js';
import { TokenCounter } from './TokenCounter.js';

/**
 * 压缩选项
 */
export interface CompactionOptions {
  /** 触发方式：自动或手动 */
  trigger: 'auto' | 'manual';
  /** 模型名称 */
  modelName: string;
  /** 上下文窗口大小（从 config.maxContextTokens 传入） */
  maxContextTokens: number;
  /** API Key（可选，默认使用环境变量） */
  apiKey?: string;
  /** Base URL（可选，默认使用环境变量） */
  baseURL?: string;
  /** 真实的 preTokens（可选，来自 LLM usage，比估算更准确） */
  actualPreTokens?: number;
  /** 会话 ID（用于 hooks） */
  sessionId?: string;
  /** 权限模式（用于 hooks） */
  permissionMode?: PermissionMode;
}

/**
 * 压缩结果
 */
export interface CompactionResult {
  /** 是否成功 */
  success: boolean;
  /** 总结内容 */
  summary: string;
  /** 压缩前 token 数 */
  preTokens: number;
  /** 压缩后 token 数 */
  postTokens: number;
  /** 包含的文件列表 */
  filesIncluded: string[];
  /** 压缩后的消息列表（用于发送给 LLM） */
  compactedMessages: Message[];
  /** compact_boundary 消息（用于保存到 JSONL） */
  boundaryMessage: Message;
  /** summary 消息（用于保存到 JSONL） */
  summaryMessage: Message;
  /** 错误信息（如果失败） */
  error?: string;
}

/**
 * Compaction Service - 上下文压缩服务
 */
export class CompactionService {
  /** 压缩阈值百分比（80%） */
  private static readonly THRESHOLD_PERCENT = 0.8;

  /** 保留比例（20%） */
  private static readonly RETAIN_PERCENT = 0.2;

  /** 降级时保留比例（30%） */
  private static readonly FALLBACK_RETAIN_PERCENT = 0.3;

  /**
   * 执行压缩
   *
   * @param messages - 消息列表
   * @param options - 压缩选项
   * @returns 压缩结果
   */
  static async compact(
    messages: Message[],
    options: CompactionOptions
  ): Promise<CompactionResult> {
    // 优先使用传入的真实 preTokens（来自 LLM usage），否则使用估算
    const preTokens =
      options.actualPreTokens ?? TokenCounter.countTokens(messages, options.modelName);
    const tokenSource = options.actualPreTokens
      ? 'actual (from LLM usage)'
      : 'estimated';
    console.log(`[CompactionService] preTokens source: ${tokenSource}`);

    // 执行 Compaction Hook（压缩前）
    // Hook 可以阻止压缩
    try {
      const hookManager = HookManager.getInstance();
      const hookResult = await hookManager.executeCompactionHooks(options.trigger, {
        projectDir: process.cwd(),
        sessionId: options.sessionId || 'unknown',
        permissionMode: options.permissionMode || PermissionMode.DEFAULT,
        messagesBefore: messages.length,
        tokensBefore: preTokens,
      });

      // 如果 hook 返回 blockCompaction: true，阻止压缩
      if (hookResult.blockCompaction) {
        console.log(
          `[CompactionService] Compaction hook 阻止压缩: ${hookResult.blockReason || '(无原因)'}`
        );
        return {
          success: false,
          summary: '',
          preTokens,
          postTokens: preTokens,
          filesIncluded: [],
          compactedMessages: messages,
          boundaryMessage: { role: 'system', content: '' } as Message,
          summaryMessage: { role: 'user', content: '' } as Message,
          error: hookResult.blockReason || 'Compaction blocked by hook',
        };
      }

      // 如果有警告，记录日志
      if (hookResult.warning) {
        console.warn(
          `[CompactionService] Compaction hook warning: ${hookResult.warning}`
        );
      }
    } catch (hookError) {
      // Hook 执行失败不应阻止压缩
      console.warn('[CompactionService] Compaction hook execution failed:', hookError);
    }

    try {
      console.log('[CompactionService] 开始压缩，消息数:', messages.length);
      console.log('[CompactionService] 压缩前 tokens:', preTokens);

      // 1. 分析并读取重点文件
      const fileRefs = FileAnalyzer.analyzeFiles(messages);
      const filePaths = fileRefs.map((f) => f.path);
      console.log('[CompactionService] 提取重点文件:', filePaths);

      const fileContents = await FileAnalyzer.readFilesContent(filePaths);
      console.log('[CompactionService] 成功读取文件:', fileContents.length);

      // 2. 生成总结
      const summary = await this.generateSummary(messages, fileContents, options);
      console.log('[CompactionService] 生成总结，长度:', summary.length);

      // 3. 计算保留范围并过滤孤儿 tool 消息
      const retainCount = Math.ceil(messages.length * this.RETAIN_PERCENT);
      const candidateMessages = messages.slice(-retainCount);

      // 收集保留消息中所有 tool_call 的 ID
      const availableToolCallIds = new Set<string>();
      for (const msg of candidateMessages) {
        if (msg.role === 'assistant' && msg.tool_calls) {
          for (const tc of msg.tool_calls) {
            availableToolCallIds.add(tc.id);
          }
        }
      }

      // 过滤掉孤儿 tool 消息（tool_call_id 对应的 assistant 消息已被压缩）
      const retainedMessages = candidateMessages.filter((msg) => {
        if (msg.role === 'tool' && msg.tool_call_id) {
          return availableToolCallIds.has(msg.tool_call_id);
        }
        return true; // 保留其他所有消息
      });

      console.log('[CompactionService] 保留消息数:', retainCount);
      console.log('[CompactionService] 过滤后保留消息数:', retainedMessages.length);

      // 4. 创建压缩消息
      const boundaryMessageId = nanoid();
      const boundaryMessage = this.createBoundaryMessage(
        boundaryMessageId,
        options.trigger,
        preTokens
      );

      const summaryMessageId = nanoid();
      const summaryMessage = this.createSummaryMessage(summaryMessageId, summary);

      // 5. 构建新消息列表（用于发送给 LLM）
      const compactedMessages = [summaryMessage, ...retainedMessages];
      const postTokens = TokenCounter.countTokens(compactedMessages, options.modelName);

      console.log('[CompactionService] 压缩完成！');
      console.log(
        '[CompactionService] Token 变化:',
        preTokens,
        '→',
        postTokens,
        `(-${((1 - postTokens / preTokens) * 100).toFixed(1)}%)`
      );

      return {
        success: true,
        summary,
        preTokens,
        postTokens,
        filesIncluded: filePaths,
        compactedMessages,
        boundaryMessage,
        summaryMessage,
      };
    } catch (error) {
      console.error('[CompactionService] 压缩失败，使用降级策略', error);
      return this.fallbackCompact(messages, options, preTokens, error);
    }
  }

  /**
   * 生成总结（调用 LLM）
   *
   * @param messages - 消息列表
   * @param fileContents - 文件内容列表
   * @param options - 压缩选项
   * @returns 总结内容
   */
  private static async generateSummary(
    messages: Message[],
    fileContents: FileContent[],
    options: CompactionOptions
  ): Promise<string> {
    const prompt = this.buildCompactionPrompt(messages, fileContents);

    console.log('[CompactionService] 使用压缩模型:', options.modelName);

    // 创建 ChatService
    const chatService = await createChatServiceAsync({
      apiKey: options.apiKey || process.env.BLADE_API_KEY || '',
      baseUrl:
        options.baseURL || process.env.BLADE_BASE_URL || 'https://api.openai.com/v1',
      model: options.modelName,
      temperature: 0.3,
      maxOutputTokens: 8000, // 压缩输出限制
      timeout: 60000,
      provider: 'openai-compatible' as const,
    });

    const response = await chatService.chat(
      [{ role: 'user', content: prompt }]
      // 不传递工具参数（使用默认空数组）
    );

    // 提取 <summary> 标签内容
    const content = response.content || '';
    const summaryMatch = content.match(/<summary>([\s\S]*?)<\/summary>/);

    if (!summaryMatch) {
      console.warn('[CompactionService] 总结格式不正确，使用完整响应');
      // 如果没有找到标签，返回完整响应
      return content;
    }

    return summaryMatch[1].trim();
  }

  /**
   * 构建压缩 prompt
   *
   * @param messages - 消息列表
   * @param fileContents - 文件内容列表
   * @returns 压缩 prompt
   */
  private static buildCompactionPrompt(
    messages: Message[],
    fileContents: FileContent[]
  ): string {
    // 格式化消息历史
    const messagesText = messages
      .map((msg, i) => {
        const role = msg.role || 'unknown';
        const content =
          typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);

        // 如果消息太长，截断
        const maxLength = 5000;
        const truncatedContent =
          content.length > maxLength
            ? content.substring(0, maxLength) + '...'
            : content;

        return `[${i + 1}] ${role}: ${truncatedContent}`;
      })
      .join('\n\n');

    // 格式化文件内容
    const filesText = fileContents
      .map((file) => {
        return `### ${file.path}\n\`\`\`\n${file.content}\n\`\`\``;
      })
      .join('\n\n');

    // 基础 prompt（用户提供的）
    const basePrompt = `Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions.
This summary should be thorough in capturing technical details, code patterns, and architectural decisions that would be essential for continuing development work without losing context.

Before providing your final summary, wrap your analysis in <analysis> tags to organize your thoughts and ensure you've covered all necessary points. In your analysis process:

1. Chronologically analyze each message and section of the conversation. For each section thoroughly identify:
   - The user's explicit requests and intents
   - Your approach to addressing the user's requests
   - Key decisions, technical concepts and code patterns
   - Specific details like:
     - file names
     - full code snippets
     - function signatures
     - file edits
  - Errors that you ran into and how you fixed them
  - Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
2. Double-check for technical accuracy and completeness, addressing each required element thoroughly.

Your summary should include the following sections:

1. Primary Request and Intent: Capture all of the user's explicit requests and intents in detail
2. Key Technical Concepts: List all important technical concepts, technologies, and frameworks discussed.
3. Files and Code Sections: Enumerate specific files and code sections examined, modified, or created. Pay special attention to the most recent messages and include full code snippets where applicable and include a summary of why this file read or edit is important.
4. Errors and fixes: List all errors that you ran into, and how you fixed them. Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
5. Problem Solving: Document problems solved and any ongoing troubleshooting efforts.
6. All user messages: List ALL user messages that are not tool results. These are critical for understanding the users' feedback and changing intent.
7. Pending Tasks: Outline any pending tasks that you have explicitly been asked to work on.
8. Current Work: Describe in detail precisely what was being worked on immediately before this summary request, paying special attention to the most recent messages from both user and assistant. Include file names and code snippets where applicable.
9. Optional Next Step: List the next step that you will take that is related to the most recent work you were doing. IMPORTANT: ensure that this step is DIRECTLY in line with the user's most recent explicit requests, and the task you were working on immediately before this summary request.`;

    return `${basePrompt}

## Conversation History

${messagesText}

${fileContents.length > 0 ? `## Important Files\n\n${filesText}` : ''}

Please provide your summary following the structure specified above, with both <analysis> and <summary> sections.`;
  }

  /**
   * 创建 compact_boundary 消息
   *
   * @param parentId - 父消息 ID
   * @param trigger - 触发方式
   * @param preTokens - 压缩前 token 数
   * @returns boundary 消息
   */
  private static createBoundaryMessage(
    parentId: string,
    trigger: 'auto' | 'manual',
    preTokens: number
  ): Message {
    return {
      id: nanoid(),
      role: 'system',
      content: 'Conversation compacted',
      // 使用 metadata 存储额外信息
      metadata: {
        type: 'system',
        subtype: 'compact_boundary',
        parentId,
        compactMetadata: {
          trigger,
          preTokens,
        },
      },
    } as Message;
  }

  /**
   * 创建 summary 消息
   *
   * @param parentId - 父消息 ID（compact_boundary 的 ID）
   * @param summary - 总结内容
   * @returns summary 消息
   */
  private static createSummaryMessage(parentId: string, summary: string): Message {
    return {
      id: nanoid(),
      role: 'user',
      content: summary,
      metadata: {
        parentId,
        isCompactSummary: true,
      },
    } as Message;
  }

  /**
   * 降级策略：简单截断
   *
   * @param messages - 消息列表
   * @param options - 压缩选项
   * @param preTokens - 压缩前 token 数
   * @param error - 错误信息
   * @returns 压缩结果
   */
  private static fallbackCompact(
    messages: Message[],
    options: CompactionOptions,
    preTokens: number,
    error: unknown
  ): CompactionResult {
    const retainCount = Math.ceil(messages.length * this.FALLBACK_RETAIN_PERCENT);
    const candidateMessages = messages.slice(-retainCount);

    // 收集保留消息中所有 tool_call 的 ID
    const availableToolCallIds = new Set<string>();
    for (const msg of candidateMessages) {
      if (msg.role === 'assistant' && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          availableToolCallIds.add(tc.id);
        }
      }
    }

    // 过滤掉孤儿 tool 消息
    const retainedMessages = candidateMessages.filter((msg) => {
      if (msg.role === 'tool' && msg.tool_call_id) {
        return availableToolCallIds.has(msg.tool_call_id);
      }
      return true;
    });

    const boundaryMessageId = nanoid();
    const boundaryMessage = this.createBoundaryMessage(
      boundaryMessageId,
      options.trigger,
      preTokens
    );

    const errorMsg = error instanceof Error ? error.message : String(error);
    const summaryMessageId = nanoid();
    const summaryMessage = this.createSummaryMessage(
      summaryMessageId,
      `[Automatic compaction failed; using fallback]\n\nAn error occurred during compaction. Retained the latest ${retainCount} messages (~30%).\n\nError: ${errorMsg}\n\nThe conversation can continue, but consider retrying compaction later with /compact.`
    );

    const compactedMessages = [summaryMessage, ...retainedMessages];
    const postTokens = TokenCounter.countTokens(compactedMessages, options.modelName);

    return {
      success: false,
      summary:
        typeof summaryMessage.content === 'string'
          ? summaryMessage.content
          : summaryMessage.content
              .filter((p) => p.type === 'text')
              .map((p) => (p as { text: string }).text)
              .join('\n'),
      preTokens,
      postTokens,
      filesIncluded: [],
      compactedMessages,
      boundaryMessage,
      summaryMessage,
      error: errorMsg,
    };
  }
}
