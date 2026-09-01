/**
 * CompactionService 单元测试
 * 测试上下文压缩服务的孤儿 tool 消息过滤逻辑和 post-compact 文件恢复
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  buildCompactionPrompt,
  type CompactionOptions,
  CompactionService,
  extractExactContinuationRecords,
  MAX_COMPACTION_CONTEXT_RATIO,
  MAX_COMPACTION_RESULT_RATIO,
  MAX_COMPACTION_TARGET_TOKENS,
  MIN_COMPACTION_EFFECTIVENESS_TOKENS,
  reconcileExactContinuationRecords,
  resetCompactionCircuitBreaker,
} from '../../../../src/context/CompactionService.js';
import type { FileContent } from '../../../../src/context/FileAnalyzer.js';
import {
  isTokenBudgetHandoffMessage,
  projectTokenBudgetHandoffEvent,
  stripTokenBudgetHandoffMessages,
} from '../../../../src/context/TokenBudgetHandoff.js';
import { TokenCounter } from '../../../../src/context/TokenCounter.js';
import type { TokenBudgetHandoffRecordedEvent } from '../../../../src/context/types.js';
import { HookManager } from '../../../../src/hooks/HookManager.js';
import {
  createChatServiceAsync,
  type Message,
} from '../../../../src/services/ChatServiceInterface.js';
import { FileAccessTracker } from '../../../../src/tools/builtin/file/FileAccessTracker.js';

const { compactChat } = vi.hoisted(() => ({
  compactChat: vi.fn(),
}));

vi.mock('../../../../src/services/ChatServiceInterface.js', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../../../src/services/ChatServiceInterface.js')
    >();
  return {
    ...actual,
    createChatServiceAsync: vi.fn(async () => ({ chat: compactChat })),
  };
});

function validHandoffEvent(): TokenBudgetHandoffRecordedEvent {
  return {
    id: 'handoff-event-1',
    sessionId: 'token-budget-session',
    timestamp: '2026-08-19T00:00:00.000Z',
    type: 'token_budget_handoff_recorded',
    cwd: '/tmp/token-budget-compaction',
    version: 'test',
    data: {
      version: 1,
      messageId: 'handoff-message-1',
      observedPromptTokens: 70_000,
      availableForInput: 100_000,
      handoffThreshold: 70_000,
      compactionThreshold: 80_000,
      createdAt: '2026-08-19T00:00:00.000Z',
    },
  } satisfies TokenBudgetHandoffRecordedEvent;
}

function projectedHandoff(): Message {
  const marker = projectTokenBudgetHandoffEvent(validHandoffEvent());
  if (!marker) {
    throw new Error('Expected a valid token-budget handoff marker fixture');
  }
  return marker;
}

function markerRetainedSourceMessages(marker: Message): Message[] {
  return [
    { role: 'user', content: 'before-1' },
    { role: 'assistant', content: 'before-2' },
    { role: 'user', content: 'before-3' },
    { role: 'assistant', content: 'before-4' },
    marker,
    { role: 'assistant', content: 'after' },
  ];
}

const markerCompactionOptions: CompactionOptions = {
  trigger: 'auto',
  modelName: 'test-model',
  maxContextTokens: 128_000,
  apiKey: 'test-key',
  baseURL: 'https://example.invalid',
  workspaceRoot: '/tmp/token-budget-compaction',
  sessionId: 'token-budget-session',
};

describe('CompactionService - 输出协议', () => {
  test('摘要请求应移除 token-budget marker', async () => {
    const marker = projectedHandoff();
    const sourceMessages = markerRetainedSourceMessages(marker);
    compactChat.mockResolvedValueOnce({
      content: '<summary>ledger</summary>',
      usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
    });

    await CompactionService.compact(sourceMessages, markerCompactionOptions);

    const prompt = String(compactChat.mock.calls.at(-1)?.[0]?.[0]?.content);
    expect(prompt).not.toContain(String(marker.content));
  });

  test('摘要请求应保留多模态文本但用固定占位符替换所有图片', async () => {
    const inlineSecret = 'INLINE_IMAGE_PAYLOAD_MUST_NOT_LEAK';
    const remoteSecret = 'REMOTE_IMAGE_URL_MUST_NOT_LEAK';
    const messages: Message[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Inspect the attached evidence.' },
          {
            type: 'image_url',
            image_url: {
              url: `data:image/png;base64,${inlineSecret}`,
            },
          },
          {
            type: 'image_url',
            image_url: {
              url: `https://images.example.invalid/${remoteSecret}.png`,
            },
          },
        ],
      },
    ];
    const original = structuredClone(messages);
    compactChat.mockResolvedValueOnce({
      content: '<summary>Image evidence was attached.</summary>',
    });

    const result = await CompactionService.compact(messages, {
      ...markerCompactionOptions,
      sessionId: 'rich-media-elision',
    });

    const prompt = String(compactChat.mock.calls.at(-1)?.[0]?.[0]?.content);
    expect(result.success).toBe(true);
    expect(result.imagesOmitted).toBe(2);
    expect(prompt).toContain('Inspect the attached evidence.');
    expect(prompt.match(/\[image omitted from compaction\]/g)).toHaveLength(2);
    expect(prompt).not.toContain(inlineSecret);
    expect(prompt).not.toContain(remoteSecret);
    expect(messages).toEqual(original);
  });

  test('LLM replacement 应移除 token-budget marker', async () => {
    const marker = projectedHandoff();
    const sourceMessages = markerRetainedSourceMessages(marker);
    compactChat.mockResolvedValueOnce({
      content: '<summary>ledger</summary>',
      usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
    });

    const result = await CompactionService.compact(
      sourceMessages,
      markerCompactionOptions
    );

    expect(result.compactedMessages.some(isTokenBudgetHandoffMessage)).toBe(false);
  });

  test('marker 被剥离后 actual usage 不得旁路进入 token count 或 hook', async () => {
    const marker = projectedHandoff();
    const sourceMessages = markerRetainedSourceMessages(marker);
    const filteredMessages = stripTokenBudgetHandoffMessages(sourceMessages);
    const expectedPreTokens = TokenCounter.countTokens(
      filteredMessages,
      markerCompactionOptions.modelName
    );
    const hookSpy = vi
      .spyOn(HookManager.getInstance(), 'executeCompactionHooks')
      .mockResolvedValueOnce({ blockCompaction: false });
    compactChat.mockResolvedValueOnce({
      content: '<summary>ledger</summary>',
      usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
    });

    try {
      const result = await CompactionService.compact(sourceMessages, {
        ...markerCompactionOptions,
        actualPreTokens: 99_999,
      });

      expect(result.preTokens).toBe(expectedPreTokens);
      expect(hookSpy).toHaveBeenCalledWith(
        'auto',
        expect.objectContaining({
          messagesBefore: filteredMessages.length,
          tokensBefore: expectedPreTokens,
        })
      );
    } finally {
      hookSpy.mockRestore();
    }
  });

  test('hook 明确阻止压缩时不得形成无 marker checkpoint', async () => {
    const marker = projectedHandoff();
    const sourceMessages = markerRetainedSourceMessages(marker);
    const hookSpy = vi
      .spyOn(HookManager.getInstance(), 'executeCompactionHooks')
      .mockResolvedValueOnce({
        blockCompaction: true,
        blockReason: 'policy denied compaction',
      });

    try {
      await expect(
        CompactionService.compact(sourceMessages, markerCompactionOptions)
      ).rejects.toThrow('policy denied compaction');
      expect(compactChat).not.toHaveBeenCalled();
      expect(sourceMessages.some(isTokenBudgetHandoffMessage)).toBe(true);
    } finally {
      hookSpy.mockRestore();
    }
  });

  test('deterministic fallback replacement 应移除 token-budget marker', async () => {
    const marker = projectedHandoff();
    const sourceMessages = [
      ...markerRetainedSourceMessages(marker),
      {
        role: 'user' as const,
        content: [
          {
            type: 'image_url' as const,
            image_url: { url: 'data:image/png;base64,FALLBACK_IMAGE' },
          },
        ],
      },
    ];
    compactChat.mockRejectedValueOnce(new Error('summary unavailable'));

    const result = await CompactionService.compact(
      sourceMessages,
      markerCompactionOptions
    );

    expect(result.success).toBe(false);
    expect(result.compactedMessages.some(isTokenBudgetHandoffMessage)).toBe(false);
    expect(result.sampleAttempts).toBe(1);
    expect(result.imagesOmitted).toBe(1);
    expect(result.failureReason).toBe('deterministic');
    expect(compactChat).toHaveBeenCalledOnce();
  });

  test('deterministic fallback 应按 token 目标截断超大单消息并保留头尾', async () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: `HEAD_KEEP ${'historical payload '.repeat(8_000)} TAIL_KEEP`,
      },
    ];
    const original = structuredClone(messages);
    compactChat.mockRejectedValueOnce(new Error('summary unavailable'));

    const result = await CompactionService.compact(messages, {
      ...markerCompactionOptions,
      maxContextTokens: 6_000,
      sessionId: 'fallback-single-message-budget',
    });

    expect(result.success).toBe(false);
    expect(result.fallbackTargetTokens).toBe(
      Math.floor(6_000 * MAX_COMPACTION_CONTEXT_RATIO)
    );
    expect(result.postTokens).toBeLessThanOrEqual(result.fallbackTargetTokens!);
    expect(result.fallbackMessagesOmitted).toBe(0);
    expect(result.fallbackMessagesTruncated).toBe(1);
    expect(String(result.compactedMessages[1]?.content)).toContain('HEAD_KEEP');
    expect(String(result.compactedMessages[1]?.content)).toContain('TAIL_KEEP');
    expect(String(result.compactedMessages[1]?.content)).toContain(
      'message truncated to fit fallback token budget'
    );
    expect(messages).toEqual(original);
  });

  test('deterministic fallback 在超大 context window 中仍受绝对 token 上限约束', async () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: `ABSOLUTE_HEAD_${'0123456789abcdef'.repeat(50_000)}_ABSOLUTE_TAIL`,
      },
    ];
    compactChat.mockRejectedValueOnce(new Error('summary unavailable'));

    const result = await CompactionService.compact(messages, {
      ...markerCompactionOptions,
      maxContextTokens: 1_000_000,
      sessionId: 'fallback-absolute-budget',
    });

    expect(result.fallbackTargetTokens).toBe(MAX_COMPACTION_TARGET_TOKENS);
    expect(result.postTokens).toBeLessThanOrEqual(MAX_COMPACTION_TARGET_TOKENS);
    expect(result.fallbackMessagesTruncated).toBe(1);
  });

  test('deterministic fallback 应原子保留并截断最新 tool-call 单元', async () => {
    const messages: Message[] = [
      { role: 'user', content: `old context ${'old '.repeat(8_000)}` },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'bounded-tool-call',
            type: 'function',
            function: { name: 'Read', arguments: '{"file_path":"large.log"}' },
          },
        ],
      },
      {
        role: 'tool',
        name: 'Read',
        tool_call_id: 'bounded-tool-call',
        content: `TOOL_HEAD ${'tool output '.repeat(8_000)} TOOL_TAIL`,
      },
    ];
    compactChat.mockRejectedValueOnce(new Error('summary unavailable'));

    const result = await CompactionService.compact(messages, {
      ...markerCompactionOptions,
      maxContextTokens: 6_000,
      sessionId: 'fallback-tool-unit-budget',
    });

    const assistant = result.compactedMessages.find(
      (message) =>
        message.role === 'assistant' &&
        message.tool_calls?.some((call) => call.id === 'bounded-tool-call')
    );
    const tool = result.compactedMessages.find(
      (message) =>
        message.role === 'tool' && message.tool_call_id === 'bounded-tool-call'
    );
    expect(result.postTokens).toBeLessThanOrEqual(result.fallbackTargetTokens!);
    expect(result.fallbackMessagesOmitted).toBe(1);
    expect(result.fallbackMessagesTruncated).toBe(1);
    expect(assistant).toBeDefined();
    expect(tool).toBeDefined();
    expect(String(tool?.content)).toContain('TOOL_HEAD');
    expect(String(tool?.content)).toContain('TOOL_TAIL');
  });

  test('deterministic fallback 应省略只含未完成 tool call 的空 assistant', async () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'incomplete-tool-call',
            type: 'function',
            function: { name: 'Write', arguments: '{"file_path":"pending.txt"}' },
          },
        ],
      },
      { role: 'user', content: 'Retain the latest user evidence.' },
    ];
    compactChat.mockRejectedValueOnce(new Error('summary unavailable'));

    const result = await CompactionService.compact(messages, {
      ...markerCompactionOptions,
      sessionId: 'fallback-incomplete-tool-call',
    });

    expect(result.compactedMessages).toContainEqual({
      role: 'user',
      content: 'Retain the latest user evidence.',
    });
    expect(
      result.compactedMessages.some(
        (message) =>
          message.role === 'assistant' &&
          message.tool_calls?.some((call) => call.id === 'incomplete-tool-call')
      )
    ).toBe(false);
    expect(
      result.compactedMessages.some(
        (message) =>
          message.role === 'assistant' &&
          !String(message.content).trim() &&
          !message.tool_calls?.length
      )
    ).toBe(false);
    expect(result.fallbackMessagesOmitted).toBe(1);
  });

  test('deterministic fallback 不得保留 reasoning 或图片载荷', async () => {
    const imageSecret = 'FALLBACK_IMAGE_PAYLOAD_MUST_NOT_SURVIVE';
    const reasoningSecret = 'FALLBACK_REASONING_MUST_NOT_SURVIVE';
    const messages: Message[] = [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Retain visible evidence. ${'visible context '.repeat(500)}`,
          },
          {
            type: 'image_url',
            image_url: {
              url: `data:image/png;base64,${imageSecret}`,
            },
          },
        ],
      },
      {
        role: 'assistant',
        content: `Visible response. ${'answer context '.repeat(500)}`,
        reasoningContent: reasoningSecret,
      },
    ];
    compactChat.mockRejectedValueOnce(new Error('summary unavailable'));

    const result = await CompactionService.compact(messages, {
      ...markerCompactionOptions,
      maxContextTokens: 6_000,
      sessionId: 'fallback-private-payload-budget',
    });
    const serialized = JSON.stringify(result.compactedMessages);

    expect(serialized).toContain('Retain visible evidence.');
    expect(serialized).toContain('[image omitted from compaction]');
    expect(serialized).not.toContain(imageSecret);
    expect(serialized).not.toContain(reasoningSecret);
    expect(result.fallbackMessagesTruncated).toBe(2);
  });

  test('瞬态 Provider 失败后应有界重试并累计 usage', async () => {
    vi.useFakeTimers();
    const transient = Object.assign(new Error('service unavailable'), {
      status: 503,
    });
    compactChat
      .mockRejectedValueOnce(transient)
      .mockResolvedValueOnce({
        content: '   ',
        usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
      })
      .mockResolvedValueOnce({
        content: '<summary>Recovered summary.</summary>',
        usage: {
          promptTokens: 20,
          completionTokens: 3,
          totalTokens: 23,
          costUsd: 0.02,
        },
      });

    try {
      const pending = CompactionService.compact(
        [{ role: 'user', content: 'Preserve the active task.' }],
        {
          ...markerCompactionOptions,
          sessionId: 'transient-retry',
        }
      );
      await vi.runAllTimersAsync();
      const result = await pending;

      expect(result.success).toBe(true);
      expect(result.summary).toBe('Recovered summary.');
      expect(result.sampleAttempts).toBe(3);
      expect(result.failureReason).toBeUndefined();
      expect(result.usage).toEqual({
        promptTokens: 30,
        completionTokens: 5,
        totalTokens: 35,
        costUsd: 0.02,
      });
      expect(compactChat).toHaveBeenCalledTimes(3);
      expect(createChatServiceAsync).toHaveBeenCalledWith(
        expect.objectContaining({ maxRetries: 0 })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  test('三次瞬态失败后应记录 exhausted 分类并回退', async () => {
    vi.useFakeTimers();
    compactChat.mockRejectedValue(
      Object.assign(new Error('upstream service unavailable'), { status: 503 })
    );

    try {
      const pending = CompactionService.compact(
        [{ role: 'user', content: 'Preserve the active task.' }],
        {
          ...markerCompactionOptions,
          sessionId: 'transient-exhausted',
        }
      );
      await vi.runAllTimersAsync();
      const result = await pending;

      expect(result.success).toBe(false);
      expect(result.sampleAttempts).toBe(3);
      expect(result.failureReason).toBe('transient_exhausted');
      expect(compactChat).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  test('LLM replacement 缩减不足时应回退并保留已计费 usage', async () => {
    const messages: Message[] = Array.from({ length: 10 }, (_, index) => ({
      role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: `source-${index} ${'historical evidence '.repeat(1_000)}`,
    }));
    const original = structuredClone(messages);
    const estimatedSourceTokens = TokenCounter.countTokens(
      messages,
      markerCompactionOptions.modelName
    );
    const usage = {
      promptTokens: 7_000,
      completionTokens: 9_000,
      totalTokens: 16_000,
      costUsd: 0.25,
    };
    const ineffectiveSummary = 'ineffective summary output '.repeat(4_200);
    const reconciledSummary = reconcileExactContinuationRecords(
      ineffectiveSummary,
      messages
    );
    const maxEffectivePostTokens = Math.floor(
      estimatedSourceTokens * MAX_COMPACTION_RESULT_RATIO
    );
    expect(
      TokenCounter.countTokens(
        [{ role: 'user', content: reconciledSummary }],
        markerCompactionOptions.modelName
      )
    ).toBeLessThanOrEqual(maxEffectivePostTokens);
    expect(
      TokenCounter.countTokens(
        [
          { role: 'user', content: reconciledSummary },
          ...messages.slice(-Math.ceil(messages.length * 0.2)),
        ],
        markerCompactionOptions.modelName
      )
    ).toBeGreaterThan(maxEffectivePostTokens);
    compactChat.mockResolvedValueOnce({
      content: `<summary>${ineffectiveSummary}</summary>`,
      usage,
    });

    const result = await CompactionService.compact(messages, {
      ...markerCompactionOptions,
      actualPreTokens: 60_000,
      sessionId: 'insufficient-reduction',
    });

    expect(estimatedSourceTokens).toBeGreaterThanOrEqual(
      MIN_COMPACTION_EFFECTIVENESS_TOKENS
    );
    expect(result.success).toBe(false);
    expect(result.preTokens).toBe(60_000);
    expect(result.postTokens).toBeLessThanOrEqual(maxEffectivePostTokens);
    expect(result.failureReason).toBe('insufficient_reduction');
    expect(result.sampleAttempts).toBe(1);
    expect(result.usage).toEqual(usage);
    expect(result.summary).not.toContain('ineffective summary output');
    expect(messages).toEqual(original);
    expect(compactChat).toHaveBeenCalledOnce();
  });

  test('LLM replacement 即使满足源缩减比例也不得超过 context headroom', async () => {
    const messages: Message[] = Array.from({ length: 12 }, (_, index) => ({
      role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: `source-${index} ${'historical evidence '.repeat(1_200)}`,
    }));
    const estimatedSourceTokens = TokenCounter.countTokens(
      messages,
      markerCompactionOptions.modelName
    );
    const contextTarget = Math.floor(6_000 * MAX_COMPACTION_CONTEXT_RATIO);
    const oversizedSummary = 'context headroom output '.repeat(1_400);
    const summaryTokens = TokenCounter.countTokens(
      [{ role: 'user', content: oversizedSummary }],
      markerCompactionOptions.modelName
    );
    expect(summaryTokens).toBeGreaterThan(contextTarget);
    expect(summaryTokens).toBeLessThan(
      Math.floor(estimatedSourceTokens * MAX_COMPACTION_RESULT_RATIO)
    );
    compactChat.mockResolvedValueOnce({
      content: `<summary>${oversizedSummary}</summary>`,
    });

    const result = await CompactionService.compact(messages, {
      ...markerCompactionOptions,
      maxContextTokens: 6_000,
      sessionId: 'context-headroom-rejection',
    });

    expect(result.success).toBe(false);
    expect(result.failureReason).toBe('insufficient_reduction');
    expect(result.fallbackTargetTokens).toBe(contextTarget);
    expect(result.postTokens).toBeLessThanOrEqual(contextTarget);
  });

  test('小历史跳过比例检查时仍拒绝超过 5,000-token floor 的异常膨胀', async () => {
    const messages: Message[] = [{ role: 'user', content: 'small manual history' }];
    const expandedSummary = 'unexpected expansion '.repeat(6_000);
    expect(
      TokenCounter.countTokens(messages, markerCompactionOptions.modelName)
    ).toBeLessThan(MIN_COMPACTION_EFFECTIVENESS_TOKENS);
    expect(
      TokenCounter.countTokens(
        [{ role: 'user', content: expandedSummary }],
        markerCompactionOptions.modelName
      )
    ).toBeGreaterThan(MIN_COMPACTION_EFFECTIVENESS_TOKENS);
    compactChat.mockResolvedValueOnce({
      content: `<summary>${expandedSummary}</summary>`,
    });

    const result = await CompactionService.compact(messages, {
      ...markerCompactionOptions,
      maxContextTokens: 128_000,
      sessionId: 'small-history-expansion',
    });

    expect(result.success).toBe(false);
    expect(result.failureReason).toBe('insufficient_reduction');
    expect(result.fallbackTargetTokens).toBe(MIN_COMPACTION_EFFECTIVENESS_TOKENS);
    expect(result.postTokens).toBeLessThanOrEqual(MIN_COMPACTION_EFFECTIVENESS_TOKENS);
  });

  test('fallback 不应重复保留已由完整 active-task checkpoint 覆盖的用户消息', async () => {
    const activeTask =
      'Apply the pending mutation, verify it, and report exactly DONE.';
    const messages: Message[] = [
      { role: 'user', content: activeTask },
      { role: 'assistant', content: 'The mutation has been applied.' },
    ];
    compactChat.mockRejectedValueOnce(new Error('summary unavailable'));

    const result = await CompactionService.compact(messages, {
      ...markerCompactionOptions,
      sessionId: 'fallback-active-task-deduplication',
      activeTask,
    });

    expect(
      result.compactedMessages.filter(
        (message) => message.role === 'user' && message.content === activeTask
      )
    ).toHaveLength(0);
    expect(
      result.compactedMessages.filter((message) =>
        String(message.content).includes(activeTask)
      )
    ).toHaveLength(1);
    expect(
      result.compactedMessages.some((message) =>
        String(message.content).includes(
          'obey any exact final-response protocol literally'
        )
      )
    ).toBe(true);
    expect(result.compactedMessages).toContainEqual({
      role: 'assistant',
      content: 'The mutation has been applied.',
    });
    expect(result.fallbackMessagesOmitted).toBe(1);
  });

  test('mandatory active-task checkpoint 超过目标时只提升到其实际大小', async () => {
    const activeTask = `ACTIVE_HEAD_${'task constraint '.repeat(800)}_ACTIVE_TAIL`;
    compactChat.mockRejectedValueOnce(new Error('summary unavailable'));

    const result = await CompactionService.compact(
      [{ role: 'user', content: 'small history' }],
      {
        ...markerCompactionOptions,
        maxContextTokens: 1_000,
        sessionId: 'fallback-mandatory-floor',
        activeTask,
      }
    );

    expect(result.fallbackTargetTokens).toBe(result.postTokens);
    expect(result.fallbackTargetTokens).toBeGreaterThan(
      Math.floor(1_000 * MAX_COMPACTION_CONTEXT_RATIO)
    );
    expect(result.fallbackMessagesOmitted).toBe(1);
    const checkpoint = result.compactedMessages.find(
      (message) =>
        (message.metadata as Record<string, unknown> | undefined)
          ?.isPostCompactActiveTask === true
    );
    expect(String(checkpoint?.content)).toContain('ACTIVE_HEAD_');
    expect(String(checkpoint?.content)).toContain('_ACTIVE_TAIL');
  });

  test('连续缩减不足应打开 session 熔断并停止后续采样', async () => {
    const messages: Message[] = Array.from({ length: 10 }, (_, index) => ({
      role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: `source-${index} ${'historical evidence '.repeat(1_000)}`,
    }));
    const oversizedSummary = 'ineffective summary output '.repeat(4_200);
    compactChat.mockResolvedValue({
      content: `<summary>${oversizedSummary}</summary>`,
      usage: { promptTokens: 7_000, completionTokens: 9_000, totalTokens: 16_000 },
    });
    const options = {
      ...markerCompactionOptions,
      sessionId: 'insufficient-reduction-circuit',
    };

    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const result = await CompactionService.compact(messages, options);
        expect(result.failureReason).toBe('insufficient_reduction');
        expect(result.sampleAttempts).toBe(1);
      }

      const circuitResult = await CompactionService.compact(messages, options);
      expect(circuitResult.failureReason).toBe('circuit_open');
      expect(circuitResult.sampleAttempts).toBe(0);
      expect(compactChat).toHaveBeenCalledTimes(3);
    } finally {
      resetCompactionCircuitBreaker();
    }
  });

  test('context overflow 应缩减旧消息后在同一总预算内恢复', async () => {
    const exactRecord =
      'EXACT CONTINUATION RECORD [Exact next action] :: RUN_STEPDOWN_CHECK';
    const messages = [
      { role: 'user' as const, content: `${exactRecord}\n${'a'.repeat(2_000)}` },
      { role: 'assistant' as const, content: `old reply ${'b'.repeat(1_000)}` },
      { role: 'user' as const, content: `middle task ${'c'.repeat(1_000)}` },
      { role: 'assistant' as const, content: `middle reply ${'d'.repeat(1_000)}` },
      { role: 'user' as const, content: `recent task ${'e'.repeat(1_000)}` },
      { role: 'assistant' as const, content: 'recent reply must survive' },
    ];
    compactChat
      .mockRejectedValueOnce(
        Object.assign(new Error('context_length_exceeded'), { status: 400 })
      )
      .mockResolvedValueOnce({
        content: '<summary>Recovered reduced summary.</summary>',
      });

    const result = await CompactionService.compact(messages, {
      ...markerCompactionOptions,
      sessionId: 'context-stepdown',
    });

    expect(result.success).toBe(true);
    expect(result.sampleAttempts).toBe(2);
    expect(result.inputReductions).toBe(1);
    expect(result.messagesOmitted).toBe(2);
    expect(result.filesOmitted).toBe(0);
    expect(result.summary).toContain('RUN_STEPDOWN_CHECK');
    const firstPrompt = compactChat.mock.calls[0]?.[0]?.[0]?.content;
    const secondPrompt = compactChat.mock.calls[1]?.[0]?.[0]?.content;
    expect(typeof firstPrompt).toBe('string');
    expect(typeof secondPrompt).toBe('string');
    expect(String(secondPrompt).length).toBeLessThan(String(firstPrompt).length);
    expect(secondPrompt).not.toContain(exactRecord);
    expect(secondPrompt).toContain('recent reply must survive');
  });

  test('context overflow 应先移除可重读文件内容', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'compaction-files-'));
    await fs.mkdir(path.join(workspace, 'src'), { recursive: true });
    await fs.writeFile(
      path.join(workspace, 'src', 'stepdown.ts'),
      "export const FILE_STEPDOWN_SENTINEL = 'present';\n"
    );
    compactChat
      .mockRejectedValueOnce(
        Object.assign(new Error('context_length_exceeded'), { status: 400 })
      )
      .mockResolvedValueOnce({
        content: '<summary>Recovered without re-readable files.</summary>',
      });

    try {
      const result = await CompactionService.compact(
        [{ role: 'user', content: 'Continue editing src/stepdown.ts.' }],
        {
          ...markerCompactionOptions,
          sessionId: 'context-stepdown-files',
          workspaceRoot: workspace,
        }
      );

      expect(result.success).toBe(true);
      expect(result.inputReductions).toBe(1);
      expect(result.messagesOmitted).toBe(0);
      expect(result.filesOmitted).toBe(1);
      expect(result.filesIncluded).toEqual([]);
      const firstPrompt = String(compactChat.mock.calls[0]?.[0]?.[0]?.content);
      const secondPrompt = String(compactChat.mock.calls[1]?.[0]?.[0]?.content);
      expect(firstPrompt).toContain('FILE_STEPDOWN_SENTINEL');
      expect(secondPrompt).not.toContain('FILE_STEPDOWN_SENTINEL');
      expect(secondPrompt).toContain('Continue editing src/stepdown.ts.');
      expect(secondPrompt.length).toBeLessThan(firstPrompt.length);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  test('context overflow 应将最旧 tool call 与结果作为完整单元移除', async () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: 'OLD_TOOL_CALL_SENTINEL',
        tool_calls: [
          {
            id: 'old-call',
            type: 'function',
            function: { name: 'Read', arguments: '{"file_path":"old.ts"}' },
          },
        ],
      },
      {
        role: 'tool',
        content: 'OLD_TOOL_RESULT_SENTINEL',
        tool_call_id: 'old-call',
      },
      { role: 'user', content: 'RECENT_TASK_SENTINEL' },
      { role: 'assistant', content: 'RECENT_REPLY_SENTINEL' },
    ];
    compactChat
      .mockRejectedValueOnce(
        Object.assign(new Error('context_length_exceeded'), { status: 400 })
      )
      .mockResolvedValueOnce({
        content: '<summary>Recovered without the oldest tool unit.</summary>',
      });

    const result = await CompactionService.compact(messages, {
      ...markerCompactionOptions,
      sessionId: 'context-stepdown-tool-unit',
    });

    expect(result.success).toBe(true);
    expect(result.inputReductions).toBe(1);
    expect(result.messagesOmitted).toBe(2);
    const secondPrompt = String(compactChat.mock.calls[1]?.[0]?.[0]?.content);
    expect(secondPrompt).not.toContain('OLD_TOOL_CALL_SENTINEL');
    expect(secondPrompt).not.toContain('OLD_TOOL_RESULT_SENTINEL');
    expect(secondPrompt).toContain('RECENT_TASK_SENTINEL');
    expect(secondPrompt).toContain('RECENT_REPLY_SENTINEL');
  });

  test('单消息 context overflow 应降低字符上限并从完整原文回填 exact record', async () => {
    const exactRecord =
      'EXACT CONTINUATION RECORD [Exact next action] :: RUN_AFTER_CHAR_STEPDOWN';
    const messages: Message[] = [
      {
        role: 'user',
        content: `${'x'.repeat(7_000)}\n${exactRecord}`,
      },
    ];
    compactChat
      .mockRejectedValueOnce(
        Object.assign(new Error('context_length_exceeded'), { status: 400 })
      )
      .mockResolvedValueOnce({
        content: '<summary>Recovered after reducing the character cap.</summary>',
      });

    const result = await CompactionService.compact(messages, {
      ...markerCompactionOptions,
      sessionId: 'context-stepdown-character-cap',
    });

    expect(result.success).toBe(true);
    expect(result.inputReductions).toBe(1);
    expect(result.messagesOmitted).toBe(0);
    expect(result.filesOmitted).toBe(0);
    expect(result.summary).toContain('RUN_AFTER_CHAR_STEPDOWN');
    const firstPrompt = String(compactChat.mock.calls[0]?.[0]?.[0]?.content);
    const secondPrompt = String(compactChat.mock.calls[1]?.[0]?.[0]?.content);
    expect(firstPrompt).not.toContain(exactRecord);
    expect(secondPrompt).not.toContain(exactRecord);
    expect(secondPrompt.length).toBeLessThan(firstPrompt.length);
  });

  test('context overflow 预算耗尽后应记录缩减损失并 fallback', async () => {
    const messages = Array.from({ length: 8 }, (_, index) => ({
      role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: `message-${index}-${'x'.repeat(1_000)}`,
    }));
    compactChat.mockRejectedValue(
      Object.assign(new Error('maximum context length exceeded'), { status: 400 })
    );

    const result = await CompactionService.compact(messages, {
      ...markerCompactionOptions,
      sessionId: 'context-stepdown-exhausted',
    });

    expect(result.success).toBe(false);
    expect(result.sampleAttempts).toBe(3);
    expect(result.inputReductions).toBe(2);
    expect(result.messagesOmitted).toBe(4);
    expect(result.filesOmitted).toBe(0);
    expect(result.failureReason).toBe('context_exhausted');
    expect(compactChat).toHaveBeenCalledTimes(3);
  });

  test('context overflow 无法产生更小 payload 时不得重放相同请求', async () => {
    compactChat.mockRejectedValueOnce(
      Object.assign(new Error('prompt_too_long'), { status: 400 })
    );

    const result = await CompactionService.compact(
      [{ role: 'user', content: 'tiny' }],
      {
        ...markerCompactionOptions,
        sessionId: 'context-stepdown-no-progress',
      }
    );

    expect(result.success).toBe(false);
    expect(result.sampleAttempts).toBe(1);
    expect(result.inputReductions).toBe(0);
    expect(result.failureReason).toBe('context_exhausted');
    expect(compactChat).toHaveBeenCalledOnce();
  });

  test('abort 应在重试等待前终止且不得写入 fallback', async () => {
    const controller = new AbortController();
    compactChat.mockImplementationOnce(async () => {
      controller.abort();
      throw Object.assign(new Error('service unavailable'), { status: 503 });
    });

    await expect(
      CompactionService.compact(
        [{ role: 'user', content: 'Preserve the active task.' }],
        {
          ...markerCompactionOptions,
          sessionId: 'retry-aborted',
          signal: controller.signal,
        }
      )
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(compactChat).toHaveBeenCalledOnce();
  });

  test('continuation ledger prompt 应精确声明七段执行交接契约', () => {
    const fileContents: FileContent[] = [
      {
        path: 'src/frontier.ts',
        content: 'export const frontier = true;',
        truncated: false,
        lines: 1,
        includedLines: 1,
      },
    ];
    const prompt = buildCompactionPrompt(
      [{ role: 'user', content: 'Run `bun run type-check` after setting MODE=exact.' }],
      fileContents
    );
    const headings = [
      'Objective and constraints',
      'Decisions and rationale',
      'Workspace mutations',
      'Verification evidence',
      'Active tasks and background work',
      'Open risks or blockers',
      'Exact next action',
    ];

    for (const heading of headings) {
      expect(prompt.match(new RegExp(heading, 'g'))).toHaveLength(1);
      expect(prompt).toContain(`## ${heading}`);
    }
    expect(prompt).toContain('distinguish observed facts from intended work');
    expect(prompt).toContain(
      'preserve exact commands, tool arguments, and final-response constraints when necessary for continuation'
    );
    expect(prompt).toContain('never invent successful verification');
    expect(prompt).toContain('never mark unfinished work complete');
    expect(prompt).toContain('never convert a plan into a completed mutation');
    expect(prompt).toContain('never include credentials or hidden control messages');
    expect(prompt).toContain('never include raw reasoning');
    expect(prompt).toContain(
      'explicitly labels a literal as an exact continuation record and names one of the seven ledger headings'
    );
    expect(prompt).toContain(
      'copy that literal verbatim as one standalone list item under the named heading'
    );
    expect(prompt).toContain('EXACT CONTINUATION RECORD [<heading>] :: <payload>');
    expect(prompt).toContain(
      'Only <payload>, the text after the exact delimiter :: , belongs in the ledger item'
    );
    expect(prompt).toContain(
      'Do not omit, rewrite, split, decorate, relocate, reorder, or append text to an exact continuation record'
    );
    expect(prompt).toContain(
      'Do not infer or auto-repair a missing record, payload, status, or heading assignment'
    );
    expect(prompt).not.toContain('identifier beginning MUTATION_');
    expect(prompt).not.toContain('identifier beginning FAILED_');
    expect(prompt).not.toContain('identifier beginning PENDING_');
    expect(prompt).toContain('`bun run type-check`');
    expect(prompt).toContain('MODE=exact');
    expect(prompt).toContain('<analysis>');
    expect(prompt).toContain('<summary>');
  });

  test('continuation ledger generation 应使用 deterministic temperature', async () => {
    compactChat.mockResolvedValueOnce({
      content: '<summary>ledger</summary>',
      usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
    });

    await CompactionService.compact(
      [{ role: 'user', content: 'preserve the execution frontier' }],
      markerCompactionOptions
    );

    expect(createChatServiceAsync).toHaveBeenCalledWith(
      expect.objectContaining({ temperature: 0 })
    );
  });

  test('host 应逐字归位 exact continuation records 并移除模型副本', () => {
    const pending = 'PENDING_A1B2C3D4 status=pending';
    const action =
      'PRIOR_WRITE_COMPLETE; RUN_ONLY_EXACT_BASH="bun test"; REQUIRE_ZERO_EXIT';
    const source: Message[] = [
      {
        role: 'user',
        content: [
          `EXACT CONTINUATION RECORD [Exact next action] :: ${pending}`,
          `EXACT CONTINUATION RECORD [Exact next action] :: ${action}`,
          `EXACT CONTINUATION RECORD [Exact next action] :: ${pending}`,
        ].join('\n'),
      },
    ];
    const generated = [
      '## Objective and constraints',
      'Continue.',
      '## Active tasks and background work',
      `- ${pending}`,
      '## Exact next action',
      `- ${action}`,
    ].join('\n');

    const reconciled = reconcileExactContinuationRecords(generated, source);

    for (const heading of [
      'Objective and constraints',
      'Decisions and rationale',
      'Workspace mutations',
      'Verification evidence',
      'Active tasks and background work',
      'Open risks or blockers',
      'Exact next action',
    ]) {
      expect(reconciled.match(new RegExp(`^## ${heading}$`, 'gm'))).toHaveLength(1);
    }
    expect(reconciled.split(pending)).toHaveLength(2);
    expect(reconciled.split(action)).toHaveLength(2);
    expect(reconciled.indexOf(pending)).toBeGreaterThan(
      reconciled.indexOf('## Exact next action')
    );
  });

  test('host 不从旧 compact summary 或未知 heading 继承 exact records', () => {
    const priorSummary: Message = {
      role: 'user',
      content: 'EXACT CONTINUATION RECORD [Exact next action] :: PRIOR status=pending',
      metadata: { isCompactSummary: true },
    };
    const source: Message[] = [
      priorSummary,
      {
        role: 'user',
        content: [
          'EXACT CONTINUATION RECORD [Unknown] :: ignored',
          'EXACT CONTINUATION RECORD [Exact next action] :: CURRENT status=pending',
        ].join('\n'),
      },
    ];

    expect(extractExactContinuationRecords(source)).toEqual([
      {
        heading: 'Exact next action',
        payload: 'CURRENT status=pending',
      },
    ]);
  });

  test('旧 compact summary 不得让 reserved ledger headings 在 prompt 中重复', () => {
    const headings = [
      'Objective and constraints',
      'Decisions and rationale',
      'Workspace mutations',
      'Verification evidence',
      'Active tasks and background work',
      'Open risks or blockers',
      'Exact next action',
    ];
    const prompt = buildCompactionPrompt(
      [
        {
          role: 'user',
          content: headings.join('\n'),
          metadata: { isCompactSummary: true },
        },
      ],
      []
    );

    for (const heading of headings) {
      expect(prompt.match(new RegExp(heading, 'g'))).toHaveLength(1);
      expect(prompt).toContain(`## ${heading}`);
    }
    expect(prompt).toContain('Objective\\u0020and\\u0020constraints');
  });

  test('compaction hook 应使用 active workspace', async () => {
    compactChat.mockResolvedValueOnce({
      content: '<summary>Preserve the active workspace.</summary>',
      usage: {
        promptTokens: 100,
        completionTokens: 20,
        totalTokens: 120,
        cacheReadInputTokens: 30,
        cacheCreationInputTokens: 10,
        costUsd: 0.125,
      },
    });
    const hookSpy = vi
      .spyOn(HookManager.getInstance(), 'executeCompactionHooks')
      .mockResolvedValueOnce({ blockCompaction: false });

    try {
      const result = await CompactionService.compact(
        [{ role: 'user', content: 'Continue the worktree task.' }],
        {
          trigger: 'auto',
          modelName: 'test-model',
          maxContextTokens: 6_000,
          apiKey: 'test-key',
          baseURL: 'https://example.invalid',
          sessionId: 'hook-workspace-session',
          workspaceRoot: '/tmp/active-worktree',
        }
      );

      expect(hookSpy).toHaveBeenCalledWith(
        'auto',
        expect.objectContaining({
          projectDir: '/tmp/active-worktree',
          sessionId: 'hook-workspace-session',
        })
      );
      expect(result.usage).toEqual({
        promptTokens: 100,
        completionTokens: 20,
        totalTokens: 120,
        cacheReadInputTokens: 30,
        cacheCreationInputTokens: 10,
        costUsd: 0.125,
      });
    } finally {
      hookSpy.mockRestore();
    }
  });

  test('remote compaction 不执行 host hook 或 referenced-file analysis', async () => {
    compactChat.mockResolvedValueOnce({
      content: '<summary>Remote summary only.</summary>',
      usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
    });
    const hookSpy = vi.spyOn(HookManager.getInstance(), 'executeCompactionHooks');
    const analyzeSpy = vi.spyOn(
      (await import('../../../../src/context/FileAnalyzer.js')).FileAnalyzer,
      'analyzeFiles'
    );

    try {
      await CompactionService.compact(
        [
          {
            role: 'user',
            content: 'Read C:\\Remote\\secret.txt and preserve the result.',
          },
        ],
        {
          trigger: 'auto',
          modelName: 'test-model',
          maxContextTokens: 6_000,
          apiKey: 'test-key',
          baseURL: 'https://example.invalid',
          sessionId: 'remote-compaction-session',
          workspaceRoot: '/private/remote-state',
          workspaceAccess: 'none',
        }
      );

      expect(hookSpy).not.toHaveBeenCalled();
      expect(analyzeSpy).not.toHaveBeenCalled();
    } finally {
      hookSpy.mockRestore();
      analyzeSpy.mockRestore();
    }
  });

  test('circuit breaker 应按 workspace 和 session 复合身份隔离', async () => {
    resetCompactionCircuitBreaker();
    compactChat
      .mockRejectedValueOnce(new Error('workspace-a failure 1'))
      .mockRejectedValueOnce(new Error('workspace-a failure 2'))
      .mockRejectedValueOnce(new Error('workspace-a failure 3'))
      .mockResolvedValueOnce({
        content: '<summary>Workspace B remains independent.</summary>',
      });
    const commonOptions = {
      trigger: 'auto' as const,
      modelName: 'test-model',
      maxContextTokens: 6_000,
      apiKey: 'test-key',
      baseURL: 'https://example.invalid',
      sessionId: 'duplicate-session-id',
    };

    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const result = await CompactionService.compact(
          [{ role: 'user', content: `Workspace A attempt ${attempt}` }],
          { ...commonOptions, workspaceRoot: '/tmp/workspace-a' }
        );
        expect(result.success).toBe(false);
      }

      const workspaceBResult = await CompactionService.compact(
        [{ role: 'user', content: 'Workspace B attempt' }],
        { ...commonOptions, workspaceRoot: '/tmp/workspace-b' }
      );

      expect(workspaceBResult.success).toBe(true);
      expect(compactChat).toHaveBeenCalledTimes(4);
    } finally {
      resetCompactionCircuitBreaker();
    }
  });

  test('circuit breaker 应规范化等价的 workspace 路径', async () => {
    resetCompactionCircuitBreaker();
    compactChat
      .mockRejectedValueOnce(new Error('failure 1'))
      .mockRejectedValueOnce(new Error('failure 2'))
      .mockRejectedValueOnce(new Error('failure 3'))
      .mockResolvedValueOnce({ content: '<summary>must not run</summary>' });
    const options = {
      trigger: 'auto' as const,
      modelName: 'test-model',
      maxContextTokens: 6_000,
      apiKey: 'test-key',
      baseURL: 'https://example.invalid',
      sessionId: 'canonical-session',
    };

    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        await CompactionService.compact(
          [{ role: 'user', content: `Attempt ${attempt}` }],
          { ...options, workspaceRoot: '/tmp/canonical-workspace' }
        );
      }

      const result = await CompactionService.compact(
        [{ role: 'user', content: 'Equivalent path attempt' }],
        { ...options, workspaceRoot: '/tmp/canonical-workspace/.' }
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('Circuit breaker open');
      expect(compactChat).toHaveBeenCalledTimes(3);
    } finally {
      resetCompactionCircuitBreaker();
    }
  });

  test('压缩诊断不应写入 stdout', async () => {
    compactChat.mockResolvedValueOnce({
      content: '<summary>Preserve the active coding task.</summary>',
    });
    const stdoutSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      const result = await CompactionService.compact(
        [{ role: 'user', content: 'Continue the coding task.' }],
        {
          trigger: 'auto',
          modelName: 'test-model',
          maxContextTokens: 6_000,
          apiKey: 'test-key',
          baseURL: 'https://example.invalid',
          sessionId: 'stdout-contract',
        }
      );

      expect(result.success).toBe(true);
      expect(stdoutSpy).not.toHaveBeenCalled();
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  test('摘要遗漏任务时仍应逐字保留有界的 active-task checkpoint', async () => {
    compactChat.mockResolvedValueOnce({
      content: '<summary>The repository package metadata was inspected.</summary>',
    });
    const activeTask =
      'After Read succeeds, use Write to create compacted.txt containing exactly compacted without quote characters.';
    const messages: Message[] = [
      { role: 'user', content: `${activeTask}\n${'archived context '.repeat(2_000)}` },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'read-active-task',
            type: 'function',
            function: { name: 'Read', arguments: '{"file_path":"package.json"}' },
          },
        ],
      },
      {
        role: 'tool',
        content: '{"name":"test-project"}',
        tool_call_id: 'read-active-task',
      },
    ];

    const result = await CompactionService.compact(messages, {
      trigger: 'auto',
      modelName: 'test-model',
      maxContextTokens: 6_000,
      apiKey: 'test-key',
      baseURL: 'https://example.invalid',
      sessionId: 'active-task-checkpoint',
      activeTask,
    });

    const checkpoint = result.compactedMessages.find(
      (message) =>
        (message.metadata as Record<string, unknown> | undefined)
          ?.isPostCompactActiveTask === true
    );
    expect(checkpoint?.content).toContain(activeTask);
    expect(String(checkpoint?.content).length).toBeLessThanOrEqual(7_000);
  });

  test('应从 active workspace 读取相对路径的重点文件', async () => {
    const activeWorkspace = await fs.mkdtemp(
      path.join(os.tmpdir(), 'compaction-worktree-')
    );
    await fs.mkdir(path.join(activeWorkspace, 'src'), { recursive: true });
    await fs.writeFile(
      path.join(activeWorkspace, 'src', 'clamp.js'),
      "export const location = 'managed-worktree';\n"
    );
    compactChat.mockResolvedValueOnce({
      content: '<summary>Preserve the managed worktree change.</summary>',
    });

    try {
      await CompactionService.compact(
        [
          { role: 'user', content: 'Fix src/clamp.js in the managed worktree.' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'edit-clamp',
                type: 'function',
                function: {
                  name: 'Edit',
                  arguments: '{\"file_path\":\"src/clamp.js\"}',
                },
              },
            ],
          },
        ],
        {
          trigger: 'auto',
          modelName: 'test-model',
          maxContextTokens: 6_000,
          apiKey: 'test-key',
          baseURL: 'https://example.invalid',
          sessionId: 'managed-worktree-files',
          workspaceRoot: activeWorkspace,
        }
      );

      const prompt = String(compactChat.mock.calls.at(-1)?.[0]?.[0]?.content);
      expect(prompt).toContain("export const location = 'managed-worktree';");
    } finally {
      await fs.rm(activeWorkspace, { recursive: true, force: true });
    }
  });

  test('不应读取 active workspace 外的相对路径或符号链接', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'compaction-boundary-'));
    const activeWorkspace = path.join(tempRoot, 'worktree');
    const outsideWorkspace = path.join(tempRoot, 'outside');
    await fs.mkdir(activeWorkspace, { recursive: true });
    await fs.mkdir(outsideWorkspace, { recursive: true });
    await fs.writeFile(
      path.join(outsideWorkspace, 'lexical-secret.ts'),
      "export const lexicalSecret = 'must-not-leak';\n"
    );
    await fs.writeFile(
      path.join(outsideWorkspace, 'symlink-secret.ts'),
      "export const symlinkSecret = 'must-not-leak';\n"
    );
    await fs.symlink(outsideWorkspace, path.join(activeWorkspace, 'linked'));
    compactChat.mockResolvedValueOnce({
      content: '<summary>Keep worktree isolation.</summary>',
    });

    try {
      const result = await CompactionService.compact(
        [
          {
            role: 'user',
            content:
              'Do not restore ../outside/lexical-secret.ts or ' +
              'linked/symlink-secret.ts.',
          },
        ],
        {
          trigger: 'auto',
          modelName: 'test-model',
          maxContextTokens: 6_000,
          apiKey: 'test-key',
          baseURL: 'https://example.invalid',
          sessionId: 'managed-worktree-boundary',
          workspaceRoot: activeWorkspace,
        }
      );

      const prompt = String(compactChat.mock.calls.at(-1)?.[0]?.[0]?.content);
      expect(prompt).not.toContain("export const lexicalSecret = 'must-not-leak';");
      expect(prompt).not.toContain("export const symlinkSecret = 'must-not-leak';");
      expect(result.filesIncluded).toEqual([]);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });
});

/**
 * 模拟孤儿 tool 消息场景
 * 场景：压缩时保留了 tool 消息，但对应的 assistant 消息被压缩掉了
 */
