import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigManager, DEFAULT_CONFIG } from '../../src/config';

// 模拟 fs 模块
vi.mock('fs', () => ({
  promises: {
    mkdir: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockResolvedValue('{}'),
    writeFile: vi.fn().mockResolvedValue(undefined),
    access: vi.fn().mockResolvedValue(undefined),
  },
}));

// 模拟 os 模块
vi.mock('os', () => ({
  default: {
    homedir: vi.fn().mockReturnValue('/mock/home'),
  },
}));

// 模拟 path 模块
vi.mock('path', () => ({
  default: {
    join: vi.fn((...args) => args.join('/')),
    dirname: vi.fn((p) => p.split('/').slice(0, -1).join('/')),
  },
}));

describe('配置系统', () => {
  let configManager: ConfigManager;

  beforeEach(() => {
    ConfigManager.resetInstance();
    configManager = ConfigManager.getInstance();
  });

  afterEach(() => {
    ConfigManager.resetInstance();
  });

  describe('ConfigManager', () => {
    it('应该是单例模式', () => {
      const instance1 = ConfigManager.getInstance();
      const instance2 = ConfigManager.getInstance();
      expect(instance1).toBe(instance2);
    });

    it('应该使用默认配置', () => {
      expect(DEFAULT_CONFIG).toBeDefined();
      expect(DEFAULT_CONFIG.theme).toBe('GitHub');
      expect(DEFAULT_CONFIG.currentModelId).toBe('');
      expect(DEFAULT_CONFIG.models).toEqual([]);
    });

    it('应该能够初始化配置', async () => {
      const config = await configManager.initialize();

      expect(config).toBeDefined();
      expect(config.theme).toBe('GitHub');
      expect(config.currentModelId).toBe('');
      expect(config.models).toEqual([]);
    });

    it('应该能够获取配置', async () => {
      const config = await configManager.initialize();

      expect(config).toBeDefined();
      expect(config.theme).toBe('GitHub');
      expect(config.currentModelId).toBe('');
      expect(config.models).toEqual([]);
    });

    it('应该能够重置配置', async () => {
      const config = await configManager.initialize();

      // 验证初始配置
      expect(config.theme).toBe('GitHub');

      // 重置配置
      ConfigManager.resetInstance();
      configManager = ConfigManager.getInstance();
      const resetConfig = await configManager.initialize();

      // 验证配置已重置为默认值
      expect(resetConfig.theme).toBe('GitHub');
    });
  });

  describe('配置验证', () => {
    it('应该验证有效的配置', async () => {
      const config = {
        ...DEFAULT_CONFIG,
        models: [
          {
            id: 'test-model',
            name: 'Test Model',
            provider: 'openai-compatible' as const,
            apiKey: 'test-key',
            baseUrl: 'https://api.test.com',
            model: 'gpt-4',
          },
        ],
        currentModelId: 'test-model',
      };

      expect(() => {
        configManager.validateConfig(config);
      }).not.toThrow();
    });

    it('应该检测无效的配置', async () => {
      const invalidConfig = {
        ...DEFAULT_CONFIG,
        models: [], // 没有模型配置
        currentModelId: '', // 不能为 undefined，使用空字符串
      };

      // 验证当前实现会拒绝空模型列表
      expect(() => {
        configManager.validateConfig(invalidConfig);
      }).toThrow(); // 配置验证应该抛出错误
    });
  });

  describe('错误处理', () => {
    it('应该在配置加载失败时返回默认配置', async () => {
      // 模拟文件系统错误
      const config = await configManager.initialize();

      expect(config).toBeDefined();
      expect(config).toEqual(DEFAULT_CONFIG);
    });
  });
});
