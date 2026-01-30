/**
 * pathHelpers 工具函数测试
 */

import { describe, expect, it } from 'vitest';
import { endsWithSeparator, splitPath } from '../../../src/utils/pathHelpers.js';

describe('pathHelpers', () => {
  describe('endsWithSeparator', () => {
    it('应该返回 true 对于 Unix 风格路径', () => {
      expect(endsWithSeparator('/Users/john/')).toBe(true);
      expect(endsWithSeparator('/home/user/docs/')).toBe(true);
      expect(endsWithSeparator('/')).toBe(true);
    });

    it('应该返回 true 对于 Windows 风格路径', () => {
      expect(endsWithSeparator('C:\\Users\\HP\\')).toBe(true);
      expect(endsWithSeparator('D:\\Projects\\blade-code\\')).toBe(true);
      expect(endsWithSeparator('C:\\')).toBe(true);
    });

    it('应该返回 false 对于没有分隔符的路径', () => {
      expect(endsWithSeparator('/Users/john')).toBe(false);
      expect(endsWithSeparator('file.txt')).toBe(false);
      expect(endsWithSeparator('C:\\Users\\HP')).toBe(false);
    });

    it('应该返回 false 对于空字符串', () => {
      expect(endsWithSeparator('')).toBe(false);
    });
  });

  describe('splitPath', () => {
    it('应该正确分割 Unix 风格路径', () => {
      expect(splitPath('/Users/john/file.txt')).toEqual(['Users', 'john', 'file.txt']);
      expect(splitPath('/home/user/docs/project')).toEqual(['home', 'user', 'docs', 'project']);
      expect(splitPath('/')).toEqual([]);
    });

    it('应该正确分割 Windows 风格路径', () => {
      expect(splitPath('C:\\Users\\HP\\file.txt')).toEqual(['C:', 'Users', 'HP', 'file.txt']);
      expect(splitPath('D:\\Projects\\blade-code\\src')).toEqual(['D:', 'Projects', 'blade-code', 'src']);
    });

    it('应该处理混合分隔符', () => {
      expect(splitPath('C:\\Users/john\\file.txt')).toEqual(['C:', 'Users', 'john', 'file.txt']);
      expect(splitPath('/Users\\john\\file.txt')).toEqual(['Users', 'john', 'file.txt']);
    });

    it('应该处理相对路径', () => {
      expect(splitPath('./src/utils')).toEqual(['.', 'src', 'utils']);
      expect(splitPath('../project')).toEqual(['..', 'project']);
    });

    it('应该处理空路径和空字符串', () => {
      expect(splitPath('')).toEqual([]);
      expect(splitPath('file.txt')).toEqual(['file.txt']);
    });

    it('应该过滤掉空的部分', () => {
      expect(splitPath('/Users//john///file.txt')).toEqual(['Users', 'john', 'file.txt']);
    });
  });
});
