/**
 * loopEventHandler — createLoopEventHandler 单元测试
 *
 * 覆盖 plan.md 中的 8 个高优先级并发/幂等场景：
 * 1. 正常 stream_end 提交
 * 2. 短回复从未触发 flush，直接 stream_end
 * 3. abort 后 late stream_end 跳过 finalize
 * 4. model_fallback 后 late stream_end 不复活内容
 * 5. model_fallback 双层缓冲清理
 * 6. content_delta 累加统计
 * 7. thinking_delta 受 thinkingModeEnabled 开关控制
 * 8. stream_end 幂等性（多次 stream_end 不会重复 finalize）
 * 9. 多轮 turn stream_end 均正常 finalize（per-turn 重置）
 * 10. abort 后 late content_delta/thinking_delta 不污染缓冲区
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  createLoopEventHandler,
  type LoopEventDeps,
  type LoopEventStats,
} from '../../../../../src/ui/utils/loopEventHandler.js';
import type { LoopEvent } from '../../../../../src/agent/loop/types.js';

// Mock 外部依赖 — Logger、markdownIncremental、toolFormatters
vi.mock('../../../../../src/logging/Logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  LogCategory: { UI: 'UI' },
}));

vi.mock('../../../../../src/logging/StreamDebugLogger.js', () => ({
  streamDebug: vi.fn(),
}));

vi.mock('../../../../../src/ui/utils/markdownIncremental.js', () => ({
  appendMarkdownDelta: vi.fn(),
  finalizeMarkdownCache: vi.fn(),
}));

vi.mock('../../../../../src/ui/utils/toolFormatters.js', () => ({
  formatToolCallSummary: vi.fn(() => 'tool summary'),
  generateToolDetail: vi.fn(() => null),
  shouldShowToolDetail: vi.fn(() => false),
}));

// ==================== 测试工具 ====================

function createMockDeps(overrides?: Partial<LoopEventDeps>): LoopEventDeps {
  const controller = new AbortController();
  return {
    sessionActions: {
      finalizeStreamingMessage: vi.fn(),
      discardStreamingMessage: vi.fn(),
      setCurrentThinkingContent: vi.fn(),
      appendAssistantContent: vi.fn(() => 'msg-1'),
      appendThinkingContent: vi.fn(),
      addToolMessage: vi.fn(),
      updateTokenUsage: vi.fn(),
      setCompacting: vi.fn(),
      resetTokenUsage: vi.fn(),
    } as any,
    appActions: {
      setTasks: vi.fn(),
    } as any,
    streamingBuffer: {
      batchAppendContent: vi.fn(),
      batchAppendThinking: vi.fn(),
      flushContentBuffer: vi.fn(),
      flushThinkingBuffer: vi.fn(),
      resetStreamingBuffers: vi.fn(),
      drainPendingBuffers: vi.fn(() => ({ extraContent: '', extraThinking: '' })),
    },
    thinkingModeEnabled: false,
    getStreamingMessageId: vi.fn(() => 'streaming-msg-1'),
    signal: controller.signal,
    ...overrides,
  };
}

function createMockStats(): LoopEventStats {
  return { contentDeltaCount: 0, contentDeltaTotalLen: 0 };
}

// ==================== 测试 ====================

describe('createLoopEventHandler', () => {
  // ==================== 场景 1: 正常 stream_end ====================

  describe('正常 stream_end 提交', () => {
    it('stream_end 应该 drain 缓冲区并 finalize', () => {
      const deps = createMockDeps();
      (
        deps.streamingBuffer.drainPendingBuffers as ReturnType<typeof vi.fn>
      ).mockReturnValue({
        extraContent: 'remaining content',
        extraThinking: 'remaining thinking',
      });
      const stats = createMockStats();
      const handler = createLoopEventHandler(deps, stats);

      handler({ kind: 'stream_end' } as LoopEvent);

      // 应该调用 drainPendingBuffers
      expect(deps.streamingBuffer.drainPendingBuffers).toHaveBeenCalledOnce();
      // 应该调用 finalizeStreamingMessage
      expect(deps.sessionActions.finalizeStreamingMessage).toHaveBeenCalledWith(
        'remaining content',
        'remaining thinking'
      );
    });

    it('stream_end 有 streamingId 时应该 append + finalize markdown cache', async () => {
      const { appendMarkdownDelta, finalizeMarkdownCache } = await import(
        '../../../../../src/ui/utils/markdownIncremental.js'
      );

      const deps = createMockDeps();
      (
        deps.streamingBuffer.drainPendingBuffers as ReturnType<typeof vi.fn>
      ).mockReturnValue({
        extraContent: 'extra',
        extraThinking: '',
      });
      const stats = createMockStats();
      const handler = createLoopEventHandler(deps, stats);

      handler({ kind: 'stream_end' } as LoopEvent);

      expect(appendMarkdownDelta).toHaveBeenCalledWith('streaming-msg-1', 'extra');
      expect(finalizeMarkdownCache).toHaveBeenCalledWith('streaming-msg-1');
    });

    it('stream_end extraContent 为空时不调用 appendMarkdownDelta', async () => {
      const { appendMarkdownDelta } = await import(
        '../../../../../src/ui/utils/markdownIncremental.js'
      );
      vi.mocked(appendMarkdownDelta).mockClear();

      const deps = createMockDeps();
      (
        deps.streamingBuffer.drainPendingBuffers as ReturnType<typeof vi.fn>
      ).mockReturnValue({
        extraContent: '',
        extraThinking: '',
      });
      const stats = createMockStats();
      const handler = createLoopEventHandler(deps, stats);

      handler({ kind: 'stream_end' } as LoopEvent);

      expect(appendMarkdownDelta).not.toHaveBeenCalled();
    });
  });

  // ==================== 场景 2: 短回复从未触发 flush ====================

  describe('短回复从未触发 flush，直接 stream_end', () => {
    it('短内容全部在 extraContent 中，stream_end 应该正常 finalize', () => {
      const deps = createMockDeps({
        // 短回复时 streamingId 为 null（从未 flush 过）
        getStreamingMessageId: vi.fn(() => null),
      });
      (
        deps.streamingBuffer.drainPendingBuffers as ReturnType<typeof vi.fn>
      ).mockReturnValue({
        extraContent: 'short reply',
        extraThinking: '',
      });
      const stats = createMockStats();
      const handler = createLoopEventHandler(deps, stats);

      // 模拟短内容（低于 flush 阈值）
      handler({ kind: 'content_delta', delta: 'short reply' } as LoopEvent);
      handler({ kind: 'stream_end' } as LoopEvent);

      // 关键断言：不因 streamingId === null 而丢弃
      // finalizeStreamingMessage 在 streamingId 为 null 时会自动生成新 ID
      expect(deps.sessionActions.finalizeStreamingMessage).toHaveBeenCalledWith(
        'short reply',
        ''
      );
    });
  });

  // ==================== 场景 3: abort 后 late stream_end ====================

  describe('abort 后 late stream_end 跳过 finalize', () => {
    it('signal.aborted 为 true 时 stream_end 只做 drain 清理', () => {
      const controller = new AbortController();
      const deps = createMockDeps({ signal: controller.signal });
      const stats = createMockStats();
      const handler = createLoopEventHandler(deps, stats);

      // 模拟：先收到一些 content_delta
      handler({ kind: 'content_delta', delta: 'hello ' } as LoopEvent);
      handler({ kind: 'content_delta', delta: 'world' } as LoopEvent);

      // 模拟 handleAbort 已执行（abort signal）
      controller.abort();

      // 晚到的 stream_end
      handler({ kind: 'stream_end' } as LoopEvent);

      // 不应 drain 缓冲区（abort 路径已完成 drain+finalize，此时缓冲区可能属于新任务）
      expect(deps.streamingBuffer.drainPendingBuffers).not.toHaveBeenCalled();
      // 不应调用 finalize（handleAbort 已经 finalize 过了）
      expect(deps.sessionActions.finalizeStreamingMessage).not.toHaveBeenCalled();
    });

    it('abort 后连续两个 stream_end 都不 finalize', () => {
      const controller = new AbortController();
      const deps = createMockDeps({ signal: controller.signal });
      const stats = createMockStats();
      const handler = createLoopEventHandler(deps, stats);

      controller.abort();

      handler({ kind: 'stream_end' } as LoopEvent);
      handler({ kind: 'stream_end' } as LoopEvent);

      expect(deps.sessionActions.finalizeStreamingMessage).not.toHaveBeenCalled();
      // 不应 drain（abort 守卫直接跳过，防止误清新任务内容）
      expect(deps.streamingBuffer.drainPendingBuffers).not.toHaveBeenCalled();
    });
  });

  // ==================== 场景 4: model_fallback 后 late stream_end ====================

  describe('model_fallback 后 late stream_end 不复活内容', () => {
    it('model_fallback 后 stream_end 跳过 finalize', () => {
      const deps = createMockDeps();
      const stats = createMockStats();
      const handler = createLoopEventHandler(deps, stats);

      // 先收到一些内容
      handler({ kind: 'content_delta', delta: 'partial' } as LoopEvent);

      // model_fallback 触发
      handler({ kind: 'model_fallback' } as LoopEvent);

      // 验证 model_fallback 的清理动作
      expect(deps.streamingBuffer.resetStreamingBuffers).toHaveBeenCalled();
      expect(deps.sessionActions.discardStreamingMessage).toHaveBeenCalled();
      expect(deps.sessionActions.setCurrentThinkingContent).toHaveBeenCalledWith(null);

      // 晚到的 stream_end
      handler({ kind: 'stream_end' } as LoopEvent);

      // 关键：finalize 不应被调用（不复活已丢弃的内容）
      expect(deps.sessionActions.finalizeStreamingMessage).not.toHaveBeenCalled();
    });

    it('model_fallback 后 stream_end 不 drain（防止误清新任务内容）', () => {
      const deps = createMockDeps();
      const stats = createMockStats();
      const handler = createLoopEventHandler(deps, stats);

      handler({ kind: 'model_fallback' } as LoopEvent);
      handler({ kind: 'stream_end' } as LoopEvent);

      // 不应 drain（streamFinalized 守卫直接跳过）
      expect(deps.streamingBuffer.drainPendingBuffers).not.toHaveBeenCalled();
    });
  });

  // ==================== 场景 5: model_fallback 双层缓冲清理 ====================

  describe('model_fallback 双层缓冲清理', () => {
    it('应该同时清理 hook 层和 store 层', () => {
      const deps = createMockDeps();
      const stats = createMockStats();
      const handler = createLoopEventHandler(deps, stats);

      handler({ kind: 'model_fallback' } as LoopEvent);

      // hook 层：resetStreamingBuffers
      expect(deps.streamingBuffer.resetStreamingBuffers).toHaveBeenCalledOnce();
      // store 层：discardStreamingMessage
      expect(deps.sessionActions.discardStreamingMessage).toHaveBeenCalledOnce();
      // thinking 层：清空 thinking
      expect(deps.sessionActions.setCurrentThinkingContent).toHaveBeenCalledWith(null);
    });
  });

  // ==================== 场景 6: content_delta 累加统计 ====================

  describe('content_delta 累加统计', () => {
    it('应该正确累加 count 和 totalLen', () => {
      const deps = createMockDeps();
      const stats = createMockStats();
      const handler = createLoopEventHandler(deps, stats);

      handler({ kind: 'content_delta', delta: 'abc' } as LoopEvent);
      handler({ kind: 'content_delta', delta: 'defgh' } as LoopEvent);
      handler({ kind: 'content_delta', delta: 'i' } as LoopEvent);

      expect(stats.contentDeltaCount).toBe(3);
      expect(stats.contentDeltaTotalLen).toBe(9); // 3 + 5 + 1
    });

    it('应该将 delta 传递给 batchAppendContent', () => {
      const deps = createMockDeps();
      const stats = createMockStats();
      const handler = createLoopEventHandler(deps, stats);

      handler({ kind: 'content_delta', delta: 'hello' } as LoopEvent);

      expect(deps.streamingBuffer.batchAppendContent).toHaveBeenCalledWith('hello');
    });
  });

  // ==================== 场景 7: thinking_delta 开关控制 ====================

  describe('thinking_delta 受 thinkingModeEnabled 控制', () => {
    it('thinkingModeEnabled=true 时应该追加 thinking', () => {
      const deps = createMockDeps({ thinkingModeEnabled: true });
      const stats = createMockStats();
      const handler = createLoopEventHandler(deps, stats);

      handler({ kind: 'thinking_delta', delta: 'reasoning...' } as LoopEvent);

      expect(deps.streamingBuffer.batchAppendThinking).toHaveBeenCalledWith(
        'reasoning...'
      );
    });

    it('thinkingModeEnabled=false 时应该忽略 thinking_delta', () => {
      const deps = createMockDeps({ thinkingModeEnabled: false });
      const stats = createMockStats();
      const handler = createLoopEventHandler(deps, stats);

      handler({ kind: 'thinking_delta', delta: 'reasoning...' } as LoopEvent);

      expect(deps.streamingBuffer.batchAppendThinking).not.toHaveBeenCalled();
    });
  });

  // ==================== 场景 8: stream_end 幂等性 ====================

  describe('stream_end 幂等性', () => {
    it('正常 stream_end 后再次 stream_end 不应重复 finalize', () => {
      const deps = createMockDeps();
      (
        deps.streamingBuffer.drainPendingBuffers as ReturnType<typeof vi.fn>
      ).mockReturnValue({
        extraContent: 'content',
        extraThinking: '',
      });
      const stats = createMockStats();
      const handler = createLoopEventHandler(deps, stats);

      // 第一次正常 stream_end
      handler({ kind: 'stream_end' } as LoopEvent);
      expect(deps.sessionActions.finalizeStreamingMessage).toHaveBeenCalledOnce();

      // 第二次 stream_end（理论上不应发生，但需要幂等保护）
      handler({ kind: 'stream_end' } as LoopEvent);
      // 不应再次 finalize
      expect(deps.sessionActions.finalizeStreamingMessage).toHaveBeenCalledOnce();
    });
  });

  // ==================== 场景 9: 多轮 turn stream_end 均正常 finalize ====================

  describe('多轮 turn stream_end 均正常 finalize', () => {
    it('同一 handler 跨多 turn，每个 turn 的 stream_end 都应该 finalize', () => {
      const deps = createMockDeps();
      (
        deps.streamingBuffer.drainPendingBuffers as ReturnType<typeof vi.fn>
      ).mockReturnValue({
        extraContent: 'turn content',
        extraThinking: '',
      });
      const stats = createMockStats();
      const handler = createLoopEventHandler(deps, stats);

      // Turn 1
      handler({ kind: 'turn_start', turn: 1, maxTurns: 10 } as LoopEvent);
      handler({ kind: 'content_delta', delta: 'Turn 1 content' } as LoopEvent);
      handler({ kind: 'stream_end' } as LoopEvent);

      expect(deps.sessionActions.finalizeStreamingMessage).toHaveBeenCalledTimes(1);

      // Turn 2
      handler({ kind: 'turn_start', turn: 2, maxTurns: 10 } as LoopEvent);
      handler({ kind: 'content_delta', delta: 'Turn 2 content' } as LoopEvent);
      handler({ kind: 'stream_end' } as LoopEvent);

      // 关键断言：finalizeStreamingMessage 被调用两次（每个 turn 一次）
      expect(deps.sessionActions.finalizeStreamingMessage).toHaveBeenCalledTimes(2);
    });

    it('model_fallback 后新 turn 仍可正常 finalize', () => {
      const deps = createMockDeps();
      (
        deps.streamingBuffer.drainPendingBuffers as ReturnType<typeof vi.fn>
      ).mockReturnValue({
        extraContent: 'recovery content',
        extraThinking: '',
      });
      const stats = createMockStats();
      const handler = createLoopEventHandler(deps, stats);

      // Turn 1: model_fallback → late stream_end（不应 finalize）
      handler({ kind: 'turn_start', turn: 1, maxTurns: 10 } as LoopEvent);
      handler({ kind: 'content_delta', delta: 'partial' } as LoopEvent);
      handler({ kind: 'model_fallback' } as LoopEvent);
      handler({ kind: 'stream_end' } as LoopEvent);

      expect(deps.sessionActions.finalizeStreamingMessage).not.toHaveBeenCalled();

      // Turn 2: 正常流（应 finalize）
      handler({ kind: 'turn_start', turn: 2, maxTurns: 10 } as LoopEvent);
      handler({ kind: 'content_delta', delta: 'Turn 2 content' } as LoopEvent);
      handler({ kind: 'stream_end' } as LoopEvent);

      // 关键断言：Turn 2 的 stream_end 正常 finalize
      expect(deps.sessionActions.finalizeStreamingMessage).toHaveBeenCalledTimes(1);
    });

    it('turn_start 不影响同 turn 内的幂等保护', () => {
      const deps = createMockDeps();
      (
        deps.streamingBuffer.drainPendingBuffers as ReturnType<typeof vi.fn>
      ).mockReturnValue({
        extraContent: 'content',
        extraThinking: '',
      });
      const stats = createMockStats();
      const handler = createLoopEventHandler(deps, stats);

      // 单 turn 内两次 stream_end 仍然幂等
      handler({ kind: 'turn_start', turn: 1, maxTurns: 10 } as LoopEvent);
      handler({ kind: 'stream_end' } as LoopEvent);
      handler({ kind: 'stream_end' } as LoopEvent); // 同 turn 内的重复 stream_end

      expect(deps.sessionActions.finalizeStreamingMessage).toHaveBeenCalledTimes(1);
    });
  });

  // ==================== 闭包隔离性 ====================

  describe('闭包隔离性', () => {
    it('不同 handler 实例的 streamFinalized 互不影响', () => {
      const deps1 = createMockDeps();
      const deps2 = createMockDeps();
      (
        deps1.streamingBuffer.drainPendingBuffers as ReturnType<typeof vi.fn>
      ).mockReturnValue({
        extraContent: 'content1',
        extraThinking: '',
      });
      (
        deps2.streamingBuffer.drainPendingBuffers as ReturnType<typeof vi.fn>
      ).mockReturnValue({
        extraContent: 'content2',
        extraThinking: '',
      });

      const handler1 = createLoopEventHandler(deps1, createMockStats());
      const handler2 = createLoopEventHandler(deps2, createMockStats());

      // handler1 的 stream 已被 abort finalized
      handler1({ kind: 'model_fallback' } as LoopEvent);

      // handler2 应该独立运作，正常 finalize
      handler2({ kind: 'stream_end' } as LoopEvent);

      expect(deps2.sessionActions.finalizeStreamingMessage).toHaveBeenCalledWith(
        'content2',
        ''
      );
      // handler1 不应 finalize
      expect(deps1.sessionActions.finalizeStreamingMessage).not.toHaveBeenCalled();
    });
  });

  // ==================== 场景 10: abort 后 late delta 不污染缓冲区 ====================

  describe('abort 后 late content_delta/thinking_delta 不污染缓冲区', () => {
    it('signal.aborted 后 content_delta 不写入缓冲区', () => {
      const controller = new AbortController();
      const deps = createMockDeps({ signal: controller.signal });
      const stats = createMockStats();
      const handler = createLoopEventHandler(deps, stats);

      // 正常 delta
      handler({ kind: 'content_delta', delta: 'before' } as LoopEvent);
      expect(deps.streamingBuffer.batchAppendContent).toHaveBeenCalledTimes(1);

      // abort
      controller.abort();

      // late delta — 不应写入缓冲区
      handler({ kind: 'content_delta', delta: 'after abort' } as LoopEvent);
      expect(deps.streamingBuffer.batchAppendContent).toHaveBeenCalledTimes(1);
      // 统计也不应累加
      expect(stats.contentDeltaCount).toBe(1);
    });

    it('signal.aborted 后 thinking_delta 不写入缓冲区', () => {
      const controller = new AbortController();
      const deps = createMockDeps({
        signal: controller.signal,
        thinkingModeEnabled: true,
      });
      const stats = createMockStats();
      const handler = createLoopEventHandler(deps, stats);

      // 正常 thinking delta
      handler({ kind: 'thinking_delta', delta: 'thinking before' } as LoopEvent);
      expect(deps.streamingBuffer.batchAppendThinking).toHaveBeenCalledTimes(1);

      // abort
      controller.abort();

      // late thinking delta — 不应写入缓冲区
      handler({ kind: 'thinking_delta', delta: 'thinking after abort' } as LoopEvent);
      expect(deps.streamingBuffer.batchAppendThinking).toHaveBeenCalledTimes(1);
    });
  });

  // ==================== 其他事件 ====================

  describe('其他事件', () => {
    it('token_usage 应该更新 token 使用', () => {
      const deps = createMockDeps();
      const stats = createMockStats();
      const handler = createLoopEventHandler(deps, stats);

      const usage = {
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        maxContextTokens: 4096,
      };
      handler({ kind: 'token_usage', usage } as LoopEvent);

      expect(deps.sessionActions.updateTokenUsage).toHaveBeenCalledWith(usage);
    });

    it('compaction start 应该 setCompacting(true)', () => {
      const deps = createMockDeps();
      const stats = createMockStats();
      const handler = createLoopEventHandler(deps, stats);

      handler({ kind: 'compaction', phase: 'start' } as LoopEvent);

      expect(deps.sessionActions.setCompacting).toHaveBeenCalledWith(true);
    });

    it('compaction end 应该 setCompacting(false) 并 resetTokenUsage', () => {
      const deps = createMockDeps();
      const stats = createMockStats();
      const handler = createLoopEventHandler(deps, stats);

      handler({ kind: 'compaction', phase: 'end' } as LoopEvent);

      expect(deps.sessionActions.setCompacting).toHaveBeenCalledWith(false);
      expect(deps.sessionActions.resetTokenUsage).toHaveBeenCalled();
    });

    it('task_update 应该更新 tasks', () => {
      const deps = createMockDeps();
      const stats = createMockStats();
      const handler = createLoopEventHandler(deps, stats);

      const tasks = [
        {
          id: '1',
          subject: 'task1',
          description: 'task1',
          status: 'pending',
          priority: 'medium',
          blocks: [],
          blockedBy: [],
          createdAt: new Date().toISOString(),
        },
      ];
      handler({ kind: 'task_update', tasks } as LoopEvent);

      expect(deps.appActions.setTasks).toHaveBeenCalledWith(tasks);
    });
  });
});
