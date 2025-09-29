/**
 * 配置管理集成测试
 */

import { ConfigurationManager } from '../../packages/core/src/config/ConfigurationManager';
import { ConfigLayer } from '../../packages/core/src/config/types/index';

describe('配置管理集成测试', () => {
  let configManager: ConfigurationManager;

  beforeAll(async () => {
    jest.setTimeout(30000);
  });

  beforeEach(async () => {
    configManager = new ConfigurationManager();
    await configManager.loadAllConfigs();
  });

  afterEach(async () => {
    if (configManager) {
      await configManager.destroy();
    }

    // 清理环境变量
    delete process.env.BLADE_API_KEY;
    delete process.env.BLADE_THEME;
    delete process.env.BLADE_DEBUG;
  });

  describe('多层配置集成', () => {
    test('应该正确合并默认配置、文件配置和环境变量配置', async () => {
      // 设置环境变量
      process.env.BLADE_API_KEY = 'env-api-key';
      process.env.BLADE_THEME = 'dark';

      // 重新加载配置
      await configManager.loadAllConfigs();

      const config = configManager.getConfig();

      // 验证环境变量覆盖了默认配置
      expect(config.auth.apiKey).toBe('env-api-key');
      expect(config.ui.theme).toBe('dark');
    });

    test('应该正确处理配置优先级', async () => {
      // 设置不同层级的配置
      process.env.BLADE_THEME = 'light'; // 环境变量层（最高优先级）

      const userUpdates = {
        ui: {
          theme: 'dark' as const,
          hideTips: true,
        },
      };

      // 更新用户配置（应该覆盖环境变量）
      await configManager.updateConfig(userUpdates, ConfigLayer.USER);

      const config = configManager.getConfig();

      // 验证用户配置优先级更高
      expect(config.ui.theme).toBe('dark');
      expect(config.ui.hideTips).toBe(true);
    });

    test('应该能够持久化用户配置', async () => {
      const updates = {
        ui: {
          theme: 'dark' as const,
          hideTips: true,
        },
      };

      await configManager.updateConfig(updates, ConfigLayer.USER);

      // 重新创建配置管理器来验证持久化
      const newConfigManager = new ConfigurationManager();
      await newConfigManager.loadAllConfigs();

      const config = newConfigManager.getConfig();
      expect(config.ui.theme).toBe('dark');
      expect(config.ui.hideTips).toBe(true);

      await newConfigManager.destroy();
    });
  });

  describe('配置验证集成', () => {
    test('应该拒绝无效的配置更新', async () => {
      const invalidUpdates = {
        auth: {
          baseUrl: 'invalid-url', // 无效的URL格式
        },
      };

      await expect(
        configManager.updateConfig(invalidUpdates, ConfigLayer.USER)
      ).rejects.toThrow();
    });

    test('应该验证所有配置层的一致性', async () => {
      // 设置有效的环境变量
      process.env.BLADE_API_KEY = 'valid-api-key';
      process.env.BLADE_MAX_TOKENS = '4000';

      await configManager.loadAllConfigs();

      const state = configManager.getState();
      expect(state.isValid).toBe(true);
      expect(state.errors).toHaveLength(0);
    });
  });

  describe('配置热重载集成', () => {
    test('应该能够监听配置文件变化', async () => {
      // 启用热重载
      configManager.enable();

      // 添加监听路径
      const configPath = '/tmp/test-config.json';
      configManager.addWatchPath(configPath);

      // 这里需要模拟文件系统变化来测试热重载
      // 由于是集成测试，我们只验证接口调用
      expect(configManager.isEnabledHotReload()).toBe(true);

      // 清理
      configManager.removeWatchPath(configPath);
      configManager.disable();
    });

    test('应该正确处理配置文件更新事件', async () => {
      const mockCallback = jest.fn();
      const unsubscribe = configManager.subscribe(mockCallback);

      // 触发配置变更
      const updates = { ui: { theme: 'dark' as const } };
      await configManager.updateConfig(updates, ConfigLayer.USER);

      // 验证事件被触发
      expect(mockCallback).toHaveBeenCalled();

      unsubscribe();
    });
  });

  describe('性能集成', () => {
    test('应该在合理时间内加载所有配置', async () => {
      const startTime = Date.now();

      const newConfigManager = new ConfigurationManager();
      await newConfigManager.loadAllConfigs();

      const endTime = Date.now();
      const loadTime = endTime - startTime;

      // 配置加载应该在 2 秒内完成
      expect(loadTime).toBeLessThan(2000);

      await newConfigManager.destroy();
    });

    test('应该能够处理大量配置更新', async () => {
      // 执行多次配置更新
      const updates = Array.from({ length: 10 }, (_, i) => ({
        ui: {
          theme: (i % 2 === 0 ? 'light' : 'dark') as 'light' | 'dark',
          hideTips: i % 3 === 0,
        },
      }));

      for (const update of updates) {
        await configManager.updateConfig(update, ConfigLayer.USER);
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
      jest
        .spyOn(fs.promises, 'readFile')
        .mockRejectedValueOnce(new Error('Permission denied'));

      const newConfigManager = new ConfigurationManager();
      await newConfigManager.loadAllConfigs();

      // 应该仍然能够工作，使用默认配置
      const config = newConfigManager.getConfig();
      expect(config).toBeDefined();

      await newConfigManager.destroy();
    });

    test('应该正确处理配置解析错误', async () => {
      // 模拟无效的JSON配置文件
      const fs = await import('fs');
      jest
        .spyOn(fs.promises, 'readFile')
        .mockResolvedValueOnce('invalid json content' as any);

      const newConfigManager = new ConfigurationManager();
      await newConfigManager.loadAllConfigs();

      // 应该仍然能够工作
      const config = newConfigManager.getConfig();
      expect(config).toBeDefined();

      await newConfigManager.destroy();
    });
  });
});
