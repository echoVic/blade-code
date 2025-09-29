import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { SystemPrompt } from '../../../src/prompts/SystemPrompt.js';
import { DEFAULT_SYSTEM_PROMPT } from '../../../src/prompts/default.js';

describe('SystemPrompt', () => {
  const testDir = join(process.cwd(), 'test-temp');
  const testConfigPath = join(testDir, 'BLADE.md');

  beforeEach(() => {
    // 创建测试目录
    if (!existsSync(testDir)) {
      mkdirSync(testDir, { recursive: true });
    }
  });

  afterEach(() => {
    // 清理测试目录
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('基础功能', () => {
    it('应该能创建默认的 SystemPrompt 实例', () => {
      const systemPrompt = new SystemPrompt();
      expect(systemPrompt).toBeInstanceOf(SystemPrompt);
    });

    it('应该能构建默认的系统提示', () => {
      const systemPrompt = new SystemPrompt();
      systemPrompt.addSource({
        type: 'default',
        content: DEFAULT_SYSTEM_PROMPT,
        priority: 1,
        source: 'default'
      });

      const result = systemPrompt.build();
      expect(result).toContain('Blade AI');
      expect(result).toContain('命令行智能编码助手');
    });
  });

  describe('文件加载功能', () => {
    it('应该能通过 addSource 手动添加文件内容', () => {
      const customPrompt = '这是一个自定义的系统提示';

      const systemPrompt = new SystemPrompt();
      systemPrompt.addSource({
        type: 'file',
        content: customPrompt,
        priority: 5,
        source: 'test-file'
      });

      expect(systemPrompt.build()).toContain(customPrompt);
    });

    it('应该能处理不存在的文件', async () => {
      const systemPrompt = new SystemPrompt();
      const loaded = await systemPrompt.loadFromFile('/non/existent/file.md', 5);

      expect(loaded).toBe(false);
    });
  });

  describe('优先级处理', () => {
    it('应该按优先级排序提示源', () => {
      const systemPrompt = new SystemPrompt();

      systemPrompt.addSource({
        type: 'cli',
        content: '低优先级',
        priority: 1,
        source: 'low'
      });

      systemPrompt.addSource({
        type: 'cli',
        content: '高优先级',
        priority: 10,
        source: 'high'
      });

      const result = systemPrompt.build();
      // 检查高优先级在前面
      expect(result.indexOf('高优先级')).toBeLessThan(result.indexOf('低优先级'));
      expect(result).toContain('高优先级');
      expect(result).toContain('低优先级');
    });

    it('应该支持相同优先级的多个源', () => {
      const systemPrompt = new SystemPrompt();

      systemPrompt.addSource({
        type: 'cli',
        content: '第一个',
        priority: 5,
        source: 'first'
      });

      systemPrompt.addSource({
        type: 'cli',
        content: '第二个',
        priority: 5,
        source: 'second'
      });

      const result = systemPrompt.build();
      expect(result).toContain('第一个');
      expect(result).toContain('第二个');
    });
  });

  describe('静态工厂方法', () => {
    it('应该能创建基础 SystemPrompt', () => {
      const systemPrompt = new SystemPrompt();

      // 手动添加 CLI 提示来模拟 fromSources 的行为
      systemPrompt.addSource({
        type: 'cli',
        content: 'CLI 提示',
        priority: 10
      });

      const result = systemPrompt.build();
      expect(result).toContain(DEFAULT_SYSTEM_PROMPT);
      expect(result).toContain('CLI 提示');
    });
  });

  describe('边界情况', () => {
    it('应该处理空的系统提示', () => {
      const systemPrompt = new SystemPrompt();
      systemPrompt.addSource({
        type: 'cli',
        content: '',
        priority: 1,
        source: 'empty'
      });

      const result = systemPrompt.build();
      // 空内容不会被添加，结果应该包含默认提示
      expect(result).toContain(DEFAULT_SYSTEM_PROMPT);
    });

    it('应该处理只有空格的系统提示', () => {
      const systemPrompt = new SystemPrompt();
      systemPrompt.addSource({
        type: 'cli',
        content: '   \n\t  ',
        priority: 1,
        source: 'whitespace'
      });

      const result = systemPrompt.build();
      // 只有空格的内容也应该包含默认提示
      expect(result).toContain(DEFAULT_SYSTEM_PROMPT);
    });

    it('应该正确合并多行内容', () => {
      const systemPrompt = new SystemPrompt();

      systemPrompt.addSource({
        type: 'cli',
        content: '第一行\n第二行',
        priority: 1,
        source: 'multiline1'
      });

      systemPrompt.addSource({
        type: 'cli',
        content: '第三行\n第四行',
        priority: 2,
        source: 'multiline2'
      });

      const result = systemPrompt.build();
      // 检查优先级顺序
      expect(result.indexOf('第三行')).toBeLessThan(result.indexOf('第一行'));
      expect(result).toContain('第一行\n第二行');
      expect(result).toContain('第三行\n第四行');
    });
  });
});