describe('CompactionService - 孤儿 tool 消息过滤', () => {
  test('应该过滤掉孤儿 tool 消息', () => {
    // 模拟消息历史（压缩前）
    const messagesBeforeCompaction: Message[] = [
      { role: 'user', content: 'Read file A' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_123',
            type: 'function' as const,
            function: { name: 'Read', arguments: '{"file":"A"}' },
          },
        ],
      },
      { role: 'tool', content: 'File A content', tool_call_id: 'call_123' },
      { role: 'user', content: 'Read file B' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_456',
            type: 'function' as const,
            function: { name: 'Read', arguments: '{"file":"B"}' },
          },
        ],
      },
      { role: 'tool', content: 'File B content', tool_call_id: 'call_456' },
    ];

    // 模拟压缩：只保留最后 3 条消息（保留 50%）
    const retainCount = 3;
    const candidateMessages = messagesBeforeCompaction.slice(-retainCount);

    // candidateMessages 现在是：
    // [
    //   { role: 'user', content: 'Read file B' },
    //   { role: 'assistant', tool_calls: [{ id: 'call_456', ... }] },
    //   { role: 'tool', tool_call_id: 'call_456' },
    // ]

    // 收集可用的 tool_call_id
    const availableToolCallIds = new Set<string>();
    for (const msg of candidateMessages) {
      if (msg.role === 'assistant' && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          availableToolCallIds.add(tc.id);
        }
      }
    }

    // 过滤孤儿 tool 消息
    const filteredMessages = candidateMessages.filter((msg) => {
      if (msg.role === 'tool' && msg.tool_call_id) {
        return availableToolCallIds.has(msg.tool_call_id);
      }
      return true;
    });

    // 验证：call_456 对应的 tool 消息应该被保留
    expect(filteredMessages).toHaveLength(3);
    expect(availableToolCallIds.has('call_456')).toBe(true);
    expect(availableToolCallIds.has('call_123')).toBe(false);
  });

  test('应该过滤掉所有孤儿 tool 消息', () => {
    // 极端场景：压缩时只保留了 tool 消息，但所有 assistant 消息都被压缩了
    const messagesBeforeCompaction: Message[] = [
      { role: 'user', content: 'Read file A' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_111',
            type: 'function' as const,
            function: { name: 'Read', arguments: '{"file":"A"}' },
          },
        ],
      },
      { role: 'tool', content: 'File A content', tool_call_id: 'call_111' },
      { role: 'user', content: 'Read file B' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_222',
            type: 'function' as const,
            function: { name: 'Read', arguments: '{"file":"B"}' },
          },
        ],
      },
      { role: 'tool', content: 'File B content', tool_call_id: 'call_222' },
      { role: 'user', content: 'Analyze files' },
    ];

    // 只保留最后 2 条（tool 消息和 user 消息，没有 assistant）
    const candidateMessages = messagesBeforeCompaction.slice(-2);

    // candidateMessages:
    // [
    //   { role: 'tool', tool_call_id: 'call_222' },  <- 孤儿
    //   { role: 'user', content: 'Analyze files' },
    // ]

    const availableToolCallIds = new Set<string>();
    for (const msg of candidateMessages) {
      if (msg.role === 'assistant' && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          availableToolCallIds.add(tc.id);
        }
      }
    }

    const filteredMessages = candidateMessages.filter((msg) => {
      if (msg.role === 'tool' && msg.tool_call_id) {
        return availableToolCallIds.has(msg.tool_call_id);
      }
      return true;
    });

    // 验证：孤儿 tool 消息应该被过滤掉
    expect(filteredMessages.length).toBeLessThan(candidateMessages.length);
    expect(filteredMessages.length).toBe(1); // 只剩 user 消息
    expect(filteredMessages.every((msg) => msg.role !== 'tool')).toBe(true);
  });

  test('应该保留完整的 tool 调用链', () => {
    const messagesBeforeCompaction: Message[] = [
      { role: 'user', content: 'Start task' },
      { role: 'user', content: 'Read file C' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_789',
            type: 'function' as const,
            function: { name: 'Read', arguments: '{"file":"C"}' },
          },
        ],
      },
      { role: 'tool', content: 'File C content', tool_call_id: 'call_789' },
      { role: 'assistant', content: 'Done reading C' },
    ];

    // 保留所有消息
    const candidateMessages = messagesBeforeCompaction;

    const availableToolCallIds = new Set<string>();
    for (const msg of candidateMessages) {
      if (msg.role === 'assistant' && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          availableToolCallIds.add(tc.id);
        }
      }
    }

    const filteredMessages = candidateMessages.filter((msg) => {
      if (msg.role === 'tool' && msg.tool_call_id) {
        return availableToolCallIds.has(msg.tool_call_id);
      }
      return true;
    });

    // 验证：完整链应该被保留
    expect(filteredMessages).toHaveLength(5);
    expect(filteredMessages.filter((m) => m.role === 'tool')).toHaveLength(1);
  });
});

