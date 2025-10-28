/**
 * 配置管理集成测试
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ConfigManager } from '../../../src/config/ConfigManager.js';

describe('配置管理集成测试', () => {
  let configManager: ConfigManager;

  beforeEach(async () => {
    // 重置单例实例
    ConfigManager.resetInstance();
    configManager = ConfigManager.getInstance();
    await configManager.initialize();
  });

  afterEach(async () => {
    // 清理环境变量
    delete process.env.BLADE_API_KEY;
    delete process.env.BLADE_THEME;

    // 重置单例实例
    ConfigManager.resetInstance();
  });

  describe('多层配置集成', () => {
    test('应该正确合并默认配置、文件配置和环境变量配置', async () => {
      // 设置环境变量
      process.env.BLADE_API_KEY = 'env-api-key';
      process.env.BLADE_THEME = 'dark';

      // 重新初始化配置
      ConfigManager.resetInstance();
      configManager = ConfigManager.getInstance();
      await configManager.initialize();

      const config = configManager.getConfig();

      // 验证环境变量覆盖了默认配置
      expect(config.apiKey).toBe('env-api-key');
      expect(config.theme).toBe('dark');
    });

    test('应该正确处理配置优先级', async () => {
      // 设置不同层级的配置
      process.env.BLADE_THEME = 'light'; // 环境变量层（最高优先级）

      const userUpdates = {
        theme: 'dark' as const,
      };

      // 更新用户配置（应该覆盖环境变量）
      await configManager.updateConfig(userUpdates);

      const config = configManager.getConfig();

      // 验证用户配置优先级更高
      expect(config.theme).toBe('dark');
    });

    test('应该能够持久化用户配置', async () => {
      const updates = {
        theme: 'dark' as const,
      };

      await configManager.updateConfig(updates);

      // 重新创建配置管理器来验证持久化
      ConfigManager.resetInstance();
      const newConfigManager = ConfigManager.getInstance();
      await newConfigManager.initialize();

      const config = newConfigManager.getConfig();
      expect(config.theme).toBe('dark');
    });
  });

  describe('配置验证集成', () => {
    test('应该拒绝无效的配置更新', async () => {
      const invalidUpdates = {
        baseUrl: 'invalid-url', // 无效的URL格式
      };

      await expect(configManager.updateConfig(invalidUpdates)).rejects.toThrow();
    });

    test('应该验证所有配置层的一致性', async () => {
      // 设置有效的环境变量
      process.env.BLADE_API_KEY = 'valid-api-key';
      process.env.BLADE_MAX_TOKENS = '4000';

      ConfigManager.resetInstance();
      configManager = ConfigManager.getInstance();
      await configManager.initialize();

      const config = configManager.getConfig();
      expect(config).toBeDefined();
      expect(config.apiKey).toBe('valid-api-key');
    });
  });

  describe('配置更新集成', () => {
    test('应该能够更新配置', async () => {
      const updates = { theme: 'dark' as const };
      await configManager.updateConfig(updates);

      const config = configManager.getConfig();
      expect(config.theme).toBe('dark');
    });
  });

  describe('性能集成', () => {
    test('应该在合理时间内加载所有配置', async () => {
      const startTime = Date.now();

      ConfigManager.resetInstance();
      const newConfigManager = ConfigManager.getInstance();
      await newConfigManager.initialize();

      const endTime = Date.now();
      const loadTime = endTime - startTime;

      // 配置加载应该在 2 秒内完成
      expect(loadTime).toBeLessThan(2000);
    });

    test('应该能够处理大量配置更新', async () => {
      // 执行多次配置更新
      const updates = Array.from({ length: 10 }, (_, i) => ({
        theme: (i % 2 === 0 ? 'light' : 'dark') as 'light' | 'dark',
      }));

      for (const update of updates) {
        await configManager.updateConfig(update);
      }

      // 验证最终状态
      const config = configManager.getConfig();
      expect(config).toBeDefined();
    });
  });

  describe('错误处理集成', () => {
    test('应该在配置文件损坏时优雅降级', async () => {
      // 模拟配置文件读取错误
      const fs = await import('fs');
      vi.spyOn(fs.promises, 'readFile').mockRejectedValueOnce(
        new Error('Permission denied')
      );

      ConfigManager.resetInstance();
      const newConfigManager = ConfigManager.getInstance();
      await newConfigManager.initialize();

      // 应该仍然能够工作，使用默认配置
      const config = newConfigManager.getConfig();
      expect(config).toBeDefined();
    });

    test('应该正确处理配置解析错误', async () => {
      // 模拟无效的JSON配置文件
      const fs = await import('fs');
      vi.spyOn(fs.promises, 'readFile').mockResolvedValueOnce(
        'invalid json content' as any
      );

      ConfigManager.resetInstance();
      const newConfigManager = ConfigManager.getInstance();
      await newConfigManager.initialize();

      // 应该仍然能够工作
      const config = newConfigManager.getConfig();
      expect(config).toBeDefined();
    });
  });
});
