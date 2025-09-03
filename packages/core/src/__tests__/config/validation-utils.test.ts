/**
 * 配置验证工具函数测试
 */

import { describe, it, expect } from 'vitest';
import { 
  validateConfig, 
  safeParseConfigValue, 
  validateConfigPath, 
  validateConfigValue,
  validateEnvironmentVariables,
  validateConfigFormat,
  validateConfigPermissions
} from '../../utils/validation-utils.js';
import { BladeUnifiedConfigSchema } from '../../types/schemas.js';

describe('配置验证工具函数', () => {
  describe('validateConfig', () => {
    it('应该验证有效的配置', () => {
      const validConfig = {
        auth: {
          apiKey: 'test-key',
          baseUrl: 'https://api.test.com',
          modelName: 'test-model',
        },
        ui: {
          theme: 'dark',
        },
        security: {
          sandbox: 'docker',
        },
        tools: {},
        mcp: {},
        telemetry: {},
        usage: {},
        debug: {},
        extensions: {},
        metadata: {
          sources: [],
          loadedAt: new Date().toISOString(),
        },
      };

      const result = validateConfig(validConfig);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('应该检测无效的配置', () => {
      const invalidConfig: any = {
        auth: {
          baseUrl: 'invalid-url', // 无效的URL
        },
        ui: {
          theme: 'invalid-theme', // 无效的主题值
        },
      };

      const result = validateConfig(invalidConfig);
      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(2);
    });

    it('应该返回标准化的配置', () => {
      const config = {
        auth: {
          apiKey: 'test-key',
          baseUrl: 'https://api.test.com',
          modelName: 'test-model',
        },
        // 缺少其他必需字段，但应该被自动填充默认值
      };

      const result = validateConfig(config);
      expect(result.valid).toBe(true);
      expect(result.normalized).toBeDefined();
    });
  });

  describe('safeParseConfigValue', () => {
    it('应该正确解析数字值', () => {
      expect(safeParseConfigValue('123')).toBe(123);
      expect(safeParseConfigValue('123.45')).toBe(123.45);
    });

    it('应该正确解析布尔值', () => {
      expect(safeParseConfigValue('true')).toBe(true);
      expect(safeParseConfigValue('false')).toBe(false);
      expect(safeParseConfigValue('TRUE')).toBe(true);
      expect(safeParseConfigValue('1')).toBe(true);
      expect(safeParseConfigValue('0')).toBe(false);
    });

    it('应该正确解析JSON对象', () => {
      const jsonStr = '{"key": "value"}';
      const result = safeParseConfigValue(jsonStr);
      expect(result).toEqual({ key: 'value' });
    });

    it('应该正确解析数组', () => {
      const arrayStr = '[1, 2, 3]';
      const result = safeParseConfigValue(arrayStr);
      expect(result).toEqual([1, 2, 3]);
    });

    it('应该返回原始字符串对于无法解析的值', () => {
      const invalidJson = '{invalid: json}';
      const result = safeParseConfigValue(invalidJson);
      expect(result).toBe(invalidJson);
    });
  });

  describe('validateConfigPath', () => {
    it('应该验证有效的配置路径', () => {
      expect(validateConfigPath('auth.apiKey')).toBe(true);
      expect(validateConfigPath('ui.theme')).toBe(true);
      expect(validateConfigPath('nested.config.value')).toBe(true);
    });

    it('应该拒绝无效的配置路径', () => {
      expect(validateConfigPath('')).toBe(false);
      expect(validateConfigPath('.invalid')).toBe(false);
      expect(validateConfigPath('invalid.')).toBe(false);
      expect(validateConfigPath('123invalid')).toBe(false);
    });
  });

  describe('validateConfigValue', () => {
    it('应该验证配置值', () => {
      const result = validateConfigValue('auth.timeout', 30000);
      expect(result.valid).toBe(true);
    });

    it('应该检测无效的配置值', () => {
      const result = validateConfigValue('auth.timeout', -1);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('auth.timeout: 值太小，最小值 1000');
    });

    it('应该为大值提供警告', () => {
      const longString = 'a'.repeat(1001);
      const result = validateConfigValue('test.value', longString);
      expect(result.suggestions).toContain('test.value: 字符串长度较大，考虑优化');
    });
  });

  describe('validateConfigFormat', () => {
    it('应该验证有效的JSON格式', () => {
      const jsonContent = '{"key": "value"}';
      const result = validateConfigFormat(jsonContent, 'json');
      expect(result.valid).toBe(true);
      expect(result.parsed).toEqual({ key: 'value' });
    });

    it('应该拒绝无效的JSON格式', () => {
      const invalidJson = '{invalid: json}';
      const result = validateConfigFormat(invalidJson, 'json');
      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('应该拒绝不支持的格式', () => {
      const result = validateConfigFormat('content', 'yaml' as any);
      expect(result.valid).toBe(false);
    });
  });

  describe('validateEnvironmentVariables', () => {
    it('应该验证环境变量', () => {
      // 保存原始环境变量
      const originalEnv = process.env;
      
      // 设置测试环境变量
      process.env = {
        ...originalEnv,
        BLADE_API_KEY: 'test-key',
        BLADE_BASE_URL: 'https://api.test.com',
      };
      
      const result = validateEnvironmentVariables();
      expect(result.valid).toBe(true);
      
      // 恢复原始环境变量
      process.env = originalEnv;
    });

    it('应该为缺失的必需环境变量提供警告', () => {
      // 保存原始环境变量
      const originalEnv = process.env;
      
      // 清除API密钥
      process.env = {
        ...originalEnv,
        BLADE_API_KEY: undefined,
      };
      
      const result = validateEnvironmentVariables();
      expect(result.warnings).toContain('缺少必需的环境变量: BLADE_API_KEY');
      
      // 恢复原始环境变量
      process.env = originalEnv;
    });
  });

  describe('validateConfigPermissions', () => {
    it('应该检测敏感信息', () => {
      const configWithSensitiveData = {
        auth: {
          apiKey: 'secret-api-key',
          password: 'secret-password',
        },
        ui: {
          theme: 'dark',
        },
      };

      const result = validateConfigPermissions(configWithSensitiveData);
      expect(result.privacyWarnings).toHaveLength(2);
      expect(result.privacyWarnings).toContain('配置中包含敏感信息字段: auth.apiKey, auth.password');
    });

    it('应该检查网络安全性', () => {
      const insecureConfig = {
        auth: {
          baseUrl: 'http://insecure-api.com', // 不安全的HTTP
        },
      };

      const result = validateConfigPermissions(insecureConfig);
      expect(result.securityWarnings).toContain('基础 URL 应使用 HTTPS 协议');
    });

    it('应该验证安全配置', () => {
      const secureConfig = {
        auth: {
          apiKey: '',
          baseUrl: 'https://secure-api.com',
        },
        ui: {
          theme: 'dark',
        },
      };

      const result = validateConfigPermissions(secureConfig);
      expect(result.valid).toBe(true);
      expect(result.securityWarnings).toHaveLength(0);
    });
  });
});