/**
 * 配置合并工具函数测试
 */

import { describe, it, expect } from 'vitest';
import { 
  deepMerge, 
  mergeConfigsByPriority, 
  isEqual, 
  getConfigValue, 
  setConfigValue, 
  deleteConfigValue,
  flattenConfig,
  unflattenConfig
} from '../../utils/merge-utils.js';
import { ConfigLayer } from '../../types/index.js';

describe('配置合并工具函数', () => {
  describe('deepMerge', () => {
    it('应该正确深度合并两个对象', () => {
      const target = {
        a: 1,
        b: {
          c: 2,
          d: [1, 2],
        },
      };

      const source = {
        b: {
          c: 3,
          e: 4,
        },
        f: 5,
      };

      const result = deepMerge(target, source);
      
      expect(result).toEqual({
        a: 1,
        b: {
          c: 3,
          d: [1, 2],
          e: 4,
        },
        f: 5,
      });
    });

    it('应该处理空对象', () => {
      const result = deepMerge({}, { a: 1 });
      expect(result).toEqual({ a: 1 });
    });

    it('应该保持原始对象不变', () => {
      const target = { a: 1 };
      const source = { b: 2 };
      
      const result = deepMerge(target, source);
      
      expect(target).toEqual({ a: 1 });
      expect(source).toEqual({ b: 2 });
      expect(result).toEqual({ a: 1, b: 2 });
    });
  });

  describe('mergeConfigsByPriority', () => {
    it('应该按优先级合并配置', () => {
      const configs = {
        [ConfigLayer.GLOBAL]: {
          theme: 'light',
          debug: false,
        },
        [ConfigLayer.USER]: {
          theme: 'dark',
          apiKey: 'user-key',
        },
        [ConfigLayer.ENV]: {
          debug: true,
        },
        [ConfigLayer.PROJECT]: {
          projectSpecific: true,
        },
      };

      const result = mergeConfigsByPriority(configs);
      
      expect(result.merged).toEqual({
        theme: 'dark', // USER优先级高于GLOBAL
        debug: true,   // ENV优先级最高
        apiKey: 'user-key',
        projectSpecific: true,
      });
    });

    it('应该处理数组合并', () => {
      const configs = {
        [ConfigLayer.GLOBAL]: {
          trustedFolders: ['/global'],
        },
        [ConfigLayer.USER]: {
          trustedFolders: ['/user'],
        },
      };

      const result1 = mergeConfigsByPriority(configs, { overrideArrays: true });
      expect(result1.merged.trustedFolders).toEqual(['/user']);

      const result2 = mergeConfigsByPriority(configs, { mergeArrays: true });
      expect(result2.merged.trustedFolders).toEqual(['/global', '/user']);
    });

    it('应该检测配置冲突', () => {
      const configs = {
        [ConfigLayer.GLOBAL]: { theme: 'light' },
        [ConfigLayer.USER]: { theme: 'dark' },
      };

      const result = mergeConfigsByPriority(configs);
      
      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0].path).toBe('theme');
      expect(result.conflicts[0].sources).toEqual(['target', 'source-user']);
    });
  });

  describe('isEqual', () => {
    it('应该正确比较基本类型', () => {
      expect(isEqual(1, 1)).toBe(true);
      expect(isEqual('a', 'a')).toBe(true);
      expect(isEqual(true, true)).toBe(true);
      expect(isEqual(1, 2)).toBe(false);
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
          existing: 'value',
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
          toDelete: 'value',
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
          nested: {
            value: 'nested-value',
          },
        },
        ui: {
          theme: 'dark',
        },
      };

      const flattened = flattenConfig(config);
      
      expect(flattened).toEqual({
        'auth.apiKey': 'test-key',
        'auth.nested.value': 'nested-value',
        'ui.theme': 'dark',
      });
    });

    it('应该正确展开扁平化配置', () => {
      const flatConfig = {
        'auth.apiKey': 'test-key',
        'auth.nested.value': 'nested-value',
        'ui.theme': 'dark',
      };

      const unflattened = unflattenConfig(flatConfig);
      
      expect(unflattened).toEqual({
        auth: {
          apiKey: 'test-key',
          nested: {
            value: 'nested-value',
          },
        },
        ui: {
          theme: 'dark',
        },
      });
    });

    it('应该正确处理扁平化和展开的往返转换', () => {
      const original = {
        auth: {
          apiKey: 'test-key',
          nested: {
            value: 'nested-value',
            array: [1, 2, 3],
          },
        },
        ui: {
          theme: 'dark',
        },
      };

      const flattened = flattenConfig(original);
      const unflattened = unflattenConfig(flattened);
      
      expect(unflattened).toEqual(original);
    });
  });
});