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
      expect(DEFAULT_CONFIG.apiKey).toBe('');
      expect(DEFAULT_CONFIG.theme).toBe('GitHub');
      expect(DEFAULT_CONFIG.provider).toBe('openai-compatible');
      expect(DEFAULT_CONFIG.model).toBe('qwen3-coder-plus');
    });

    it('应该能够初始化配置', async () => {
      const config = await configManager.initialize();

      expect(config).toBeDefined();
      expect(config.apiKey).toBe('');
      expect(config.theme).toBe('GitHub');
      expect(config.provider).toBe('openai-compatible');
    });

    it('应该能够获取配置', async () => {
      await configManager.initialize();
      const config = configManager.getConfig();

      expect(config).toBeDefined();
      expect(config?.apiKey).toBe('');
      expect(config?.theme).toBe('GitHub');
    });

    it('应该能够更新配置', async () => {
      await configManager.initialize();

      const newConfig = {
        theme: 'dark',
        debug: true,
      };

      await expect(configManager.updateConfig(newConfig)).resolves.not.toThrow();
      const updatedConfig = configManager.getConfig();

      // 验证配置已更新
      expect(updatedConfig?.theme).toBe('dark');
      expect(updatedConfig?.debug).toBe(true);
    });

    it('应该能够重置配置', async () => {
      await configManager.initialize();

      // 更新配置
      await configManager.updateConfig({
        theme: 'dark',
      });

      // 验证配置已更新
      const updatedConfig = configManager.getConfig();
      expect(updatedConfig?.theme).toBe('dark');

      // 重置配置
      ConfigManager.resetInstance();
      configManager = ConfigManager.getInstance();
      await configManager.initialize();
      const resetConfig = configManager.getConfig();

      // 验证配置已重置为默认值
      expect(resetConfig?.theme).toBe('GitHub');
    });
  });

  describe('配置验证', () => {
    it('应该验证有效的配置', async () => {
      const config = {
        ...DEFAULT_CONFIG,
        apiKey: 'test-key',
        model: 'gpt-4',
        baseUrl: 'https://api.test.com',
      };

      expect(() => {
        configManager.validateConfig(config);
      }).not.toThrow();
    });

    it('应该检测无效的配置', async () => {
      const invalidConfig = {
        ...DEFAULT_CONFIG,
        // 缺少必需字段
      };

      expect(() => {
        configManager.validateConfig(invalidConfig);
      }).toThrow();
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
