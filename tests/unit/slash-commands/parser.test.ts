/**
 * Slash Commands 解析逻辑测试
 */

import { describe, expect, it, vi } from 'vitest';
import {
  isSlashCommand,
  parseSlashCommand,
} from '../../../src/slash-commands/index.js';

describe('Slash Commands 解析', () => {
  describe('isSlashCommand', () => {
    it('应该识别以 / 开头的命令', () => {
      expect(isSlashCommand('/help')).toBe(true);
      expect(isSlashCommand('/git status')).toBe(true);
      expect(isSlashCommand('  /trim  ')).toBe(true);
    });

    it('不应该识别非命令输入', () => {
      expect(isSlashCommand('hello')).toBe(false);
      expect(isSlashCommand('//comment')).toBe(true); // 暂时也被视为命令，由 handler 处理
      expect(isSlashCommand('')).toBe(false);
    });
  });

  describe('parseSlashCommand', () => {
    it('应该正确解析命令和参数', () => {
      const { command, args } = parseSlashCommand('/git status -v');
      expect(command).toBe('git');
      expect(args).toEqual(['status', '-v']);
    });

    it('应该处理无参数命令', () => {
      const { command, args } = parseSlashCommand('/help');
      expect(command).toBe('help');
      expect(args).toEqual([]);
    });

    it('应该处理多余空格', () => {
      const { command, args } = parseSlashCommand('  /cmd   arg1   arg2  ');
      expect(command).toBe('cmd');
      expect(args).toEqual(['arg1', 'arg2']);
    });

    it('非 slash command 应该抛出错误', () => {
      expect(() => parseSlashCommand('hello')).toThrow();
    });
  });
});
