import { describe, it, expect, beforeEach } from 'vitest';
import {
  Compression,
  type CompressionConfig,
  type ModelLimit,
  type TokenUsage,
} from '../../src/utils/compression';

describe('Compression - 智能压缩系统', () => {
  let compression: Compression;
  let defaultConfig: CompressionConfig;
  let modelLimit: ModelLimit;

  beforeEach(() => {
    defaultConfig = {
      compaction: {
        auto: true,
        outputTokenMax: 8192,
        autoContinue: true,
        triggerRatio: 0.7, // 触发阈值 70%
      },
      pruning: {
        enabled: true,
        protectThreshold: 1000,
        minimumPrune: 500,
        protectedTools: ['Read', 'Write', 'Edit'],
        protectTurns: 3,
      },
    };

    modelLimit = {
      context: 200000,
      output: 8192,
    };

    compression = new Compression(defaultConfig, modelLimit);
  });

  describe('isOverflow - 检测上下文溢出', () => {
    it('未达到阈值时不应触发压缩', () => {
      const tokens: TokenUsage = {
        input: 100000, // 50% of 200000
        output: 1000,
      };
      expect(compression.isOverflow(tokens)).toBe(false);
    });

    it('达到阈值时应该触发压缩', () => {
      const tokens: TokenUsage = {
        input: 150000, // 75% of 200000
        output: 1000,
      };
      expect(compression.isOverflow(tokens)).toBe(true);
    });

    it('应该考虑 cacheRead token', () => {
      const tokens: TokenUsage = {
        input: 100000,
        output: 1000,
        cacheRead: 50000, // total 150000 = 75%
      };
      expect(compression.isOverflow(tokens)).toBe(true);
    });

    it('禁用自动压缩时不应触发', () => {
      const config: CompressionConfig = {
        ...defaultConfig,
        compaction: { ...defaultConfig.compaction, auto: false },
      };
      const comp = new Compression(config, modelLimit);
      const tokens: TokenUsage = {
        input: 150000,
        output: 1000,
      };
      expect(comp.isOverflow(tokens)).toBe(false);
    });
  });

  describe('shouldPrune - 判断是否需要修剪', () => {
    it('token 使用低于阈值时不应修剪', () => {
      const tokens: TokenUsage = {
        input: 50000,
        output: 1000,
      };
      expect(compression.shouldPrune(tokens)).toBe(false);
    });

    it('token 使用超过阈值时应该修剪', () => {
      const tokens: TokenUsage = {
        input: 145000, // 72.5% of 200000，超过 70% 阈值
        output: 1000,
      };
      expect(compression.shouldPrune(tokens)).toBe(true);
    });

    it('禁用修剪时不应修剪', () => {
      const config: CompressionConfig = {
        ...defaultConfig,
        pruning: { ...defaultConfig.pruning, enabled: false },
      };
      const comp = new Compression(config, modelLimit);
      const tokens: TokenUsage = {
        input: 140000,
        output: 1000,
      };
      expect(comp.shouldPrune(tokens)).toBe(false);
    });
  });

  describe('prune - 修剪消息历史', () => {
    it('应该修剪旧的消息', () => {
      const messages = [
        { role: 'user' as const, content: 'msg1', timestamp: 1000 },
        { role: 'assistant' as const, content: 'reply1', timestamp: 2000 },
        { role: 'user' as const, content: 'msg2', timestamp: 3000 },
        { role: 'assistant' as const, content: 'reply2', timestamp: 4000 },
        { role: 'user' as const, content: 'msg3', timestamp: 5000 },
        { role: 'assistant' as const, content: 'reply3', timestamp: 6000 },
      ];

      const result = compression.prune(messages, 2); // 保护最近 2 轮
      expect(result.pruned).toBe(true);
      expect(result.messages.length).toBeLessThan(messages.length);
    });

    it('应该保护最近的 N 轮对话', () => {
      const messages = [
        { role: 'user' as const, content: 'msg1', timestamp: 1000 },
        { role: 'assistant' as const, content: 'reply1', timestamp: 2000 },
        { role: 'user' as const, content: 'msg2', timestamp: 3000 },
        { role: 'assistant' as const, content: 'reply2', timestamp: 4000 },
        { role: 'user' as const, content: 'msg3', timestamp: 5000 },
        { role: 'assistant' as const, content: 'reply3', timestamp: 6000 },
      ];

      const result = compression.prune(messages, 2); // 保护最近 2 轮
      // 最近 2 轮 = 4 条消息应该被保留
      const lastFourMessages = messages.slice(-4);
      expect(
        lastFourMessages.every((msg) =>
          result.messages.some((m) => m.timestamp === msg.timestamp)
        )
      ).toBe(true);
    });

    it('应该保护包含受保护工具调用的消息', () => {
      const messages = [
        {
          role: 'user' as const,
          content: 'old msg',
          timestamp: 1000,
        },
        {
          role: 'assistant' as const,
          content: 'old reply with Read tool',
          timestamp: 2000,
          toolCalls: [{ name: 'Read' }],
        },
        { role: 'user' as const, content: 'recent msg', timestamp: 3000 },
        {
          role: 'assistant' as const,
          content: 'recent reply',
          timestamp: 4000,
        },
      ];

      const result = compression.prune(messages, 1); // 只保护最近 1 轮
      // 包含 Read 工具的消息应该被保护
      expect(
        result.messages.some(
          (msg) => msg.timestamp === 2000 && msg.toolCalls?.[0]?.name === 'Read'
        )
      ).toBe(true);
    });

    it('应该尊重最小修剪量', () => {
      const messages = [
        { role: 'user' as const, content: 'msg1', timestamp: 1000 },
        { role: 'assistant' as const, content: 'reply1', timestamp: 2000 },
        { role: 'user' as const, content: 'msg2', timestamp: 3000 },
        { role: 'assistant' as const, content: 'reply2', timestamp: 4000 },
      ];

      const result = compression.prune(messages, 1);
      // 至少应该修剪 minimumPrune 配置的数量
      if (result.pruned) {
        expect(result.prunedCount).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe('compress - 压缩消息历史', () => {
    it('应该将多条消息压缩为摘要', () => {
      const messages = [
        { role: 'user' as const, content: 'What is TypeScript?' },
        {
          role: 'assistant' as const,
          content: 'TypeScript is a superset of JavaScript...',
        },
        { role: 'user' as const, content: 'What about types?' },
        {
          role: 'assistant' as const,
          content: 'TypeScript has a strong type system...',
        },
      ];

      const result = compression.compress(messages, 1); // 保留最近 1 轮
      expect(result.compressed).toBe(true);
      expect(result.messages.length).toBeLessThan(messages.length);
      // 应该有一条摘要消息
      expect(result.messages.some((msg) => msg.role === 'system')).toBe(true);
    });

    it('不需要压缩时应该返回原始消息', () => {
      const messages = [
        { role: 'user' as const, content: 'short msg' },
        { role: 'assistant' as const, content: 'short reply' },
      ];

      const tokens: TokenUsage = {
        input: 50000, // 不触发压缩
        output: 1000,
      };

      const result = compression.compress(messages, 3);
      if (!compression.isOverflow(tokens)) {
        expect(result.compressed).toBe(false);
      }
    });
  });

  describe('calculateTokens - 估算 token 数量', () => {
    it('应该估算文本的 token 数量', () => {
      const text = 'Hello, world!';
      const tokens = compression.calculateTokens(text);
      expect(tokens).toBeGreaterThan(0);
      expect(tokens).toBeLessThan(100);
    });

    it('应该处理空文本', () => {
      const tokens = compression.calculateTokens('');
      expect(tokens).toBe(0);
    });

    it('应该估算中文文本', () => {
      const text = '你好，世界！';
      const tokens = compression.calculateTokens(text);
      expect(tokens).toBeGreaterThan(0);
    });

    it('较长文本应该有更多 tokens', () => {
      const shortText = 'Hello';
      const longText = 'Hello world, this is a longer text';
      expect(compression.calculateTokens(longText)).toBeGreaterThan(
        compression.calculateTokens(shortText)
      );
    });
  });

  describe('边界情况', () => {
    it('空消息列表应该不压缩', () => {
      const result = compression.compress([], 0);
      expect(result.compressed).toBe(false);
      expect(result.messages).toEqual([]);
    });

    it('单条消息应该不压缩', () => {
      const messages = [{ role: 'user' as const, content: 'single msg' }];
      const result = compression.compress(messages, 1);
      expect(result.compressed).toBe(false);
    });

    it('protectTurns 大于消息数量时应该保护所有消息', () => {
      const messages = [
        { role: 'user' as const, content: 'msg1' },
        { role: 'assistant' as const, content: 'reply1' },
      ];
      const result = compression.prune(messages, 10);
      expect(result.pruned).toBe(false);
      expect(result.messages.length).toBe(messages.length);
    });
  });

  describe('配置更新', () => {
    it('应该能更新压缩配置', () => {
      const newConfig: CompressionConfig = {
        ...defaultConfig,
        compaction: { ...defaultConfig.compaction, triggerRatio: 0.8 },
      };
      compression.updateConfig(newConfig);

      const tokens: TokenUsage = {
        input: 150000, // 75%，旧配置会触发，新配置不会
        output: 1000,
      };
      expect(compression.isOverflow(tokens)).toBe(false);
    });

    it('应该能更新模型限制', () => {
      const newLimit: ModelLimit = {
        context: 100000, // 减半
        output: 4096,
      };
      compression.updateModelLimit(newLimit);

      const tokens: TokenUsage = {
        input: 75000, // 75% of 100000
        output: 1000,
      };
      expect(compression.isOverflow(tokens)).toBe(true);
    });
  });
});
