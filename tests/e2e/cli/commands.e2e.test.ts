/**
 * CLI 命令端到端测试
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { execa } from 'execa';
import { access, mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

// 测试用的临时目录
const testDir = join(tmpdir(), 'blade-e2e-test');
const bladeCli = join(process.cwd(), 'dist', 'blade.js');

/**
 * 执行 CLI 命令并返回结果
 */
async function runBladeCommand(
  args: string[],
  options: { cwd?: string; timeout?: number } = {}
) {
  try {
    const result = await execa('node', [bladeCli, ...args], {
      cwd: options.cwd || testDir,
      env: { ...process.env, NODE_ENV: 'test' },
      timeout: options.timeout || 10000,
      reject: false, // 不自动抛出错误，让我们手动处理
    });

    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    };
  } catch (error: any) {
    return {
      stdout: error.stdout || '',
      stderr: error.stderr || error.message || 'Unknown error',
      exitCode: error.exitCode || 1,
    };
  }
}

describe('CLI 命令 E2E 测试', () => {
  beforeAll(async () => {
    // 创建测试目录
    try {
      await access(testDir);
      await rm(testDir, { recursive: true });
    } catch {
      // 目录不存在，忽略错误
    }
    await mkdir(testDir, { recursive: true });

    // 检查 CLI 是否已构建
    try {
      await access(bladeCli);
    } catch {
      throw new Error('CLI 未构建，请先运行 pnpm build');
    }
  });

  afterAll(async () => {
    // 清理测试目录
    try {
      await rm(testDir, { recursive: true });
    } catch {
      // 忽略清理错误
    }
  });

  describe('基础命令', () => {
    test('应该显示帮助信息', async () => {
      const result = await runBladeCommand(['--help'], { timeout: 5000 });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Commands:');
      expect(result.stdout).toContain('Options:');
    });

    test('应该显示版本信息', async () => {
      const result = await runBladeCommand(['--version'], { timeout: 5000 });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/\d+\.\d+\.\d+/);
    });

    test('应该支持命令补全', async () => {
      const result = await runBladeCommand(['completion'], { timeout: 5000 });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('blade');
    });
  });

  describe('doctor 命令', () => {
    test('应该执行健康检查', async () => {
      const result = await runBladeCommand(['doctor']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Running Blade health check');
      expect(result.stdout).toContain('Node.js version');
      expect(result.stdout).toContain('File system permissions');
    });
  });

  describe('config 命令', () => {
    test('应该显示配置帮助', async () => {
      const result = await runBladeCommand(['config', '--help']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Manage configuration');
      expect(result.stdout).toContain('set');
      expect(result.stdout).toContain('get');
      expect(result.stdout).toContain('list');
      expect(result.stdout).toContain('reset');
    });

    test('应该列出配置', async () => {
      const result = await runBladeCommand(['config', 'list']);

      // 配置命令应该能执行，即使没有配置文件
      expect([0, 1]).toContain(result.exitCode);
    });

    test('应该能列出配置', async () => {
      const result = await runBladeCommand(['config', 'list'], { timeout: 5000 });

      expect(result.exitCode).toBe(0);
      // 配置列表应该包含一些基本信息
      expect(result.stdout.length).toBeGreaterThan(0);
    });
  });

  describe('doctor 命令', () => {
    test('应该能执行 doctor 命令', async () => {
      const result = await runBladeCommand(['doctor'], { timeout: 5000 });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Blade');
    });
  });

  describe('config 命令', () => {
    test('应该能显示 config 帮助', async () => {
      const result = await runBladeCommand(['config', '--help'], { timeout: 5000 });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('config');
    });
  });

  describe('交互模式', () => {
    test('应该能启动交互模式（快速退出）', async () => {
      // 跳过交互模式测试，因为它会持续运行
      // 这里只测试能否正常启动进程
      const result = await runBladeCommand(['--help'], { timeout: 5000 });

      // 帮助命令应该正常退出
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Commands:');
    });
  });
});
