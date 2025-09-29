import { describe, it, expect } from 'vitest';
import { SystemPrompt } from '../../../src/prompts/SystemPrompt.js';
import { DEFAULT_SYSTEM_PROMPT } from '../../../src/prompts/default.js';

describe('PromptBuilder (Simplified)', () => {
  describe('基础功能测试', () => {
    it('应该能创建包含默认提示的 SystemPrompt', () => {
      const systemPrompt = new SystemPrompt();

      const result = systemPrompt.build();
      expect(result).toContain('Blade AI');
      expect(result).toContain('命令行智能编码助手');
    });

    it('应该能添加 CLI 提示', () => {
      const cliPrompt = '这是 CLI 提示';
      const systemPrompt = new SystemPrompt();

      systemPrompt.addSource({
        type: 'cli',
        content: cliPrompt,
        priority: 10
      });

      const result = systemPrompt.build();
      expect(result).toContain(DEFAULT_SYSTEM_PROMPT);
      expect(result).toContain(cliPrompt);
    });

    it('应该按优先级排序（CLI > 项目 > 用户 > 默认）', () => {
      const cliPrompt = 'CLI提示';
      const systemPrompt = new SystemPrompt();

      // 手动添加不同优先级的源来测试排序
      systemPrompt.addSource({
        type: 'default',
        content: '默认提示',
        priority: 0
      });

      systemPrompt.addSource({
        type: 'file',
        content: '用户提示',
        priority: 5,
        source: 'user'
      });

      systemPrompt.addSource({
        type: 'file',
        content: '项目提示',
        priority: 7,
        source: 'project'
      });

      systemPrompt.addSource({
        type: 'cli',
        content: cliPrompt,
        priority: 10
      });

      const result = systemPrompt.build();

      // 检查优先级顺序
      const cliIndex = result.indexOf('CLI提示');
      const projectIndex = result.indexOf('项目提示');
      const userIndex = result.indexOf('用户提示');
      const defaultIndex = result.indexOf('默认提示');

      expect(cliIndex).toBeLessThan(projectIndex);
      expect(projectIndex).toBeLessThan(userIndex);
      expect(userIndex).toBeLessThan(defaultIndex);
    });

    it('应该能处理空内容', () => {
      const systemPrompt = new SystemPrompt();

      systemPrompt.addSource({
        type: 'cli',
        content: '',
        priority: 10
      });

      const result = systemPrompt.build();
      expect(result).toContain(DEFAULT_SYSTEM_PROMPT);
    });

    it('应该能合并多个源', () => {
      const systemPrompt = new SystemPrompt();

      systemPrompt.addSource({
        type: 'cli',
        content: '第一部分',
        priority: 10
      });

      systemPrompt.addSource({
        type: 'file',
        content: '第二部分',
        priority: 5,
        source: 'test'
      });

      const result = systemPrompt.build();
      expect(result).toContain('第一部分');
      expect(result).toContain('第二部分');
      expect(result).toContain(DEFAULT_SYSTEM_PROMPT);

      // 检查顺序
      expect(result.indexOf('第一部分')).toBeLessThan(result.indexOf('第二部分'));
    });
  });

  describe('错误处理', () => {
    it('应该处理无效的优先级', () => {
      const systemPrompt = new SystemPrompt();

      systemPrompt.addSource({
        type: 'cli',
        content: '测试内容',
        priority: -1
      });

      const result = systemPrompt.build();
      expect(result).toContain('测试内容');
      expect(result).toContain(DEFAULT_SYSTEM_PROMPT);
    });

    it('应该处理相同优先级的多个源', () => {
      const systemPrompt = new SystemPrompt();

      systemPrompt.addSource({
        type: 'cli',
        content: '第一个',
        priority: 5
      });

      systemPrompt.addSource({
        type: 'cli',
        content: '第二个',
        priority: 5
      });

      const result = systemPrompt.build();
      expect(result).toContain('第一个');
      expect(result).toContain('第二个');
    });
  });
});