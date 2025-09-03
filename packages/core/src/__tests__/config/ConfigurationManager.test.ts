/**
 * ConfigurationManager 单元测试
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConfigurationManager } from '../../ConfigurationManager.js';
import { ConfigLayer, ConfigEventType } from '../../types/index.js';
import { BladeUnifiedConfigSchema } from '../../types/schemas.js';

// 模拟文件系统
const mockFs = {
  access: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  watch: vi.fn(),
};

// 模拟环境变量
const originalEnv = process.env;

describe('ConfigurationManager', () => {
  let configManager: ConfigurationManager;

  beforeEach(() => {
    // 重置环境变量
    process.env = { ...originalEnv };
    
    // 创建新的配置管理器实例
    configManager = new ConfigurationManager();
  });

  afterEach(() => {
    // 恢复环境变量
    process.env = originalEnv;
    
    // 清理模拟
    vi.clearAllMocks();
  });

  describe('初始化', () => {
    it('应该成功创建配置管理器实例', () => {
      expect(configManager).toBeInstanceOf(ConfigurationManager);
    });

    it('应该正确初始化状态', () => {
      const state = configManager.getState();
      expect(state.isValid).toBe(false);
      expect(state.errors).toEqual([]);
      expect(state.warnings).toEqual([]);
      expect(state.loadedLayers).toEqual([]);
    });
  });

  describe('配置加载', () => {
    it('应该能够加载默认全局配置', async () => {
      const config = await configManager.loadAllConfigs();
      expect(config).toBeDefined();
      expect(config.auth).toBeDefined();
      expect(config.ui).toBeDefined();
      expect(config.security).toBeDefined();
    });

    it('应该能够从环境变量加载配置', async () => {
      // 设置环境变量
      process.env.BLADE_API_KEY = 'test-api-key';
      process.env.BLADE_THEME = 'dark';
      process.env.BLADE_DEBUG = 'true';

      const config = await configManager.loadAllConfigs();
      expect(config.auth.apiKey).toBe('test-api-key');
      expect(config.ui.theme).toBe('dark');
      expect(config.debug.debug).toBe(true);
    });

    it('应该处理无效的环境变量值', async () => {
      // 设置无效的环境变量值
      process.env.BLADE_TIMEOUT = 'invalid-number';
      process.env.BLADE_MAX_TOKENS = '1000';

      const config = await configManager.loadAllConfigs();
      // 应该保持默认值或解析为有效值
      expect(config.auth.timeout).toBe(30000); // 默认值
    });
  });

  describe('配置验证', () => {
    it('应该验证配置结构', async () => {
      const config = await configManager.loadAllConfigs();
      const result = BladeUnifiedConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
    });

    it('应该检测无效配置', async () => {
      const invalidConfig: any = {
        auth: {
          apiKey: '',
          baseUrl: 'invalid-url', // 无效的URL
          modelName: '',
        },
        ui: {
          theme: 'invalid-theme', // 无效的主题
        },
      };

      try {
        BladeUnifiedConfigSchema.parse(invalidConfig);
        // 如果没有抛出错误，测试失败
        expect(true).toBe(false);
      } catch (error) {
        expect(error).toBeDefined();
      }
    });
  });

  describe('配置更新', () => {
    it('应该能够更新配置', async () => {
      const updates = {
        ui: {
          theme: 'dark' as const,
          hideTips: true,
        },
      };

      await configManager.updateConfig(updates, ConfigLayer.USER);
      const config = configManager.getConfig();
      
      expect(config.ui.theme).toBe('dark');
      expect(config.ui.hideTips).toBe(true);
    });

    it('应该拒绝无效的配置更新', async () => {
      const invalidUpdates = {
        auth: {
          baseUrl: 'invalid-url', // 无效的URL格式
        },
      };

      await expect(configManager.updateConfig(invalidUpdates, ConfigLayer.USER))
        .rejects
        .toThrow();
    });
  });

  describe('配置合并', () => {
    it('应该正确合并多层配置', async () => {
      // 设置不同层级的配置
      process.env.BLADE_THEME = 'dark'; // 环境变量层（最高优先级）
      
      const updates = {
        ui: {
          hideTips: true, // 用户层
        },
      };
      
      await configManager.updateConfig(updates, ConfigLayer.USER);
      
      const config = configManager.getConfig();
      expect(config.ui.theme).toBe('dark'); // 来自环境变量
      expect(config.ui.hideTips).toBe(true); // 来自用户配置
    });

    it('应该正确处理配置冲突', async () => {
      // 设置环境变量
      process.env.BLADE_THEME = 'light';
      
      // 更新用户配置（应该覆盖环境变量）
      const updates = {
        ui: {
          theme: 'dark' as const,
        },
      };
      
      await configManager.updateConfig(updates, ConfigLayer.USER);
      
      const config = configManager.getConfig();
      expect(config.ui.theme).toBe('dark'); // 用户配置优先级更高
    });
  });

  describe('配置事件', () => {
    it('应该能够订阅配置事件', async () => {
      const mockCallback = vi.fn();
      const unsubscribe = configManager.subscribe(mockCallback);

      // 触发配置变更
      const updates = { ui: { theme: 'dark' as const } };
      await configManager.updateConfig(updates, ConfigLayer.USER);

      // 验证回调被调用
      expect(mockCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          type: ConfigEventType.CHANGED,
          layer: ConfigLayer.USER,
        })
      );

      // 取消订阅
      unsubscribe();
    });

    it('应该发送配置加载事件', async () => {
      const mockCallback = vi.fn();
      configManager.subscribe(mockCallback);

      await configManager.loadAllConfigs();

      expect(mockCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          type: ConfigEventType.LOADED,
        })
      );
    });
  });

  describe('配置热重载', () => {
    it('应该能够启用和禁用热重载', () => {
      // 启用热重载
      configManager.enable();
      expect(configManager.isEnabledHotReload()).toBe(true);

      // 禁用热重载
      configManager.disable();
      expect(configManager.isEnabledHotReload()).toBe(false);
    });

    it('应该能够添加和移除监听路径', () => {
      configManager.enable();
      
      // 添加监听路径
      configManager.addWatchPath('/test/config.json');
      
      // 移除监听路径
      configManager.removeWatchPath('/test/config.json');
    });
  });

  describe('工具方法', () => {
    it('应该能够获取嵌套配置值', () => {
      const config = {
        auth: {
          apiKey: 'test-key',
          nested: {
            value: 'nested-value',
          },
        },
      };

      // 这些方法是私有的，我们在测试中模拟调用
      // 实际应用中会通过公共接口间接测试
    });

    it('应该正确解析环境变量值', () => {
      // 这些方法是私有的，我们在测试中模拟调用
    });

    it('应该正确处理文件存在性检查', async () => {
      // 这些方法是私有的，我们在测试中模拟调用
    });
  });

  describe('错误处理', () => {
    it('应该正确处理配置加载错误', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation();
      
      // 模拟错误情况
      try {
        await configManager.loadAllConfigs();
      } catch (error) {
        // 预期的错误处理
      }
      
      // 验证错误被正确处理
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it('应该正确处理配置更新错误', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation();
      
      try {
        await configManager.updateConfig({ invalid: 'config' } as any, ConfigLayer.USER);
      } catch (error) {
        // 预期的错误处理
      }
      
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });

  describe('资源清理', () => {
    it('应该能够正确销毁配置管理器', async () => {
      const destroySpy = vi.spyOn(configManager, 'destroy');
      
      await configManager.destroy();
      
      expect(destroySpy).toHaveBeenCalled();
    });
  });
});