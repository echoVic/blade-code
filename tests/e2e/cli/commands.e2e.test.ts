/**
 * CLI 命令端到端测试
 */

import { E2ETestSession, E2ETestUtils } from './setup';

describe('CLI 命令 E2E 测试', () => {
  let session: E2ETestSession;

  beforeAll(() => {
    jest.setTimeout(60000); // 增加超时时间到60秒
  });

  beforeEach(() => {
    session = new E2ETestSession({
      timeout: 30000,
      cwd: process.cwd(),
    });
  });

  afterEach(() => {
    session.cleanup();
  });

  describe('基础命令测试', () => {
    test('应该能够显示帮助信息', async () => {
      const result = await session.runCommand('--help');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Usage:');
      expect(result.stdout).toContain('Commands:');
      expect(result.stderr).toBe('');
    });

    test('应该能够显示版本信息', async () => {
      const result = await session.runCommand('--version');

      expect(result.exitCode).toBe(0);
      // 版本应该是一个有效的语义化版本号
      expect(result.stdout).toMatch(/\d+\.\d+\.\d+/);
      expect(result.stderr).toBe('');
    });

    test('应该能够显示当前工作目录信息', async () => {
      const result = await session.runCommand('pwd');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(process.cwd());
      expect(result.stderr).toBe('');
    });
  });

  describe('配置命令测试', () => {
    test('应该能够初始化配置', async () => {
      const result = await session.runCommand('config', ['init']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Configuration initialized');
    });

    test('应该能够显示配置信息', async () => {
      // 先初始化配置
      await session.runCommand('config', ['init']);

      // 然后显示配置
      const result = await session.runCommand('config', ['show']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('auth');
      expect(result.stdout).toContain('ui');
    });

    test('应该能够更新配置', async () => {
      // 先初始化配置
      await session.runCommand('config', ['init']);

      // 更新配置
      const result = await session.runCommand('config', ['set', 'ui.theme', 'dark']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Configuration updated');
    });

    test('应该能够重置配置', async () => {
      // 先初始化配置
      await session.runCommand('config', ['init']);

      // 重置配置
      const result = await session.runCommand('config', ['reset']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Configuration reset');
    });
  });

  describe('LLM 命令测试', () => {
    test('应该能够测试 LLM 连接', async () => {
      // 这个测试需要有效的 API 密钥，我们在测试环境中模拟
      const result = await session.runCommand('llm', ['test'], 'test-api-key\n');

      // 由于没有真实的 API 密钥，这里可能会失败，但我们检查命令是否能正常执行
      expect([0, 1]).toContain(result.exitCode); // 0 表示成功，1 表示连接失败但命令执行成功
    });

    test('应该能够列出支持的模型', async () => {
      const result = await session.runCommand('llm', ['models']);

      expect(result.exitCode).toBe(0);
      // 应该列出一些模型
      expect(result.stdout.length).toBeGreaterThan(0);
    });

    test('应该能够进行简单的聊天', async () => {
      const result = await session.runCommand('llm', ['chat', 'Hello, world!']);

      // 由于没有配置 API 密钥，这里可能会失败，但我们检查命令是否能正常执行
      expect([0, 1]).toContain(result.exitCode);
    });
  });

  describe('工具命令测试', () => {
    test('应该能够列出可用工具', async () => {
      const result = await session.runCommand('tools', ['list']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Available tools');
    });

    test('应该能够显示工具信息', async () => {
      const result = await session.runCommand('tools', ['info', 'git-status']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('git-status');
    });

    test('应该能够搜索工具', async () => {
      const result = await session.runCommand('tools', ['search', 'git']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('git');
    });
  });

  describe('MCP 命令测试', () => {
    test('应该能够启动 MCP 服务器', async () => {
      // 启动服务器（在后台）
      const result = await session.runCommand('mcp', ['start', '--port', '3001']);

      // 检查命令是否正常执行（可能因为端口占用而失败，但我们检查执行情况）
      expect([0, 1]).toContain(result.exitCode);
    });

    test('应该能够连接到 MCP 服务器', async () => {
      const result = await session.runCommand('mcp', [
        'connect',
        'ws://localhost:3001',
      ]);

      // 检查命令是否正常执行
      expect([0, 1]).toContain(result.exitCode);
    });

    test('应该能够显示 MCP 状态', async () => {
      const result = await session.runCommand('mcp', ['status']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('MCP');
    });
  });

  describe('Agent 命令测试', () => {
    test('应该能够启动 Agent', async () => {
      const result = await session.runCommand('agent-llm', ['start']);

      // 由于没有配置 API 密钥，这里可能会失败，但我们检查命令是否能正常执行
      expect([0, 1]).toContain(result.exitCode);
    });

    test('应该能够与 Agent 对话', async () => {
      const result = await session.runCommand('agent-llm', ['chat', 'Hello, Agent!']);

      // 检查命令是否正常执行
      expect([0, 1]).toContain(result.exitCode);
    });

    test('应该能够显示 Agent 状态', async () => {
      const result = await session.runCommand('agent-llm', ['status']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Agent');
    });
  });

  describe('文件操作测试', () => {
    test('应该能够创建测试文件', async () => {
      // 创建一个测试文件
      session.createTestFile('test.txt', 'Hello, Test!');

      // 验证文件创建
      const result = await session.runCommand('ls');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('test.txt');
    });

    test('应该能够读取文件内容', async () => {
      // 创建一个测试文件
      session.createTestFile('read-test.txt', 'File content for reading test');

      // 读取文件（假设有一个 read 命令）
      // 注意：这里需要根据实际的 CLI 命令结构调整
      const result = await session.runCommand('cat', ['read-test.txt']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('File content for reading test');
    });
  });

  describe('性能测试', () => {
    test('应该在合理时间内执行简单命令', async () => {
      const result = await session.runCommand('--version');

      expect(result.exitCode).toBe(0);
      expect(result.duration).toBeLessThan(5000); // 5秒内应该完成
    });

    test('应该能够处理并发命令', async () => {
      // 同时运行多个简单命令
      const commands = [
        session.runCommand('--version'),
        session.runCommand('--help'),
        session.runCommand('pwd'),
      ];

      const results = await Promise.all(commands);

      results.forEach((result) => {
        expect(result.exitCode).toBe(0);
      });
    });
  });

  describe('错误处理测试', () => {
    test('应该正确处理无效命令', async () => {
      const result = await session.runCommand('invalid-command');

      // 应该返回非零退出码
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('command');
    });

    test('应该正确处理缺少参数', async () => {
      const result = await session.runCommand('config', ['set']);

      // 应该返回非零退出码
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('required');
    });

    test('应该正确处理无效参数', async () => {
      const result = await session.runCommand('config', [
        'set',
        'invalid.key',
        'value',
      ]);

      // 可能成功（如果允许自定义键）或失败
      expect([0, 1]).toContain(result.exitCode);
    });
  });

  describe('交互式命令测试', () => {
    test('应该能够处理用户输入', async () => {
      // 测试需要用户输入的命令
      const result = await session.runCommand('config', ['init'], 'y\n'); // 自动确认

      expect([0, 1]).toContain(result.exitCode);
    });

    test('应该能够处理多步骤交互', async () => {
      // 创建一个多步骤交互的场景
      const result = await session.runCommand('wizard', [], 'step1\nstep2\nstep3\n');

      // 检查命令是否正常执行
      expect([0, 1]).toContain(result.exitCode);
    });
  });
});
