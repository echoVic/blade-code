/**
 * ConversationState — 单一消息状态模型
 *
 * 消除 executeLoopGenerator 中 `messages` 与 `context.messages` 双源状态不同步问题。
 *
 * ## 设计
 *
 * - `systemMessages`: 系统提示词（排除在压缩之外）
 * - `history`:        可压缩的会话历史（对应原 context.messages）
 * - `pending`:        当前轮次追加的消息（assistant + tool results），尚未写回 history
 *
 * `toLLMMessages()` = systemMessages + history + pending
 *
 * ## 6 Invariants
 *
 * 1. `systemMessages` 只含 `role === 'system'` 且 `Array.isArray(content)` 的根系统提示
 * 2. `history` 初始值 === context.messages（引用拷贝）
 * 3. 压缩操作仅替换 `history`
 * 4. `pending` 在每轮 LLM 调用前为空
 * 5. `commitPending()` 将 pending 追加到 history 并清空 pending
 * 6. `writeback()` 将 history 回写到 context.messages（try/finally 单出口）
 */

import type { Message } from '../../services/ChatServiceInterface.js';
import type { ChatContext } from '../types.js';

/**
 * 判断一条消息是否是根系统提示词。
 *
 * 根系统提示词的特征：
 * - role === 'system'
 * - content 是 Array (ContentPart[])，包含 cacheControl 等 provider 配置
 *
 * 区别于 snip 压缩产生的占位消息（role === 'system', content 是 string）。
 */
export function isRootSystemPrompt(msg: Message): boolean {
  return msg.role === 'system' && Array.isArray(msg.content);
}

export function isContextualProjectInstructionMessage(msg: Message): boolean {
  if (msg.role !== 'system' || !msg.metadata || Array.isArray(msg.metadata)) {
    return false;
  }
  return (
    typeof msg.metadata === 'object' && msg.metadata.contextualProjectRules === true
  );
}

export class ConversationState {
  /** 系统提示词（不参与压缩） */
  readonly systemMessages: Message[];
  private _contextualSystemMessages: Message[];

  /** 可压缩的会话历史 — 对应原 context.messages */
  private _history: Message[];

  /** 当前轮次追加的消息（assistant + tool results） */
  private _pending: Message[] = [];

  /** 非追加式上下文变更代际，用于失效 Provider token 基线。 */
  private _contextRevision = 0;

  /** 原始 context 引用（用于 writeback） */
  private readonly context: ChatContext;

  constructor(context: ChatContext, systemPrompt: string | undefined) {
    this.context = context;

    // 从 context.messages 中提取已有的根系统提示
    const existingRootPrompt = context.messages.find(isRootSystemPrompt);
    this._contextualSystemMessages = context.messages.filter(
      isContextualProjectInstructionMessage
    );

    // 构建 systemMessages — 根 system prompt 必须从 history 中隔离，
    // 确保 compaction 不会改写或丢掉它（Invariant #1）
    if (existingRootPrompt) {
      // 从持久化恢复的根 system prompt，提取到 systemMessages
      this.systemMessages = [existingRootPrompt, ...this._contextualSystemMessages];
    } else if (systemPrompt) {
      // 没有现有的根系统提示，注入新的
      this.systemMessages = [
        {
          role: 'system',
          content: [
            {
              type: 'text',
              text: systemPrompt,
              providerOptions: {
                anthropic: { cacheControl: { type: 'ephemeral' } },
              },
            },
          ],
        },
        ...this._contextualSystemMessages,
      ];
    } else {
      this.systemMessages = [...this._contextualSystemMessages];
    }

    // history = context.messages 中排除根系统提示
    // 根 system prompt 已在 systemMessages 中，不参与 compaction
    this._history = context.messages.filter(
      (msg) => !isRootSystemPrompt(msg) && !isContextualProjectInstructionMessage(msg)
    );
  }

  /** 当前 history 长度（压缩检查使用） */
  get historyLength(): number {
    return this._history.length;
  }

  /** 获取 history 引用（用于压缩服务读取） */
  get history(): Message[] {
    return this._history;
  }

  /** 获取 pending 引用（用于调试） */
  get pending(): ReadonlyArray<Message> {
    return this._pending;
  }

  get contextRevision(): number {
    return this._contextRevision;
  }

  /**
   * 组装完整的 LLM 消息数组
   *
   * = systemMessages + history + pending
   */
  toLLMMessages(): Message[] {
    return [...this.systemMessages, ...this._history, ...this._pending];
  }

  /** toLLMMessages 的别名，与计划 API 保持一致 */
  getMessagesForLLM(): Message[] {
    return this.toLLMMessages();
  }

  /** 返回 history 的副本 */
  getHistory(): Message[] {
    return this._history;
  }

