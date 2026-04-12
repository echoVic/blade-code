import { describe, it, expect } from 'vitest';

const formatToolOutput = (toolName: string, result: unknown): string => {
  const header = `=== ${toolName} ===`;
  const content = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
  return `${header}\n${content}`;
};

const formatFileReadOutput = (filePath: string, content: string, lineCount: number): string => {
  return `${filePath} (${lineCount} lines)\n${'─'.repeat(40)}\n${content}`;
};

const formatGrepOutput = (
  matches: Array<{ file: string; line: number; content: string }>
): string => {
  if (matches.length === 0) {
    return 'No matches found.';
  }

  return matches
    .map((m) => `${m.file}:${m.line}: ${m.content}`)
    .join('\n');
};

const formatCommandOutput = (
  command: string,
  output: string,
  exitCode: number,
  duration: number
): string => {
  const status = exitCode === 0 ? '[OK]' : '[FAIL]';
  return `${status} $ ${command}\n${output}\n[Exit: ${exitCode}] [Duration: ${duration}ms]`;
};

describe('工具输出快照测试', () => {
  describe('Read 工具输出', () => {
    it('应该正确格式化文件读取输出', () => {
      const output = formatFileReadOutput(
        '/src/index.ts',
        'export const main = () => {\n  console.log("Hello");\n};',
        3
      );
      expect(output).toMatchSnapshot();
    });

    it('应该正确格式化空文件输出', () => {
      const output = formatFileReadOutput('/src/empty.ts', '', 0);
      expect(output).toMatchSnapshot();
    });

    it('应该正确格式化大文件输出', () => {
      const content = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`).join('\n');
      const output = formatFileReadOutput('/src/large.ts', content, 100);
      expect(output).toMatchSnapshot();
    });
  });

  describe('Grep 工具输出', () => {
    it('应该正确格式化搜索结果', () => {
      const matches = [
        { file: 'src/index.ts', line: 10, content: 'const config = loadConfig();' },
        { file: 'src/utils.ts', line: 25, content: 'export function config() {}' },
        { file: 'tests/config.test.ts', line: 5, content: 'describe("config", () => {' },
      ];
      const output = formatGrepOutput(matches);
      expect(output).toMatchSnapshot();
    });

    it('应该正确格式化无匹配结果', () => {
      const output = formatGrepOutput([]);
      expect(output).toMatchSnapshot();
    });
  });

  describe('RunCommand 工具输出', () => {
    it('应该正确格式化成功的命令输出', () => {
      const output = formatCommandOutput(
        'npm run build',
        'Build completed successfully.\nOutput: dist/bundle.js',
        0,
        1234
      );
      expect(output).toMatchSnapshot();
    });

    it('应该正确格式化失败的命令输出', () => {
      const output = formatCommandOutput(
        'npm run test',
        'Error: Test failed\n  at src/index.test.ts:10:5',
        1,
        567
      );
      expect(output).toMatchSnapshot();
    });
  });

  describe('通用工具输出', () => {
    it('应该正确格式化 JSON 结果', () => {
      const result = {
        success: true,
        data: {
          files: ['a.ts', 'b.ts'],
          count: 2,
        },
      };
      const output = formatToolOutput('Glob', result);
      expect(output).toMatchSnapshot();
    });

    it('应该正确格式化字符串结果', () => {
      const output = formatToolOutput('WebSearch', 'Found 5 results for "typescript"');
      expect(output).toMatchSnapshot();
    });
  });
});
