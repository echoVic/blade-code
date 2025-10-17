/**
 * PatternAbstractor 单元测试
 * 测试各种工具类型的模式抽象逻辑
 */

import { describe, expect, it } from 'vitest';
import { PatternAbstractor } from '../../src/config/PatternAbstractor.js';
import type { ToolInvocationDescriptor } from '../../src/config/PermissionChecker.js';

describe('PatternAbstractor', () => {
  describe('Bash 命令抽象', () => {
    it('应该将安全命令抽象为 Bash(command:*)', () => {
      const descriptor: ToolInvocationDescriptor = {
        toolName: 'Bash',
        params: { command: 'cd /some/path' },
        affectedPaths: [],
      };

      const pattern = PatternAbstractor.abstract(descriptor);
      expect(pattern).toBe('Bash(command:*)');
    });

    it('应该将 npm 相关命令抽象为 Bash(command:*npm*)', () => {
      const testCases = [
        'npm run test',
        'npm install',
        'pnpm add lodash',
        'yarn build',
      ];

      for (const command of testCases) {
        const descriptor: ToolInvocationDescriptor = {
          toolName: 'Bash',
          params: { command },
          affectedPaths: [],
        };

        const pattern = PatternAbstractor.abstract(descriptor);
        expect(pattern).toBe('Bash(command:*npm*)');
      }
    });

    it('应该将 git 命令抽象为 Bash(command:git <subcommand>*)', () => {
      const testCases = [
        { command: 'git status', expected: 'Bash(command:git status*)' },
        { command: 'git add .', expected: 'Bash(command:git add*)' },
        { command: 'git commit -m "fix"', expected: 'Bash(command:git commit*)' },
        { command: 'git push origin main', expected: 'Bash(command:git push*)' },
      ];

      for (const { command, expected } of testCases) {
        const descriptor: ToolInvocationDescriptor = {
          toolName: 'Bash',
          params: { command },
          affectedPaths: [],
        };

        const pattern = PatternAbstractor.abstract(descriptor);
        expect(pattern).toBe(expected);
      }
    });

    it('应该将包含 test/build/lint 的命令抽象为正确的模式', () => {
      const testCases = [
        { command: 'npm test', expected: 'Bash(command:*npm*)' },
        { command: 'npm run build', expected: 'Bash(command:*npm*)' },
        { command: 'eslint src/', expected: 'Bash(command:*)' },
        { command: 'vitest', expected: 'Bash(command:*)' },
      ];

      for (const { command, expected } of testCases) {
        const descriptor: ToolInvocationDescriptor = {
          toolName: 'Bash',
          params: { command },
          affectedPaths: [],
        };

        const pattern = PatternAbstractor.abstract(descriptor);
        expect(pattern).toBe(expected);
      }
    });

    it('应该将其他命令抽象为 Bash(command:<mainCommand>*)', () => {
      const descriptor: ToolInvocationDescriptor = {
        toolName: 'Bash',
        params: { command: 'echo Hello World' },
        affectedPaths: [],
      };

      const pattern = PatternAbstractor.abstract(descriptor);
      expect(pattern).toBe('Bash(command:echo*)');
    });
  });

  describe('文件操作抽象', () => {
    it('应该根据扩展名抽象文件路径', () => {
      const testCases = [
        {
          toolName: 'Read',
          filePath: '/project/src/index.ts',
          expected: 'Read(file_path:**/*.ts)',
        },
        {
          toolName: 'Edit',
          filePath: '/project/src/components/App.tsx',
          expected: 'Edit(file_path:**/*.tsx)',
        },
        {
          toolName: 'Write',
          filePath: '/project/config.json',
          expected: 'Write(file_path:**/*.json)',
        },
      ];

      for (const { toolName, filePath, expected } of testCases) {
        const descriptor: ToolInvocationDescriptor = {
          toolName,
          params: { file_path: filePath },
          affectedPaths: [],
        };

        const pattern = PatternAbstractor.abstract(descriptor);
        expect(pattern).toBe(expected);
      }
    });

    it('应该将源码目录下的无扩展名文件抽象为 Tool(file_path:**)', () => {
      const descriptor: ToolInvocationDescriptor = {
        toolName: 'Read',
        params: { file_path: '/project/src/Makefile' },
        affectedPaths: [],
      };

      const pattern = PatternAbstractor.abstract(descriptor);
      expect(pattern).toBe('Read(file_path:**)');
    });

    // 注意：此测试在 vitest 环境中因 path mock 而跳过
    // 实际运行时会调用 path.relative() 生成相对路径模式
    it.skip('应该将其他目录下的文件抽象为同目录模式', () => {
      const descriptor: ToolInvocationDescriptor = {
        toolName: 'Read',
        params: { file_path: '/other/README' },
        affectedPaths: [],
      };

      const pattern = PatternAbstractor.abstract(descriptor);
      // 无扩展名的非源码目录文件
      expect(pattern).toMatch(/^Read\(file_path:.+\)$/);
    });
  });

  describe('Grep 搜索抽象', () => {
    it('应该保留 type 参数', () => {
      const descriptor: ToolInvocationDescriptor = {
        toolName: 'Grep',
        params: { pattern: 'import', type: 'ts' },
        affectedPaths: [],
      };

      const pattern = PatternAbstractor.abstract(descriptor);
      expect(pattern).toBe('Grep(pattern:*, type:ts)');
    });

    it('应该保留 glob 参数', () => {
      const descriptor: ToolInvocationDescriptor = {
        toolName: 'Grep',
        params: { pattern: 'TODO', glob: '*.ts' },
        affectedPaths: [],
      };

      const pattern = PatternAbstractor.abstract(descriptor);
      expect(pattern).toBe('Grep(pattern:*, glob:*.ts)');
    });

    it('应该根据路径扩展名抽象', () => {
      const descriptor: ToolInvocationDescriptor = {
        toolName: 'Grep',
        params: { pattern: 'export', path: '/project/src/index.ts' },
        affectedPaths: [],
      };

      const pattern = PatternAbstractor.abstract(descriptor);
      expect(pattern).toBe('Grep(pattern:*, path:**/*.ts)');
    });

    it('应该默认允许所有 Grep', () => {
      const descriptor: ToolInvocationDescriptor = {
        toolName: 'Grep',
        params: { pattern: 'function' },
        affectedPaths: [],
      };

      const pattern = PatternAbstractor.abstract(descriptor);
      expect(pattern).toBe('Grep(pattern:*)');
    });
  });

  describe('Glob 搜索抽象', () => {
    it('应该提取并保留扩展名模式', () => {
      const testCases = [
        { pattern: '*.ts', expected: 'Glob(pattern:**/*.ts)' },
        { pattern: 'src/**/*.tsx', expected: 'Glob(pattern:**/*.tsx)' },
        { pattern: '**/*.json', expected: 'Glob(pattern:**/*.json)' },
      ];

      for (const { pattern, expected } of testCases) {
        const descriptor: ToolInvocationDescriptor = {
          toolName: 'Glob',
          params: { pattern },
          affectedPaths: [],
        };

        const result = PatternAbstractor.abstract(descriptor);
        expect(result).toBe(expected);
      }
    });

    it('应该保留非扩展名模式', () => {
      const descriptor: ToolInvocationDescriptor = {
        toolName: 'Glob',
        params: { pattern: 'src/**/index.ts' },
        affectedPaths: [],
      };

      const pattern = PatternAbstractor.abstract(descriptor);
      expect(pattern).toBe('Glob(pattern:src/**/index.ts)');
    });
  });

  describe('WebFetch 抽象', () => {
    it('应该按域名分组', () => {
      const testCases = [
        {
          url: 'https://api.github.com/repos/owner/repo',
          expected: 'WebFetch(domain:api.github.com)',
        },
        {
          url: 'https://docs.anthropic.com/en/docs',
          expected: 'WebFetch(domain:docs.anthropic.com)',
        },
      ];

      for (const { url, expected } of testCases) {
        const descriptor: ToolInvocationDescriptor = {
          toolName: 'WebFetch',
          params: { url },
          affectedPaths: [],
        };

        const pattern = PatternAbstractor.abstract(descriptor);
        expect(pattern).toBe(expected);
      }
    });

    it('应该处理无效 URL', () => {
      const descriptor: ToolInvocationDescriptor = {
        toolName: 'WebFetch',
        params: { url: 'invalid-url' },
        affectedPaths: [],
      };

      const pattern = PatternAbstractor.abstract(descriptor);
      expect(pattern).toBe('WebFetch(url:*)');
    });
  });

  describe('通用工具抽象', () => {
    it('应该将字符串参数替换为通配符', () => {
      const descriptor: ToolInvocationDescriptor = {
        toolName: 'CustomTool',
        params: {
          name: 'some-name',
          count: 5,
          enabled: true,
        },
        affectedPaths: [],
      };

      const pattern = PatternAbstractor.abstract(descriptor);
      expect(pattern).toContain('name:*');
      expect(pattern).toContain('count:5');
      expect(pattern).toContain('enabled:true');
    });

    it('应该处理无参数的工具', () => {
      const descriptor: ToolInvocationDescriptor = {
        toolName: 'SimpleTool',
        params: {},
        affectedPaths: [],
      };

      const pattern = PatternAbstractor.abstract(descriptor);
      expect(pattern).toBe('SimpleTool');
    });
  });

  describe('边界情况', () => {
    it('应该处理空参数', () => {
      const descriptor: ToolInvocationDescriptor = {
        toolName: 'Bash',
        params: { command: '' },
        affectedPaths: [],
      };

      const pattern = PatternAbstractor.abstract(descriptor);
      expect(pattern).toBeTruthy();
    });

    it('应该处理 undefined 参数', () => {
      const descriptor: ToolInvocationDescriptor = {
        toolName: 'Read',
        params: { file_path: undefined },
        affectedPaths: [],
      };

      const pattern = PatternAbstractor.abstract(descriptor);
      expect(pattern).toBe('Read(file_path:*)');
    });

    it('应该处理包含特殊字符的命令', () => {
      const descriptor: ToolInvocationDescriptor = {
        toolName: 'Bash',
        params: { command: 'echo "Hello, World!" | grep Hello' },
        affectedPaths: [],
      };

      const pattern = PatternAbstractor.abstract(descriptor);
      expect(pattern).toBe('Bash(command:echo*)');
    });
  });
});