  /**
   * 追加消息到 pending（当前轮次的 assistant/tool/user 消息）
   */
  appendPending(msg: Message): void {
    this._pending.push(msg);
  }

  /** 追加用户消息到 pending */
  appendUser(msg: Message): void {
    this._pending.push(msg);
  }

  /** 追加助手消息到 pending */
  appendAssistant(msg: Message): void {
    this._pending.push(msg);
  }

  /** 追加工具结果消息到 pending */
  appendToolResult(msg: Message): void {
    this._pending.push(msg);
  }

  appendContextualProjectInstructions(msg: Message): void {
    if (!isContextualProjectInstructionMessage(msg)) {
      throw new Error('Contextual project instructions require safe metadata');
    }
    this._contextualSystemMessages.push(msg);
    this.systemMessages.push(msg);
  }

  private syncContextualSystemMessages(): void {
    const roots = this.systemMessages.filter(isRootSystemPrompt);
    this.systemMessages.splice(
      0,
      this.systemMessages.length,
      ...roots,
      ...this._contextualSystemMessages
    );
  }

  /**
   * 追加控制消息到 pending。
   * role === 'system' 时抛出异常（根系统提示只能通过构造函数设置）。
   */
  appendControl(role: string, msg: Message): void {
    if (role === 'system') {
      throw new Error(
        'Cannot append system control message via appendControl. Use constructor for root system prompt.'
      );
    }
    this._pending.push(msg);
  }

  appendDurableControl(message: Message): void {
    if (!message.id || message.role !== 'user') {
      throw new Error('Durable control messages require a user role and identity');
    }
    if (this._history.some((candidate) => candidate.id === message.id)) {
      return;
    }
    this._history.push(message);
  }

  /**
   * 直接追加消息到 history（跳过 pending）。
   *
   * 用于 recovery prompt 等需要绕过 pending 队列的场景。
   * 注意：不要与 appendAssistant/appendControl 混用同一组消息，
   * 否则 commitPending() 会导致顺序错乱或重复。
   */
  appendToHistory(msg: Message): void {
    this._history.push(msg);
  }

  /**
   * 将 pending 提交到 history 并清空 pending。
   * 在每轮工具执行结束后、进入下一轮 LLM 调用前调用。
   */
  commitPending(): void {
    if (this._pending.length > 0) {
      this._history.push(...this._pending);
      this._pending = [];
    }
  }

  /**
   * 替换 history（压缩后调用）
   *
   * 自动过滤掉根 system prompt，确保 Invariant #1：
   * 根 system prompt 只存在于 systemMessages 中，不会出现在 history 里。
   *
   * 调用后 pending 保持不变（压缩不影响当前轮次的 pending 消息）。
   * toLLMMessages() 会自动反映新 history。
   */
  replaceHistory(newHistory: Message[]): void {
    this._history = newHistory.filter(
      (msg) => !isRootSystemPrompt(msg) && !isContextualProjectInstructionMessage(msg)
    );
    this._contextRevision++;
  }

  /** Replace all mutable state with an authoritative durable projection. */
  restoreDurableHistory(messages: Message[]): void {
    this._contextualSystemMessages = messages.filter(
      isContextualProjectInstructionMessage
    );
    this._history = messages.filter(
      (message) =>
        !isRootSystemPrompt(message) && !isContextualProjectInstructionMessage(message)
    );
    this._pending = [];
    this.syncContextualSystemMessages();
    this._contextRevision++;
  }

  removeMessages(predicate: (message: Message) => boolean): void {
    const previousLengths = [
      this._history.length,
      this._pending.length,
      this._contextualSystemMessages.length,
    ] as const;
    this._history = this._history.filter((message) => !predicate(message));
    this._pending = this._pending.filter((message) => !predicate(message));
    this._contextualSystemMessages = this._contextualSystemMessages.filter(
      (message) => !predicate(message)
    );
    this.syncContextualSystemMessages();
    if (
      this._history.length !== previousLengths[0] ||
      this._pending.length !== previousLengths[1] ||
      this._contextualSystemMessages.length !== previousLengths[2]
    ) {
      this._contextRevision++;
    }
  }

  /**
   * 回写 history 到 context.messages。
   *
   * 在 try/finally 中调用，确保所有退出路径都执行回写。
   * 先 commitPending() 确保当前轮次的消息也被包含。
   */
  writeback(): void {
    this.commitPending();
    this.context.messages = [...this._contextualSystemMessages, ...this._history];
  }

  /**
   * 是否有根系统提示（用于压缩重建逻辑）
   */
  get hasSystemPrompt(): boolean {
    return this.systemMessages.length > 0;
  }
}
