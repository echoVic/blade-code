import { describe, expect, it } from 'vitest';
import { createConfig, initializeCore, VERSION } from '../index.js';

describe('Core 包集成测试', () => {
  it('应该正确导出版本信息', () => {
    expect(VERSION).toBe('1.3.0');
  });

  it('应该能够初始化核心功能', async () => {
    await expect(initializeCore()).resolves.not.toThrow();
  });

  it('应该能够创建有效的配置', () => {
    const result = createConfig({
      global: {
        auth: {
          apiKey: 'test-api-key',
          baseUrl: 'https://example.com',
          modelName: 'test-model',
          searchApiKey: '',
        },
        ui: {
          theme: 'dark',
          hideTips: false,
          hideBanner: false,
        },
      },
    });

    expect(result.errors).toHaveLength(0);
    expect(result.config.auth.apiKey).toBe('test-api-key');
    expect(result.config.ui.theme).toBe('dark');
  });

  it('应该处理配置验证错误', () => {
    const result = createConfig({
      global: {
        auth: {
          apiKey: 12345 as any, // 无效类型
          baseUrl: 'https://example.com',
          modelName: 'test-model',
          searchApiKey: '',
        },
      },
    });

    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.config.auth.apiKey).toBe(''); // 应该使用默认值
  });

  it('应该支持多个配置层合并', () => {
    const result = createConfig({
      global: {
        auth: {
          apiKey: 'global-key',
          baseUrl: 'https://global.com',
          modelName: 'global-model',
          searchApiKey: '',
        },
      },
      user: {
        auth: {
          apiKey: 'user-key',
          baseUrl: 'https://user.com',
          modelName: 'user-model',
          searchApiKey: '',
        },
      },
    });

    expect(result.config.auth.apiKey).toBe('user-key'); // user 层覆盖 global 层
    expect(result.config.auth.baseUrl).toBe('https://user.com');
  });
});
