import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { At } from '../../src/utils/at';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('At - 文件引用系统', () => {
  let tempDir: string;
  let at: At;

  beforeEach(() => {
    // 创建临时测试目录
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blade-at-test-'));
    at = new At({ cwd: tempDir });
  });

  afterEach(() => {
    // 清理临时目录
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('extractAtPaths - 提取 @ 路径', () => {
    it('应该提取简单的文件引用', () => {
      const prompt = '请查看 @src/utils.ts 文件';
      const paths = at.extractAtPaths(prompt);
      expect(paths).toEqual([{ path: 'src/utils.ts' }]);
    });

    it('应该提取带行号范围的文件引用', () => {
      const prompt = '请查看 @src/utils.ts:10-20 这段代码';
      const paths = at.extractAtPaths(prompt);
      expect(paths).toEqual([
        {
          path: 'src/utils.ts',
          lineRange: { start: 10, end: 20 },
        },
      ]);
    });

    it('应该提取单行引用', () => {
      const prompt = '请查看 @src/utils.ts:15 这一行';
      const paths = at.extractAtPaths(prompt);
      expect(paths).toEqual([
        {
          path: 'src/utils.ts',
          lineRange: { start: 15, end: 15 },
        },
      ]);
    });

    it('应该提取多个文件引用', () => {
      const prompt = '请对比 @src/a.ts 和 @src/b.ts:10-20 文件';
      const paths = at.extractAtPaths(prompt);
      expect(paths).toEqual([
        { path: 'src/a.ts' },
        { path: 'src/b.ts', lineRange: { start: 10, end: 20 } },
      ]);
    });

    it('应该处理目录引用', () => {
      const prompt = '请查看 @src/components/ 目录';
      const paths = at.extractAtPaths(prompt);
      expect(paths).toEqual([{ path: 'src/components/' }]);
    });

    it('应该忽略无效的 @ 引用', () => {
      const prompt = 'Email: test@example.com 和 @src/file.ts';
      const paths = at.extractAtPaths(prompt);
      expect(paths).toEqual([{ path: 'src/file.ts' }]);
    });
  });

  describe('getContent - 获取文件内容', () => {
    beforeEach(() => {
      // 创建测试文件
      fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, 'src', 'test.ts'),
        'line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8\nline 9\nline 10\n'
      );
    });

    it('应该读取整个文件', () => {
      const content = at.getContent('@src/test.ts');
      expect(content).toContain('line 1');
      expect(content).toContain('line 10');
    });

    it('应该读取指定行号范围', () => {
      const content = at.getContent('@src/test.ts:3-5');
      expect(content).toContain('line 3');
      expect(content).toContain('line 4');
      expect(content).toContain('line 5');
      expect(content).not.toContain('line 1');
      expect(content).not.toContain('line 10');
    });

    it('应该读取单行', () => {
      const content = at.getContent('@src/test.ts:5');
      expect(content).toContain('line 5');
      expect(content).not.toContain('line 4');
      expect(content).not.toContain('line 6');
    });

    it('应该处理不存在的文件', () => {
      expect(() => at.getContent('@src/nonexistent.ts')).toThrow();
    });

    it('应该处理超出范围的行号', () => {
      const content = at.getContent('@src/test.ts:5-100');
      expect(content).toContain('line 5');
      expect(content).toContain('line 10');
    });
  });

  describe('getContent - 目录处理', () => {
    beforeEach(() => {
      // 创建测试目录结构
      fs.mkdirSync(path.join(tempDir, 'src', 'components'), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(tempDir, 'src', 'components', 'Button.tsx'),
        'export const Button = () => {}'
      );
      fs.writeFileSync(
        path.join(tempDir, 'src', 'components', 'Input.tsx'),
        'export const Input = () => {}'
      );
    });

    it('应该读取目录中的所有文件', () => {
      const content = at.getContent('@src/components/');
      expect(content).toContain('Button.tsx');
      expect(content).toContain('Input.tsx');
      expect(content).toContain('export const Button');
      expect(content).toContain('export const Input');
    });
  });

  describe('replaceAtReferences - 替换 @ 引用', () => {
    beforeEach(() => {
      fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(tempDir, 'src', 'test.ts'), 'line 1\nline 2\nline 3');
    });

    it('应该替换 @ 引用为文件内容', () => {
      const prompt = '请查看 @src/test.ts 并修复问题';
      const result = at.replaceAtReferences(prompt);
      expect(result).toContain('line 1');
      expect(result).toContain('line 2');
      expect(result).toContain('line 3');
      expect(result).toContain('并修复问题');
    });

    it('应该保留原始提示词的其他部分', () => {
      const prompt = '前面的文字 @src/test.ts 后面的文字';
      const result = at.replaceAtReferences(prompt);
      expect(result).toContain('前面的文字');
      expect(result).toContain('后面的文字');
    });
  });

  describe('边界情况', () => {
    it('应该处理空提示词', () => {
      const paths = at.extractAtPaths('');
      expect(paths).toEqual([]);
    });

    it('应该处理没有 @ 引用的提示词', () => {
      const paths = at.extractAtPaths('这是一个普通的提示词');
      expect(paths).toEqual([]);
    });

    it('应该处理大文件', () => {
      const largePath = path.join(tempDir, 'large.txt');
      const lines = Array.from({ length: 10000 }, (_, i) => `line ${i + 1}`);
      fs.writeFileSync(largePath, lines.join('\n'));

      const content = at.getContent('@large.txt:5000-5010');
      expect(content).toContain('line 5000');
      expect(content).toContain('line 5010');
    });
  });
});
