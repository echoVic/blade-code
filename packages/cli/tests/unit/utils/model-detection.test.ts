/**
 * modelDetection 单元测试
 */

import { describe, expect, it } from 'vitest';
import type { ModelConfig } from '../../../src/config/types.js';
import {
  detectThinkingSupport,
  getThinkingConfig,
  isThinkingModel,
} from '../../../src/utils/modelDetection.js';

describe('modelDetection', () => {
  describe('detectThinkingSupport', () => {
    it('应该识别 DeepSeek R1 模型', () => {
      expect(detectThinkingSupport('deepseek-r1')).toBe(true);
      expect(detectThinkingSupport('DeepSeek-R1-Distill')).toBe(true);
    });

    it('应该识别 OpenAI o1 模型', () => {
      expect(detectThinkingSupport('o1-preview')).toBe(true);
      expect(detectThinkingSupport('o1-mini')).toBe(true);
      expect(detectThinkingSupport('o1-2024-12-17')).toBe(true);
    });

    it('应该识别通义千问 QwQ', () => {
      expect(detectThinkingSupport('qwen-qwq-32b')).toBe(true);
    });

    it('不应该识别不支持 thinking 的模型', () => {
      expect(detectThinkingSupport('gpt-4')).toBe(false);
      expect(detectThinkingSupport('claude-3-5-sonnet')).toBe(false);
      expect(detectThinkingSupport('gemini-1.5-pro')).toBe(false);
    });
  });

  describe('getThinkingConfig', () => {
    it('用户显式配置应优先', () => {
      const model: ModelConfig = {
        id: 'test',
        name: 'Test',
        provider: 'openai-compatible',
        apiKey: 'key',
        baseUrl: 'url',
        model: 'gpt-4',
        supportsThinking: true, // 强制开启
        thinkingBudget: 1000,
      };

      const config = getThinkingConfig(model);
      expect(config.supportsThinking).toBe(true);
      expect(config.thinkingBudget).toBe(1000);
    });

    it('无显式配置时应使用自动检测', () => {
      const model: ModelConfig = {
        id: 'test',
        name: 'Test',
        provider: 'openai-compatible',
        apiKey: 'key',
        baseUrl: 'url',
        model: 'deepseek-r1',
      };

      const config = getThinkingConfig(model);
      expect(config.supportsThinking).toBe(true);
    });
  });

  describe('isThinkingModel', () => {
    it('应正确判断 thinking 模型', () => {
      const r1: ModelConfig = {
        id: 'r1',
        name: 'R1',
        provider: 'openai-compatible',
        apiKey: 'key',
        baseUrl: 'url',
        model: 'deepseek-r1',
      };

      const gpt4: ModelConfig = {
        id: 'gpt4',
        name: 'GPT4',
        provider: 'openai-compatible',
        apiKey: 'key',
        baseUrl: 'url',
        model: 'gpt-4',
      };

      expect(isThinkingModel(r1)).toBe(true);
      expect(isThinkingModel(gpt4)).toBe(false);
    });
  });
});
