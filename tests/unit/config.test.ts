import { describe, expect, it } from 'vitest';
import { ConfigLayers, createConfig } from '../../config/index.js';
import { ConfigLayer } from '../../config/types.js';

describe('配置系统', () => {
  describe('createConfig', () => {
    it('应该使用默认配置创建有效的配置', () => {
      const result = createConfig({});

      expect(result.errors).toHaveLength(0);
      expect(result.warnings).toHaveLength(0);
      expect(result.config).toBeDefined();
      expect(result.config.auth.apiKey).toBe('');
      expect(result.config.ui.theme).toBe('GitHub');
      expect(result.config.security.sandbox).toBe('docker');
    });

    it('应该合并多个配置层', () => {
      const layers: ConfigLayers = {
        global: {
          auth: {
            apiKey: 'global-key',
            baseUrl: 'https://example.com',
            modelName: 'test-model',
            searchApiKey: '',
          },
          ui: { theme: 'dark', hideTips: false, hideBanner: false },
        },
        user: {
          auth: {
            apiKey: 'user-key',
            baseUrl: 'https://example.com',
            modelName: 'test-model',
            searchApiKey: '',
          },
          ui: { theme: 'dark', hideTips: true, hideBanner: false },
        },
      };

      const result = createConfig(layers);

      expect(result.errors).toHaveLength(0);
      expect(result.config.auth.apiKey).toBe('user-key'); // user 层覆盖 global 层
      expect(result.config.ui.theme).toBe('dark'); // 来自 global 层
      expect(result.config.ui.hideTips).toBe(true); // 来自 user 层
    });

    it('应该按照优先级顺序合并配置', () => {
      const layers: ConfigLayers = {
        global: {
          auth: {
            apiKey: 'global-key',
            baseUrl: 'https://example.com',
            modelName: 'test-model',
            searchApiKey: '',
          },
        },
        user: {
          auth: {
            apiKey: 'user-key',
            baseUrl: 'https://example.com',
            modelName: 'test-model',
            searchApiKey: '',
          },
        },
        env: {
          auth: {
            apiKey: 'env-key',
            baseUrl: 'https://example.com',
            modelName: 'test-model',
            searchApiKey: '',
          },
        },
      };

      const result = createConfig(layers, {
        priority: [ConfigLayer.ENV, ConfigLayer.USER, ConfigLayer.GLOBAL],
      });

      expect(result.config.auth.apiKey).toBe('env-key'); // env 层优先级最高
    });

    it('应该验证配置并返回错误', () => {
      const layers: ConfigLayers = {
        global: {
          auth: {
            apiKey: 12345 as any, // 无效的类型，应该是字符串
            baseUrl: 'https://example.com',
            modelName: 'test-model',
            searchApiKey: '',
          },
        },
      };

      const result = createConfig(layers, { validate: true, throwOnError: false });

      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.config).toBeDefined(); // 应该仍然返回配置
    });

    it('应该在验证失败时抛出错误', () => {
      const layers: ConfigLayers = {
        global: {
          auth: {
            apiKey: 12345 as any, // 无效的类型
            baseUrl: 'https://example.com',
            modelName: 'test-model',
            searchApiKey: '',
          },
        },
      };

      expect(() => {
        createConfig(layers, { validate: true, throwOnError: true });
      }).toThrow();
    });

    it('应该处理配置合并冲突', () => {
      const layers: ConfigLayers = {
        global: {
          ui: { theme: 'light', hideTips: false, hideBanner: false },
        },
        user: {
          ui: { theme: 'dark', hideTips: false, hideBanner: false },
        },
      };

      const result = createConfig(layers);

      // user 层应该覆盖 global 层
      expect(result.config.ui.theme).toBe('dark');
    });

    it('应该确保所有必需字段都有默认值', () => {
      const layers: ConfigLayers = {
        global: {
          auth: {
            apiKey: 'custom-key',
            baseUrl: 'https://example.com',
            modelName: 'test-model',
            searchApiKey: '',
          },
          // 不提供其他字段
        },
      };

      const result = createConfig(layers);

      expect(result.config.auth.apiKey).toBe('custom-key');
      expect(result.config.ui.theme).toBe('GitHub'); // 默认值
      expect(result.config.security.sandbox).toBe('docker'); // 默认值
      expect(result.config.metadata.sources).toContain('global');
    });
  });

  describe('配置验证', () => {
    it('应该验证认证配置', () => {
      const layers: ConfigLayers = {
        global: {
          auth: {
            apiKey: 'valid-key',
            baseUrl: 'invalid-url', // 无效的 URL
            modelName: 'test-model',
            searchApiKey: '',
          },
        },
      };

      const result = createConfig(layers);

      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.some((e) => e.includes('baseUrl'))).toBe(true);
    });

    it('应该验证 UI 配置', () => {
      const layers: ConfigLayers = {
        global: {
          ui: {
            theme: 'invalid-theme', // 无效的主题
            hideTips: false,
            hideBanner: false,
          },
        },
      };

      const result = createConfig(layers);

      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.some((e) => e.includes('theme'))).toBe(true);
    });

    it('应该验证安全配置', () => {
      const layers: ConfigLayers = {
        global: {
          security: {
            sandbox: 'invalid-sandbox', // 无效的沙箱选项
          },
        },
      };

      const result = createConfig(layers);

      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.some((e) => e.includes('sandbox'))).toBe(true);
    });
  });

  describe('错误处理', () => {
    it('应该在配置合并失败时返回默认配置', () => {
      // 创建一个会导致深度合并失败的配置
      const circularReference: any = {};
      circularReference.self = circularReference;

      const layers: ConfigLayers = {
        global: {
          auth: circularReference,
        },
      };

      const result = createConfig(layers, { throwOnError: false });

      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.config).toBeDefined(); // 应该返回默认配置
      expect(result.config.auth.apiKey).toBe(''); // 默认值
    });

    it('应该在严格模式下抛出错误', () => {
      const circularReference: any = {};
      circularReference.self = circularReference;

      const layers: ConfigLayers = {
        global: {
          auth: circularReference,
        },
      };

      expect(() => {
        createConfig(layers, { throwOnError: true });
      }).toThrow();
    });
  });
});