/**
 * Post-Compact 文件恢复测试
 * 测试 CompactionService 的 getRecentlyAccessedFiles 和
 * buildFileRestorationMessage 逻辑
 */
describe('CompactionService - Post-Compact 文件恢复', () => {
  let tmpDir: string;
  let testFiles: string[];

  beforeEach(async () => {
    // 重置 FileAccessTracker 单例
    FileAccessTracker.resetInstance();

    // 创建临时目录和测试文件
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'compaction-restore-'));
    testFiles = [];
    for (let i = 0; i < 7; i++) {
      const filePath = path.join(tmpDir, `test-file-${i}.ts`);
      const lines = Array.from(
        { length: 50 },
        (_, ln) => `// line ${ln + 1} of test-file-${i}`
      );
      await fs.writeFile(filePath, lines.join('\n'));
      testFiles.push(filePath);
    }
  });

  afterEach(async () => {
    FileAccessTracker.resetInstance();
    // 清理临时文件
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test('getRecentlyAccessedFiles 应返回按时间降序的文件', async () => {
    const tracker = FileAccessTracker.getInstance();

    // 使用 fake timers 确保时间戳单调递增
    vi.useFakeTimers({ now: 1000 });
    await tracker.recordFileRead(testFiles[0], 'sess1');
    vi.advanceTimersByTime(100);
    await tracker.recordFileRead(testFiles[1], 'sess1');
    vi.advanceTimersByTime(100);
    await tracker.recordFileRead(testFiles[2], 'sess1');
    vi.useRealTimers();

    const trackedFiles = tracker.getTrackedFiles();
    const sorted = trackedFiles
      .map((fp) => ({ fp, record: tracker.getFileRecord(fp)! }))
      .filter((e) => e.record !== undefined)
      .sort((a, b) => b.record.accessTime - a.record.accessTime);

    const recentPaths = sorted.slice(0, 5).map((e) => e.fp);

    // 最后读取的文件应该排在前面
    expect(recentPaths[0]).toBe(testFiles[2]);
    expect(recentPaths).toHaveLength(3);
  });

  test('getRecentlyAccessedFiles 应限制返回数量', async () => {
    const tracker = FileAccessTracker.getInstance();

    // 记录 7 个文件
    for (const fp of testFiles) {
      await tracker.recordFileRead(fp, 'sess1');
    }

    const trackedFiles = tracker.getTrackedFiles();
    const sorted = trackedFiles
      .map((fp) => ({ fp, record: tracker.getFileRecord(fp)! }))
      .filter((e) => e.record !== undefined)
      .sort((a, b) => b.record.accessTime - a.record.accessTime);

    // 限制为 5 个
    const recentPaths = sorted.slice(0, 5).map((e) => e.fp);
    expect(recentPaths).toHaveLength(5);
  });

  test('没有被追踪的文件时应返回空列表', () => {
    const tracker = FileAccessTracker.getInstance();
    const trackedFiles = tracker.getTrackedFiles();
    expect(trackedFiles).toHaveLength(0);
  });

  test('文件恢复内容应包含 system-reminder 格式', async () => {
    const tracker = FileAccessTracker.getInstance();
    await tracker.recordFileRead(testFiles[0], 'sess1');

    // 模拟 buildFileRestorationMessage 的核心逻辑
    const recentFiles = [testFiles[0]];
    const fileRestorations: string[] = [];

    for (const filePath of recentFiles) {
      const content = await fs.readFile(filePath, 'utf-8');
      const lines = content.split('\n');
      const preview = lines.slice(0, 200).join('\n');
      const truncated =
        lines.length > 200 ? `\n... (${lines.length - 200} more lines)` : '';
      fileRestorations.push(
        `<file path="${filePath}" lines="${lines.length}">` +
          `\n${preview}${truncated}\n</file>`
      );
    }

    const restorationContent = [
      '<system-reminder>',
      'Post-compaction file restoration.' +
        ' These files were recently accessed' +
        ' in the conversation:',
      ...fileRestorations,
      '</system-reminder>',
    ].join('\n');

    // 验证格式
    expect(restorationContent).toContain('<system-reminder>');
    expect(restorationContent).toContain('</system-reminder>');
    expect(restorationContent).toContain('Post-compaction file restoration.');
    expect(restorationContent).toContain(`<file path="${testFiles[0]}"`);
    expect(restorationContent).toContain('// line 1 of test-file-0');
  });

  test('只恢复当前 session 的 active workspace 文件', async () => {
    const tracker = FileAccessTracker.getInstance();
    const activeWorkspace = path.join(tmpDir, 'active-worktree');
    const siblingWorkspace = path.join(tmpDir, 'original-checkout');
    await fs.mkdir(activeWorkspace, { recursive: true });
    await fs.mkdir(siblingWorkspace, { recursive: true });
    const activeFile = path.join(activeWorkspace, 'active.ts');
    const siblingFile = path.join(siblingWorkspace, 'sibling.ts');
    const foreignSessionFile = path.join(activeWorkspace, 'foreign.ts');
    await fs.writeFile(activeFile, 'export const active = true;');
    await fs.writeFile(siblingFile, "export const sibling = 'must-not-leak';");
    await fs.writeFile(
      foreignSessionFile,
      "export const foreignSession = 'must-not-leak';"
    );
    await tracker.recordFileRead(activeFile, 'current-session');
    await tracker.recordFileRead(siblingFile, 'current-session');
    await tracker.recordFileRead(foreignSessionFile, 'foreign-session');
    compactChat.mockResolvedValueOnce({
      content: '<summary>Preserve only active workspace context.</summary>',
    });

    const result = await CompactionService.compact(
      [{ role: 'user', content: 'Continue the active worktree task.' }],
      {
        trigger: 'auto',
        modelName: 'test-model',
        maxContextTokens: 6_000,
        apiKey: 'test-key',
        baseURL: 'https://example.invalid',
        sessionId: 'current-session',
        workspaceRoot: activeWorkspace,
      }
    );

    const restoration = result.compactedMessages.find(
      (message) =>
        (message.metadata as Record<string, unknown> | undefined)
          ?.isPostCompactRestoration === true
    );
    expect(restoration?.content).toContain('export const active = true;');
    expect(restoration?.content).not.toContain('must-not-leak');
  });

  test('workspace 过滤应在最近文件上限之前发生', async () => {
    const tracker = FileAccessTracker.getInstance();
    const activeWorkspace = path.join(tmpDir, 'limited-active-worktree');
    const siblingWorkspace = path.join(tmpDir, 'limited-sibling-worktree');
    await fs.mkdir(activeWorkspace, { recursive: true });
    await fs.mkdir(siblingWorkspace, { recursive: true });
    const activeFile = path.join(activeWorkspace, 'active.ts');
    await fs.writeFile(activeFile, 'export const retained = true;');
    await tracker.recordFileRead(activeFile, 'shared-session');
    for (let index = 0; index < 5; index++) {
      const siblingFile = path.join(siblingWorkspace, `newer-${index}.ts`);
      await fs.writeFile(siblingFile, `export const sibling${index} = true;`);
      await tracker.recordFileRead(siblingFile, 'shared-session');
    }
    compactChat.mockResolvedValueOnce({
      content: '<summary>Preserve the active workspace file.</summary>',
    });

    const result = await CompactionService.compact(
      [{ role: 'user', content: 'Continue the active task.' }],
      {
        trigger: 'auto',
        modelName: 'test-model',
        maxContextTokens: 6_000,
        apiKey: 'test-key',
        baseURL: 'https://example.invalid',
        sessionId: 'shared-session',
        workspaceRoot: activeWorkspace,
      }
    );

    const restoration = result.compactedMessages.find(
      (message) =>
        (message.metadata as Record<string, unknown> | undefined)
          ?.isPostCompactRestoration === true
    );
    expect(restoration?.content).toContain('export const retained = true;');
  });

  test('超过 200 行的文件应被截断', async () => {
    // 创建一个超过 200 行的文件
    const longFilePath = path.join(tmpDir, 'long-file.ts');
    const longLines = Array.from({ length: 300 }, (_, ln) => `// line ${ln + 1}`);
    await fs.writeFile(longFilePath, longLines.join('\n'));

    const content = await fs.readFile(longFilePath, 'utf-8');
    const lines = content.split('\n');
    const preview = lines.slice(0, 200).join('\n');
    const truncated =
      lines.length > 200 ? `\n... (${lines.length - 200} more lines)` : '';

    // 验证截断
    expect(lines.length).toBe(300);
    expect(preview.split('\n')).toHaveLength(200);
    expect(truncated).toContain('100 more lines');
  });

  test('已删除的文件应被静默跳过', async () => {
    const tracker = FileAccessTracker.getInstance();
    const deletedFile = path.join(tmpDir, 'deleted-file.ts');
    await fs.writeFile(deletedFile, '// will be deleted');
    await tracker.recordFileRead(deletedFile, 'sess1');
    await tracker.recordFileRead(testFiles[0], 'sess1');

    // 删除文件
    await fs.unlink(deletedFile);

    // 模拟恢复逻辑
    const recentFiles = [deletedFile, testFiles[0]];
    const fileRestorations: string[] = [];

    for (const filePath of recentFiles) {
      try {
        const content = await fs.readFile(filePath, 'utf-8');
        const lines = content.split('\n');
        const preview = lines.slice(0, 200).join('\n');
        fileRestorations.push(
          `<file path="${filePath}" lines="${lines.length}">` + `\n${preview}\n</file>`
        );
      } catch {
        // 文件可能已被删除，静默跳过
      }
    }

    // 只有存在的文件应该被恢复
    expect(fileRestorations).toHaveLength(1);
    expect(fileRestorations[0]).toContain(testFiles[0]);
  });
});
