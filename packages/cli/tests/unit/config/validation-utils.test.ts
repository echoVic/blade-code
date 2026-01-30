import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../../src/config';

// 简单的配置验证工具函数
function validateConfig(config: any): {
  valid: boolean;
  errors: string[];
  normalized?: any;
} {
  const errors: string[] = [];

  // 基本验证
  if (config.apiKey && typeof config.apiKey !== 'string') {
    errors.push('apiKey must be a string');
  }

  if (
    config.maxTokens &&
    (typeof config.maxTokens !== 'number' || config.maxTokens < 1)
  ) {
    errors.push('maxTokens must be a positive number');
  }

  if (
    config.temperature &&
    (typeof config.temperature !== 'number' ||
      config.temperature < 0 ||
      config.temperature > 1)
  ) {
    errors.push('temperature must be between 0 and 1');
  }

  return {
    valid: errors.length === 0,
    errors,
    normalized: errors.length === 0 ? { ...DEFAULT_CONFIG, ...config } : undefined,
  };
}

function safeParseConfigValue(value: string): any {
  // 尝试解析数字
  if (!isNaN(Number(value))) {
    return Number(value);
  }

  // 尝试解析布尔值
  if (value.toLowerCase() === 'true') return true;
  if (value.toLowerCase() === 'false') return false;

  // 尝试解析JSON
  try {
    return JSON.parse(value);
  } catch {
    // 返回原始字符串
    return value;
  }
}

function validateConfigPath(path: string): boolean {
  if (!path || typeof path !== 'string') return false;
  if (path.startsWith('.') || path.endsWith('.')) return false;
  if (path.includes('..')) return false;
  return true;
}

function validateConfigValue(
  path: string,
  value: any
): { valid: boolean; errors: string[]; suggestions?: string[] } {
  const errors: string[] = [];
  const suggestions: string[] = [];

  // 验证超时值
  if (path.includes('timeout') && (typeof value !== 'number' || value < 1000)) {
    errors.push(`${path}: 值太小，最小值 1000`);
  }

  // 验证字符串长度
  if (typeof value === 'string' && value.length > 1000) {
    suggestions.push(`${path}: 字符串长度较大，考虑优化`);
  }

  return {
    valid: errors.length === 0,
    errors,
    suggestions: suggestions.length > 0 ? suggestions : undefined,
  };
}

function validateConfigFormat(
  content: string,
  format: 'json'
): { valid: boolean; parsed?: any; error?: string } {
  if (format === 'json') {
    try {
      const parsed = JSON.parse(content);
      return { valid: true, parsed };
    } catch (error) {
      return { valid: false, error: (error as Error).message };
    }
  }

  return { valid: false, error: 'Unsupported format' };
}

function validateEnvironmentVariables(): { valid: boolean; warnings?: string[] } {
  const warnings: string[] = [];

  // 检查必需的环境变量
  if (!process.env.BLADE_API_KEY) {
    warnings.push('缺少必需的环境变量: BLADE_API_KEY');
  }

  return {
    valid: warnings.length === 0,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

function validateConfigPermissions(config: any): {
  valid: boolean;
  privacyWarnings?: string[];
  securityWarnings?: string[];
} {
  const privacyWarnings: string[] = [];
  const securityWarnings: string[] = [];

  // 检查敏感信息
  if (config.apiKey && config.apiKey.includes('sk-')) {
    privacyWarnings.push('配置中包含API密钥，请确保安全性');
  }

  if (config.baseUrl && config.baseUrl.startsWith('http://')) {
    securityWarnings.push('基础 URL 应使用 HTTPS 协议');
  }

  return {
    valid: privacyWarnings.length === 0 && securityWarnings.length === 0,
    privacyWarnings: privacyWarnings.length > 0 ? privacyWarnings : undefined,
    securityWarnings: securityWarnings.length > 0 ? securityWarnings : undefined,
  };
}

describe('配置验证工具函数', () => {
  describe('validateConfig', () => {
    it('应该验证有效的配置', () => {
      const validConfig = {
        ...DEFAULT_CONFIG,
        apiKey: 'test-key',
        maxTokens: 4000,
        temperature: 0.7,
      };

      const result = validateConfig(validConfig);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('应该检测无效的配置', () => {
      const invalidConfig = {
        ...DEFAULT_CONFIG,
        apiKey: 123, // 无效类型
        maxTokens: -1, // 无效值
        temperature: 2.0, // 超出范围
      };

      const result = validateConfig(invalidConfig);
      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(3);
    });

    it('应该返回标准化的配置', () => {
      const config = {
        apiKey: 'test-key',
        theme: 'dark',
      };

      const result = validateConfig(config);
      expect(result.valid).toBe(true);
      expect(result.normalized).toBeDefined();
      expect(result.normalized?.apiKey).toBe('test-key');
      expect(result.normalized?.theme).toBe('dark');
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
      expect(safeParseConfigValue('FALSE')).toBe(false);
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
      expect(validateConfigPath('path..with..dots')).toBe(false);
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
      // 设置测试环境变量
      const originalApiKey = process.env.BLADE_API_KEY;
      process.env.BLADE_API_KEY = 'test-key';

      const result = validateEnvironmentVariables();
      expect(result.valid).toBe(true);

      // 恢复环境变量
      if (originalApiKey) {
        process.env.BLADE_API_KEY = originalApiKey;
      } else {
        delete process.env.BLADE_API_KEY;
      }
    });

    it('应该为缺失的必需环境变量提供警告', () => {
      const originalApiKey = process.env.BLADE_API_KEY;
      delete process.env.BLADE_API_KEY;

      const result = validateEnvironmentVariables();
      expect(result.warnings).toContain('缺少必需的环境变量: BLADE_API_KEY');

      // 恢复环境变量
      if (originalApiKey) {
        process.env.BLADE_API_KEY = originalApiKey;
      }
    });
  });

  describe('validateConfigPermissions', () => {
    it('应该检测敏感信息', () => {
      const configWithSensitiveData = {
        apiKey: 'sk-1234567890abcdef',
        baseUrl: 'https://api.example.com',
      };

      const result = validateConfigPermissions(configWithSensitiveData);
      expect(result.privacyWarnings).toHaveLength(1);
      expect(result.privacyWarnings).toContain('配置中包含API密钥，请确保安全性');
    });

    it('应该检查网络安全性', () => {
      const insecureConfig = {
        baseUrl: 'http://api.example.com',
      };

      const result = validateConfigPermissions(insecureConfig);
      expect(result.securityWarnings).toContain('基础 URL 应使用 HTTPS 协议');
    });

    it('应该验证安全配置', () => {
      const secureConfig = {
        apiKey: 'test-key',
        baseUrl: 'https://api.example.com',
      };

      const result = validateConfigPermissions(secureConfig);
      expect(result.valid).toBe(true);
    });
  });
});
