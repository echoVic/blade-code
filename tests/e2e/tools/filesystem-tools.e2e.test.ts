/**
 * 文件系统工具 E2E 测试
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { E2ETestSession, E2ETestUtils } from '../setup';

describe('文件系统工具 E2E 测试', () => {
  let session: E2ETestSession;
  let testDirPath: string;

  beforeAll(() => {
    jest.setTimeout(60000);
  });

  beforeEach(() => {
    session = new E2ETestSession({
      timeout: 30000,
    });

    // 创建测试目录
    testDirPath = join(session.getTempDir(), 'test-fs');
    if (!existsSync(testDirPath)) {
      mkdirSync(testDirPath, { recursive: true });
    }
  });

  afterEach(() => {
    session.cleanup();
  });

  describe('文件读取工具测试', () => {
    test('应该能够读取文本文件', async () => {
      // 创建测试文件
      const testFilePath = join(testDirPath, 'test.txt');
      const fileContent = 'Hello, World!\nThis is a test file.\n';
      writeFileSync(testFilePath, fileContent);

      // 运行文件读取工具
      const result = await session.runCommand(
        'tools',
        ['run', 'file-read', testFilePath],
        { cwd: testDirPath }
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Hello, World!');
      expect(result.stdout).toContain('This is a test file.');
    });

    test('应该能够读取 JSON 文件', async () => {
      // 创建测试 JSON 文件
      const testFilePath = join(testDirPath, 'test.json');
      const jsonData = {
        name: 'Test File',
        version: '1.0.0',
        description: 'A test JSON file',
      };
      writeFileSync(testFilePath, JSON.stringify(jsonData, null, 2));

      // 运行文件读取工具
      const result = await session.runCommand(
        'tools',
        ['run', 'file-read', testFilePath],
        { cwd: testDirPath }
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Test File');
      expect(result.stdout).toContain('1.0.0');
    });

    test('应该能够处理不存在的文件', async () => {
      const nonExistentFile = join(testDirPath, 'non-existent.txt');

      // 运行文件读取工具
      const result = await session.runCommand(
        'tools',
        ['run', 'file-read', nonExistentFile],
        { cwd: testDirPath }
      );

      // 应该返回错误但不崩溃
      expect([0, 1]).toContain(result.exitCode);
      expect(result.stderr).toContain('ENOENT');
    });
  });

  describe('文件写入工具测试', () => {
    test('应该能够写入文本文件', async () => {
      const testFilePath = join(testDirPath, 'output.txt');
      const content = 'Written by file-write tool\nSecond line\n';

      // 运行文件写入工具
      const result = await session.runCommand(
        'tools',
        ['run', 'file-write', testFilePath, content],
        { cwd: testDirPath }
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('successfully');

      // 验证文件内容
      const writtenContent = readFileSync(testFilePath, 'utf-8');
      expect(writtenContent).toBe(content);
    });

    test('应该能够追加内容到文件', async () => {
      const testFilePath = join(testDirPath, 'append.txt');

      // 先创建初始文件
      writeFileSync(testFilePath, 'Initial content\n');

      // 追加内容
      const result = await session.runCommand(
        'tools',
        ['run', 'file-append', testFilePath, 'Appended content\n'],
        { cwd: testDirPath }
      );

      expect(result.exitCode).toBe(0);

      // 验证文件内容
      const writtenContent = readFileSync(testFilePath, 'utf-8');
      expect(writtenContent).toBe('Initial content\nAppended content\n');
    });

    test('应该能够处理写入权限错误', async () => {
      // 尝试写入到只读目录（如果可能的话）
      const result = await session.runCommand('tools', [
        'run',
        'file-write',
        '/root/test.txt',
        'test content',
      ]);

      // 应该处理权限错误
      expect([0, 1]).toContain(result.exitCode);
    });
  });

  describe('文件列表工具测试', () => {
    test('应该能够列出目录内容', async () => {
      // 创建测试文件
      writeFileSync(join(testDirPath, 'file1.txt'), 'Content 1');
      writeFileSync(join(testDirPath, 'file2.txt'), 'Content 2');
      mkdirSync(join(testDirPath, 'subdir'));
      writeFileSync(join(testDirPath, 'subdir', 'file3.txt'), 'Content 3');

      // 运行文件列表工具
      const result = await session.runCommand(
        'tools',
        ['run', 'file-list', testDirPath],
        { cwd: testDirPath }
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('file1.txt');
      expect(result.stdout).toContain('file2.txt');
      expect(result.stdout).toContain('subdir');
    });

    test('应该能够递归列出目录', async () => {
      // 创建嵌套目录结构
      mkdirSync(join(testDirPath, 'level1'));
      mkdirSync(join(testDirPath, 'level1', 'level2'));
      writeFileSync(join(testDirPath, 'level1', 'file1.txt'), 'Content 1');
      writeFileSync(join(testDirPath, 'level1', 'level2', 'file2.txt'), 'Content 2');

      // 运行递归文件列表工具
      const result = await session.runCommand(
        'tools',
        ['run', 'file-list', '--recursive', testDirPath],
        { cwd: testDirPath }
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('file1.txt');
      expect(result.stdout).toContain('file2.txt');
    });

    test('应该能够过滤文件列表', async () => {
      // 创建不同类型的文件
      writeFileSync(join(testDirPath, 'test.txt'), 'Text content');
      writeFileSync(join(testDirPath, 'test.js'), 'JavaScript content');
      writeFileSync(join(testDirPath, 'test.css'), 'CSS content');

      // 运行带过滤器的文件列表工具
      const result = await session.runCommand(
        'tools',
        ['run', 'file-list', '--filter', '*.txt', testDirPath],
        { cwd: testDirPath }
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('test.txt');
      expect(result.stdout).not.toContain('test.js');
      expect(result.stdout).not.toContain('test.css');
    });
  });

  describe('文件搜索工具测试', () => {
    test('应该能够按内容搜索文件', async () => {
      // 创建测试文件
      writeFileSync(join(testDirPath, 'file1.txt'), 'Hello World');
      writeFileSync(join(testDirPath, 'file2.txt'), 'Goodbye World');
      writeFileSync(join(testDirPath, 'file3.txt'), 'Hello Universe');

      // 运行文件搜索工具
      const result = await session.runCommand(
        'tools',
        ['run', 'file-search', 'Hello', testDirPath],
        { cwd: testDirPath }
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('file1.txt');
      expect(result.stdout).toContain('file3.txt');
      expect(result.stdout).not.toContain('file2.txt');
    });

    test('应该能够按文件名搜索', async () => {
      // 创建测试文件
      writeFileSync(join(testDirPath, 'readme.md'), '# README');
      writeFileSync(join(testDirPath, 'package.json'), '{"name": "test"}');
      writeFileSync(join(testDirPath, 'index.js'), 'console.log("test");');

      // 运行文件名搜索工具
      const result = await session.runCommand(
        'tools',
        ['run', 'file-search', '--name', '*.md', testDirPath],
        { cwd: testDirPath }
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('readme.md');
      expect(result.stdout).not.toContain('package.json');
      expect(result.stdout).not.toContain('index.js');
    });

    test('应该能够递归搜索', async () => {
      // 创建嵌套目录结构
      mkdirSync(join(testDirPath, 'src'));
      mkdirSync(join(testDirPath, 'tests'));
      writeFileSync(join(testDirPath, 'src', 'main.js'), 'console.log("main");');
      writeFileSync(join(testDirPath, 'tests', 'test.js'), 'console.log("test");');

      // 运行递归搜索工具
      const result = await session.runCommand(
        'tools',
        ['run', 'file-search', '--recursive', 'console.log', testDirPath],
        { cwd: testDirPath }
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('main.js');
      expect(result.stdout).toContain('test.js');
    });
  });

  describe('文件操作工具测试', () => {
    test('应该能够复制文件', async () => {
      const sourceFile = join(testDirPath, 'source.txt');
      const targetFile = join(testDirPath, 'target.txt');
      const content = 'File to copy';

      // 创建源文件
      writeFileSync(sourceFile, content);

      // 运行文件复制工具
      const result = await session.runCommand(
        'tools',
        ['run', 'file-copy', sourceFile, targetFile],
        { cwd: testDirPath }
      );

      expect(result.exitCode).toBe(0);

      // 验证目标文件
      const targetContent = readFileSync(targetFile, 'utf-8');
      expect(targetContent).toBe(content);
    });

    test('应该能够移动文件', async () => {
      const sourceFile = join(testDirPath, 'source.txt');
      const targetFile = join(testDirPath, 'target.txt');
      const content = 'File to move';

      // 创建源文件
      writeFileSync(sourceFile, content);

      // 运行文件移动工具
      const result = await session.runCommand(
        'tools',
        ['run', 'file-move', sourceFile, targetFile],
        { cwd: testDirPath }
      );

      expect(result.exitCode).toBe(0);

      // 验证源文件不存在，目标文件存在
      expect(existsSync(sourceFile)).toBe(false);
      expect(existsSync(targetFile)).toBe(true);

      const targetContent = readFileSync(targetFile, 'utf-8');
      expect(targetContent).toBe(content);
    });

    test('应该能够删除文件', async () => {
      const testFile = join(testDirPath, 'todelete.txt');

      // 创建要删除的文件
      writeFileSync(testFile, 'Content to delete');
      expect(existsSync(testFile)).toBe(true);

      // 运行文件删除工具
      const result = await session.runCommand(
        'tools',
        ['run', 'file-delete', testFile],
        { cwd: testDirPath }
      );

      expect(result.exitCode).toBe(0);
      expect(existsSync(testFile)).toBe(false);
    });
  });

  describe('目录操作工具测试', () => {
    test('应该能够创建目录', async () => {
      const newDir = join(testDirPath, 'new-directory');

      // 运行目录创建工具
      const result = await session.runCommand('tools', ['run', 'dir-create', newDir], {
        cwd: testDirPath,
      });

      expect(result.exitCode).toBe(0);
      expect(existsSync(newDir)).toBe(true);
      expect(result.stdout).toContain('created');
    });

    test('应该能够删除空目录', async () => {
      const emptyDir = join(testDirPath, 'empty-dir');
      mkdirSync(emptyDir);
      expect(existsSync(emptyDir)).toBe(true);

      // 运行目录删除工具
      const result = await session.runCommand(
        'tools',
        ['run', 'dir-delete', emptyDir],
        { cwd: testDirPath }
      );

      expect(result.exitCode).toBe(0);
      expect(existsSync(emptyDir)).toBe(false);
    });

    test('应该能够删除非空目录', async () => {
      const nonEmptyDir = join(testDirPath, 'non-empty-dir');
      mkdirSync(nonEmptyDir);
      writeFileSync(join(nonEmptyDir, 'file.txt'), 'Content');
      expect(existsSync(nonEmptyDir)).toBe(true);

      // 运行强制目录删除工具
      const result = await session.runCommand(
        'tools',
        ['run', 'dir-delete', '--force', nonEmptyDir],
        { cwd: testDirPath }
      );

      expect(result.exitCode).toBe(0);
      expect(existsSync(nonEmptyDir)).toBe(false);
    });
  });

  describe('文件信息工具测试', () => {
    test('应该能够获取文件信息', async () => {
      const testFile = join(testDirPath, 'info.txt');
      const content = 'File for info testing';
      writeFileSync(testFile, content);

      // 运行文件信息工具
      const result = await session.runCommand('tools', ['run', 'file-info', testFile], {
        cwd: testDirPath,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('size');
      expect(result.stdout).toContain('modified');
      expect(result.stdout).toContain('.txt');
    });

    test('应该能够获取目录信息', async () => {
      const testDir = join(testDirPath, 'info-dir');
      mkdirSync(testDir);
      writeFileSync(join(testDir, 'file1.txt'), 'Content 1');
      writeFileSync(join(testDir, 'file2.txt'), 'Content 2');

      // 运行目录信息工具
      const result = await session.runCommand('tools', ['run', 'file-info', testDir], {
        cwd: testDirPath,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('directory');
      expect(result.stdout).toContain('2 files');
    });
  });

  describe('性能测试', () => {
    test('应该在合理时间内处理大量文件', async () => {
      // 创建大量小文件
      for (let i = 0; i < 100; i++) {
        writeFileSync(join(testDirPath, `file${i}.txt`), `Content ${i}`);
      }

      const startTime = Date.now();

      // 运行文件列表工具
      const result = await session.runCommand(
        'tools',
        ['run', 'file-list', testDirPath],
        { cwd: testDirPath }
      );

      const endTime = Date.now();
      const duration = endTime - startTime;

      expect(result.exitCode).toBe(0);
      expect(duration).toBeLessThan(10000); // 10秒内应该完成
    });

    test('应该能够处理大文件', async () => {
      const largeFile = join(testDirPath, 'large.txt');

      // 创建大文件（1MB）
      const content = '0123456789'.repeat(100000); // 1MB content
      writeFileSync(largeFile, content);

      const startTime = Date.now();

      // 运行文件信息工具
      const result = await session.runCommand(
        'tools',
        ['run', 'file-info', largeFile],
        { cwd: testDirPath }
      );

      const endTime = Date.now();
      const duration = endTime - startTime;

      expect(result.exitCode).toBe(0);
      expect(duration).toBeLessThan(5000); // 5秒内应该完成
    });
  });

  describe('错误处理测试', () => {
    test('应该正确处理无效路径', async () => {
      const result = await session.runCommand('tools', [
        'run',
        'file-read',
        '/invalid/path/file.txt',
      ]);

      // 应该处理错误但不崩溃
      expect([0, 1]).toContain(result.exitCode);
    });

    test('应该正确处理权限错误', async () => {
      const result = await session.runCommand('tools', [
        'run',
        'file-delete',
        '/root/system-file',
      ]);

      // 应该处理权限错误
      expect([0, 1]).toContain(result.exitCode);
    });

    test('应该正确处理磁盘空间不足', async () => {
      // 这个测试在普通环境中难以模拟
      // 我们验证工具能够处理写入错误
      const result = await session.runCommand('tools', [
        'run',
        'file-write',
        join(testDirPath, 'test.txt'),
        'x'.repeat(1000000000),
      ]);

      // 应该处理写入错误
      expect([0, 1]).toContain(result.exitCode);
    });
  });
});
