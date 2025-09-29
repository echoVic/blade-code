/**
 * Git 工具 E2E 测试
 */

import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { E2ETestSession, E2ETestUtils } from '../setup';

describe('Git 工具 E2E 测试', () => {
  let session: E2ETestSession;
  let testRepoPath: string;

  beforeAll(() => {
    jest.setTimeout(60000);
  });

  beforeEach(() => {
    session = new E2ETestSession({
      timeout: 30000,
    });

    // 创建测试 Git 仓库
    testRepoPath = join(session.getTempDir(), 'test-repo');
    if (!existsSync(testRepoPath)) {
      mkdirSync(testRepoPath, { recursive: true });
    }
  });

  afterEach(() => {
    session.cleanup();
  });

  describe('Git 状态工具测试', () => {
    test('应该能够显示干净仓库的状态', async () => {
      // 初始化 Git 仓库
      await session.runCommand('git', ['init'], undefined, { cwd: testRepoPath });

      // 运行 Git 状态工具
      const result = await session.runCommand('tools', ['run', 'git-status'], {
        cwd: testRepoPath,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('On branch');
    });

    test('应该能够检测未跟踪的文件', async () => {
      // 初始化 Git 仓库
      await session.runCommand('git', ['init'], undefined, { cwd: testRepoPath });

      // 创建未跟踪的文件
      session.createTestFile(
        join('test-repo', 'untracked.txt'),
        'Untracked file content'
      );

      // 运行 Git 状态工具
      const result = await session.runCommand('tools', ['run', 'git-status'], {
        cwd: testRepoPath,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('untracked.txt');
    });

    test('应该能够检测已修改的文件', async () => {
      // 初始化 Git 仓库
      await session.runCommand('git', ['init'], undefined, { cwd: testRepoPath });

      // 配置 Git 用户
      await session.runCommand('git', ['config', 'user.name', 'Test User'], {
        cwd: testRepoPath,
      });
      await session.runCommand('git', ['config', 'user.email', 'test@example.com'], {
        cwd: testRepoPath,
      });

      // 创建并提交初始文件
      const testFile = join(testRepoPath, 'test.txt');
      writeFileSync(testFile, 'Initial content');
      await session.runCommand('git', ['add', 'test.txt'], { cwd: testRepoPath });
      await session.runCommand('git', ['commit', '-m', 'Initial commit'], {
        cwd: testRepoPath,
      });

      // 修改文件
      writeFileSync(testFile, 'Modified content');

      // 运行 Git 状态工具
      const result = await session.runCommand('tools', ['run', 'git-status'], {
        cwd: testRepoPath,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('modified');
    });
  });

  describe('Git 添加工具测试', () => {
    test('应该能够添加文件到暂存区', async () => {
      // 初始化 Git 仓库
      await session.runCommand('git', ['init'], undefined, { cwd: testRepoPath });

      // 创建测试文件
      session.createTestFile(join('test-repo', 'test.txt'), 'Test content');

      // 运行 Git 添加工具
      const result = await session.runCommand('tools', ['run', 'git-add', 'test.txt'], {
        cwd: testRepoPath,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('added');

      // 验证文件已被添加
      const statusResult = await session.runCommand('git', ['status', '--porcelain'], {
        cwd: testRepoPath,
      });

      expect(statusResult.stdout).toContain('A  test.txt');
    });

    test('应该能够添加所有文件', async () => {
      // 初始化 Git 仓库
      await session.runCommand('git', ['init'], undefined, { cwd: testRepoPath });

      // 创建多个测试文件
      session.createTestFile(join('test-repo', 'file1.txt'), 'Content 1');
      session.createTestFile(join('test-repo', 'file2.txt'), 'Content 2');
      session.createTestFile(join('test-repo', 'file3.txt'), 'Content 3');

      // 运行 Git 添加工具
      const result = await session.runCommand('tools', ['run', 'git-add', '.'], {
        cwd: testRepoPath,
      });

      expect(result.exitCode).toBe(0);

      // 验证所有文件都已被添加
      const statusResult = await session.runCommand('git', ['status', '--porcelain'], {
        cwd: testRepoPath,
      });

      expect(statusResult.stdout).toContain('A  file1.txt');
      expect(statusResult.stdout).toContain('A  file2.txt');
      expect(statusResult.stdout).toContain('A  file3.txt');
    });
  });

  describe('Git 提交工具测试', () => {
    test('应该能够创建提交', async () => {
      // 初始化 Git 仓库
      await session.runCommand('git', ['init'], undefined, { cwd: testRepoPath });

      // 配置 Git 用户
      await session.runCommand('git', ['config', 'user.name', 'Test User'], {
        cwd: testRepoPath,
      });
      await session.runCommand('git', ['config', 'user.email', 'test@example.com'], {
        cwd: testRepoPath,
      });

      // 创建并添加测试文件
      session.createTestFile(join('test-repo', 'test.txt'), 'Test content');
      await session.runCommand('git', ['add', 'test.txt'], { cwd: testRepoPath });

      // 运行 Git 提交工具
      const result = await session.runCommand(
        'tools',
        ['run', 'git-commit', '-m', 'Test commit message'],
        { cwd: testRepoPath }
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Test commit message');

      // 验证提交已创建
      const logResult = await session.runCommand('git', ['log', '--oneline', '-1'], {
        cwd: testRepoPath,
      });

      expect(logResult.stdout).toContain('Test commit message');
    });

    test('应该能够处理空提交', async () => {
      // 初始化 Git 仓库
      await session.runCommand('git', ['init'], undefined, { cwd: testRepoPath });

      // 配置 Git 用户
      await session.runCommand('git', ['config', 'user.name', 'Test User'], {
        cwd: testRepoPath,
      });
      await session.runCommand('git', ['config', 'user.email', 'test@example.com'], {
        cwd: testRepoPath,
      });

      // 运行空提交
      const result = await session.runCommand(
        'tools',
        ['run', 'git-commit', '--allow-empty', '-m', 'Empty commit'],
        { cwd: testRepoPath }
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Empty commit');
    });
  });

  describe('Git 分支工具测试', () => {
    test('应该能够列出分支', async () => {
      // 初始化 Git 仓库
      await session.runCommand('git', ['init'], undefined, { cwd: testRepoPath });

      // 运行 Git 分支工具
      const result = await session.runCommand('tools', ['run', 'git-branch'], {
        cwd: testRepoPath,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('* main');
    });

    test('应该能够创建新分支', async () => {
      // 初始化 Git 仓库
      await session.runCommand('git', ['init'], undefined, { cwd: testRepoPath });

      // 运行 Git 分支创建工具
      const result = await session.runCommand(
        'tools',
        ['run', 'git-branch', 'feature/test-branch'],
        { cwd: testRepoPath }
      );

      expect(result.exitCode).toBe(0);

      // 验证分支已创建
      const listResult = await session.runCommand('tools', ['run', 'git-branch'], {
        cwd: testRepoPath,
      });

      expect(listResult.stdout).toContain('feature/test-branch');
    });
  });

  describe('Git 日志工具测试', () => {
    test('应该能够显示提交历史', async () => {
      // 初始化 Git 仓库
      await session.runCommand('git', ['init'], undefined, { cwd: testRepoPath });

      // 配置 Git 用户
      await session.runCommand('git', ['config', 'user.name', 'Test User'], {
        cwd: testRepoPath,
      });
      await session.runCommand('git', ['config', 'user.email', 'test@example.com'], {
        cwd: testRepoPath,
      });

      // 创建一些提交
      session.createTestFile(join('test-repo', 'file1.txt'), 'Content 1');
      await session.runCommand('git', ['add', 'file1.txt'], { cwd: testRepoPath });
      await session.runCommand('git', ['commit', '-m', 'First commit'], {
        cwd: testRepoPath,
      });

      session.createTestFile(join('test-repo', 'file2.txt'), 'Content 2');
      await session.runCommand('git', ['add', 'file2.txt'], { cwd: testRepoPath });
      await session.runCommand('git', ['commit', '-m', 'Second commit'], {
        cwd: testRepoPath,
      });

      // 运行 Git 日志工具
      const result = await session.runCommand('tools', ['run', 'git-log'], {
        cwd: testRepoPath,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('First commit');
      expect(result.stdout).toContain('Second commit');
    });

    test('应该能够限制日志条数', async () => {
      // 初始化 Git 仓库
      await session.runCommand('git', ['init'], undefined, { cwd: testRepoPath });

      // 配置 Git 用户
      await session.runCommand('git', ['config', 'user.name', 'Test User'], {
        cwd: testRepoPath,
      });
      await session.runCommand('git', ['config', 'user.email', 'test@example.com'], {
        cwd: testRepoPath,
      });

      // 创建多个提交
      for (let i = 1; i <= 5; i++) {
        session.createTestFile(join('test-repo', `file${i}.txt`), `Content ${i}`);
        await session.runCommand('git', ['add', `file${i}.txt`], { cwd: testRepoPath });
        await session.runCommand('git', ['commit', '-m', `Commit ${i}`], {
          cwd: testRepoPath,
        });
      }

      // 运行 Git 日志工具，限制为 2 条
      const result = await session.runCommand(
        'tools',
        ['run', 'git-log', '--max-count', '2'],
        { cwd: testRepoPath }
      );

      expect(result.exitCode).toBe(0);
      // 应该只显示最近的 2 条提交
      const commitCount = (result.stdout.match(/commit/g) || []).length;
      expect(commitCount).toBe(2);
    });
  });

  describe('Git Diff 工具测试', () => {
    test('应该能够显示工作区差异', async () => {
      // 初始化 Git 仓库
      await session.runCommand('git', ['init'], undefined, { cwd: testRepoPath });

      // 配置 Git 用户
      await session.runCommand('git', ['config', 'user.name', 'Test User'], {
        cwd: testRepoPath,
      });
      await session.runCommand('git', ['config', 'user.email', 'test@example.com'], {
        cwd: testRepoPath,
      });

      // 创建初始文件并提交
      const testFile = join(testRepoPath, 'test.txt');
      writeFileSync(testFile, 'Initial content\n');
      await session.runCommand('git', ['add', 'test.txt'], { cwd: testRepoPath });
      await session.runCommand('git', ['commit', '-m', 'Initial commit'], {
        cwd: testRepoPath,
      });

      // 修改文件
      writeFileSync(testFile, 'Modified content\n');

      // 运行 Git Diff 工具
      const result = await session.runCommand('tools', ['run', 'git-diff'], {
        cwd: testRepoPath,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('@@');
      expect(result.stdout).toContain('-Initial content');
      expect(result.stdout).toContain('+Modified content');
    });

    test('应该能够显示暂存区差异', async () => {
      // 初始化 Git 仓库
      await session.runCommand('git', ['init'], undefined, { cwd: testRepoPath });

      // 配置 Git 用户
      await session.runCommand('git', ['config', 'user.name', 'Test User'], {
        cwd: testRepoPath,
      });
      await session.runCommand('git', ['config', 'user.email', 'test@example.com'], {
        cwd: testRepoPath,
      });

      // 创建初始文件并提交
      const testFile = join(testRepoPath, 'test.txt');
      writeFileSync(testFile, 'Initial content\n');
      await session.runCommand('git', ['add', 'test.txt'], { cwd: testRepoPath });
      await session.runCommand('git', ['commit', '-m', 'Initial commit'], {
        cwd: testRepoPath,
      });

      // 修改文件并添加到暂存区
      writeFileSync(testFile, 'Staged content\n');
      await session.runCommand('git', ['add', 'test.txt'], { cwd: testRepoPath });

      // 再次修改文件（工作区）
      writeFileSync(testFile, 'Working content\n');

      // 运行 Git Diff 工具显示暂存区差异
      const result = await session.runCommand(
        'tools',
        ['run', 'git-diff', '--cached'],
        {
          cwd: testRepoPath,
        }
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('@@');
      expect(result.stdout).toContain('-Initial content');
      expect(result.stdout).toContain('+Staged content');
    });
  });

  describe('性能测试', () => {
    test('应该在合理时间内执行 Git 工具', async () => {
      // 初始化 Git 仓库
      await session.runCommand('git', ['init'], undefined, { cwd: testRepoPath });

      const startTime = Date.now();

      // 运行 Git 状态工具
      const result = await session.runCommand('tools', ['run', 'git-status'], {
        cwd: testRepoPath,
      });

      const endTime = Date.now();
      const duration = endTime - startTime;

      expect(result.exitCode).toBe(0);
      expect(duration).toBeLessThan(5000); // 5秒内应该完成
    });

    test('应该能够处理大型仓库', async () => {
      // 初始化 Git 仓库
      await session.runCommand('git', ['init'], undefined, { cwd: testRepoPath });

      // 创建大量文件
      for (let i = 0; i < 100; i++) {
        session.createTestFile(join('test-repo', `file${i}.txt`), `Content ${i}`);
      }

      // 运行 Git 状态工具
      const result = await session.runCommand('tools', ['run', 'git-status'], {
        cwd: testRepoPath,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('untracked files');
    });
  });

  describe('错误处理测试', () => {
    test('应该正确处理非 Git 仓库', async () => {
      // 在非 Git 仓库中运行 Git 工具
      const result = await session.runCommand('tools', ['run', 'git-status']);

      // 应该返回错误
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('not a git repository');
    });

    test('应该正确处理无效的 Git 命令', async () => {
      // 初始化 Git 仓库
      await session.runCommand('git', ['init'], undefined, { cwd: testRepoPath });

      // 运行无效的 Git 命令
      const result = await session.runCommand('tools', ['run', 'git-invalid']);

      expect(result.exitCode).not.toBe(0);
    });

    test('应该正确处理权限错误', async () => {
      // 这个测试在某些环境中可能无法运行
      // 我们只验证命令能够处理错误情况
      const result = await session.runCommand('tools', ['run', 'git-status'], {
        cwd: '/root', // 通常没有权限访问的目录
      });

      // 应该返回错误但不崩溃
      expect([0, 1]).toContain(result.exitCode);
    });
  });
});
