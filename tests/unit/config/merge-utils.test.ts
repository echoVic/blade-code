import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../../src/config';

// 简单的配置合并工具函数
function mergeConfigsByPriority(configs: Record<string, any>): any {
  const merged = { ...DEFAULT_CONFIG };

  // 按优先级合并：env > project > user > global
  const priority = ['global', 'user', 'project', 'env'];

  for (const layer of priority) {
    if (configs[layer]) {
      Object.assign(merged, configs[layer]);
    }
  }

  return merged;
}

function isEqual(a: any, b: any): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a !== typeof b) return false;

  if (typeof a === 'object') {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);

    if (keysA.length !== keysB.length) return false;

    for (const key of keysA) {
      if (!keysB.includes(key)) return false;
      if (!isEqual(a[key], b[key])) return false;
    }

    return true;
  }

  return false;
}

function getConfigValue(config: any, path: string): any {
  return path.split('.').reduce((obj, key) => obj?.[key], config);
}

function setConfigValue(config: any, path: string, value: any): void {
  const keys = path.split('.');
  const lastKey = keys.pop()!;
  const target = keys.reduce((obj, key) => {
    if (!obj[key]) obj[key] = {};
    return obj[key];
  }, config);
  target[lastKey] = value;
}

function deleteConfigValue(config: any, path: string): boolean {
  const keys = path.split('.');
  const lastKey = keys.pop()!;
  const target = keys.reduce((obj, key) => obj?.[key], config);
  if (target && lastKey in target) {
    delete target[lastKey];
    return true;
  }
  return false;
}

function flattenConfig(config: any, prefix = ''): Record<string, any> {
  const flattened: Record<string, any> = {};

  for (const [key, value] of Object.entries(config)) {
    const newKey = prefix ? `${prefix}.${key}` : key;

    if (value && typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(flattened, flattenConfig(value, newKey));
    } else {
      flattened[newKey] = value;
    }
  }

  return flattened;
}

function unflattenConfig(flatConfig: Record<string, any>): any {
  const config: any = {};

  for (const [key, value] of Object.entries(flatConfig)) {
    const keys = key.split('.');
    let target = config;

    for (let i = 0; i < keys.length - 1; i++) {
      const k = keys[i];
      if (!target[k]) target[k] = {};
      target = target[k];
    }

    target[keys[keys.length - 1]] = value;
  }

  return config;
}

describe('配置合并工具函数', () => {
  describe('mergeConfigsByPriority', () => {
    it('应该按优先级合并配置', () => {
      const configs = {
        global: {
          theme: 'light',
          debug: false,
        },
        user: {
          theme: 'dark',
          apiKey: 'user-key',
        },
      };

      const result = mergeConfigsByPriority(configs);

      expect(result.theme).toBe('dark'); // user 覆盖 global
      expect(result.debug).toBe(false); // 来自 global
      expect(result.apiKey).toBe('user-key'); // 来自 user
    });

    it('应该处理数组合并', () => {
      const configs = {
        global: {
          permissions: {
            allow: ['/global'],
          },
        },
        user: {
          permissions: {
            allow: ['/user'],
          },
        },
      };

      const result = mergeConfigsByPriority(configs);

      expect(result.permissions.allow).toEqual(['/user']); // user 完全覆盖 global
    });

    it('应该检测配置冲突', () => {
      const configs = {
        global: { theme: 'light' },
        user: { theme: 'dark' },
      };

      const result = mergeConfigsByPriority(configs);
      expect(result.theme).toBe('dark'); // user 优先级更高
    });
  });

  describe('isEqual', () => {
    it('应该正确比较基本类型', () => {
      expect(isEqual(1, 1)).toBe(true);
      expect(isEqual('a', 'a')).toBe(true);
      expect(isEqual(true, true)).toBe(true);
      expect(isEqual(1, 2)).toBe(false);
      expect(isEqual('a', 'b')).toBe(false);
    });

    it('应该正确比较对象', () => {
      const obj1 = { a: 1, b: { c: 2 } };
      const obj2 = { a: 1, b: { c: 2 } };
      const obj3 = { a: 1, b: { c: 3 } };

      expect(isEqual(obj1, obj2)).toBe(true);
      expect(isEqual(obj1, obj3)).toBe(false);
    });

    it('应该正确比较数组', () => {
      expect(isEqual([1, 2, 3], [1, 2, 3])).toBe(true);
      expect(isEqual([1, 2, 3], [1, 2, 4])).toBe(false);
    });

    it('应该处理null和undefined', () => {
      expect(isEqual(null, null)).toBe(true);
      expect(isEqual(undefined, undefined)).toBe(true);
      expect(isEqual(null, undefined)).toBe(false);
    });
  });

  describe('配置路径操作', () => {
    it('应该正确获取嵌套配置值', () => {
      const config = {
        auth: {
          apiKey: 'test-key',
          nested: {
            value: 'nested-value',
          },
        },
      };

      expect(getConfigValue(config, 'auth.apiKey')).toBe('test-key');
      expect(getConfigValue(config, 'auth.nested.value')).toBe('nested-value');
      expect(getConfigValue(config, 'auth.nonexistent')).toBeUndefined();
    });

    it('应该正确设置嵌套配置值', () => {
      const config: any = {
        auth: {
          apiKey: 'old-key',
          nested: {
            value: 'old-value',
          },
        },
      };

      setConfigValue(config, 'auth.apiKey', 'new-key');
      setConfigValue(config, 'auth.nested.value', 'nested-value');

      expect(config.auth.apiKey).toBe('new-key');
      expect(config.auth.nested.value).toBe('nested-value');
    });

    it('应该正确删除配置值', () => {
      const config: any = {
        auth: {
          apiKey: 'test-key',
          toDelete: 'delete-me',
        },
      };

      expect(deleteConfigValue(config, 'auth.toDelete')).toBe(true);
      expect(config.auth.toDelete).toBeUndefined();
      expect(deleteConfigValue(config, 'auth.nonexistent')).toBe(false);
    });
  });

  describe('配置扁平化', () => {
    it('应该正确扁平化配置对象', () => {
      const config = {
        auth: {
          apiKey: 'test-key',
          baseUrl: 'https://api.example.com',
        },
        ui: {
          theme: 'dark',
          fontSize: 14,
        },
      };

      const flattened = flattenConfig(config);

      expect(flattened).toEqual({
        'auth.apiKey': 'test-key',
        'auth.baseUrl': 'https://api.example.com',
        'ui.theme': 'dark',
        'ui.fontSize': 14,
      });
    });

    it('应该正确展开扁平化配置', () => {
      const flatConfig = {
        'auth.apiKey': 'test-key',
        'auth.baseUrl': 'https://api.example.com',
        'ui.theme': 'dark',
        'ui.fontSize': 14,
      };

      const unflattened = unflattenConfig(flatConfig);

      expect(unflattened).toEqual({
        auth: {
          apiKey: 'test-key',
          baseUrl: 'https://api.example.com',
        },
        ui: {
          theme: 'dark',
          fontSize: 14,
        },
      });
    });

    it('应该正确处理扁平化和展开的往返转换', () => {
      const original = {
        auth: {
          apiKey: 'test-key',
          nested: {
            value: 'nested-value',
          },
        },
        ui: {
          theme: 'dark',
        },
      };

      const flattened = flattenConfig(original);
      const unflattened = unflattenConfig(flattened);

      expect(isEqual(original, unflattened)).toBe(true);
    });
  });
});
