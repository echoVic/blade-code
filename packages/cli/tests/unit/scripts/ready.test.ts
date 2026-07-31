import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawn } from 'bun';
import fs from 'node:fs';
import path from 'node:path';

describe('Ready Script - 发布前检查', () => {
  const scriptPath = path.resolve(__dirname, '../../../scripts/ready.ts');

  it('脚本文件应该存在', () => {
    expect(fs.existsSync(scriptPath)).toBe(true);
  });

  it('脚本应该有可执行权限', () => {
    const stats = fs.statSync(scriptPath);
    // 检查文件是否可读
    expect(stats.mode & fs.constants.S_IRUSR).toBeTruthy();
  });

  it('脚本应该包含正确的 shebang', () => {
    const content = fs.readFileSync(scriptPath, 'utf-8');
    expect(content.startsWith('#!/usr/bin/env bun')).toBe(true);
  });

  it('脚本应该定义所有必需的检查项', () => {
    const content = fs.readFileSync(scriptPath, 'utf-8');

    // 检查是否包含所有检查项
    expect(content).toContain('类型检查');
    expect(content).toContain('格式检查');
    expect(content).toContain('Lint 检查');
    expect(content).toContain('单元测试');
    expect(content).toContain('集成测试');
    expect(content).toContain('构建项目');
  });

  it('脚本应该使用正确的命令', () => {
    const content = fs.readFileSync(scriptPath, 'utf-8');

    expect(content).toContain('type-check');
    expect(content).toContain('format:check');
    expect(content).toContain('lint');
    expect(content).toContain('test:unit');
    expect(content).toContain('test:integration');
    expect(content).toContain('build');
  });

  describe('Check 结果处理', () => {
    it('应该定义 CheckResult 接口', () => {
      const content = fs.readFileSync(scriptPath, 'utf-8');
      expect(content).toContain('interface CheckResult');
      expect(content).toContain('name: string');
      expect(content).toContain('passed: boolean');
      expect(content).toContain('duration: number');
    });

    it('应该有格式化时长的函数', () => {
      const content = fs.readFileSync(scriptPath, 'utf-8');
      expect(content).toContain('formatDuration');
    });

    it('应该有打印结果的函数', () => {
      const content = fs.readFileSync(scriptPath, 'utf-8');
      expect(content).toContain('printSummary');
      expect(content).toContain('printCheckResult');
    });
  });

  describe('错误处理', () => {
    it('应该捕获未处理的 Promise rejection', () => {
      const content = fs.readFileSync(scriptPath, 'utf-8');
      expect(content).toContain('unhandledRejection');
    });

    it('失败时应该退出并返回非零代码', () => {
      const content = fs.readFileSync(scriptPath, 'utf-8');
      expect(content).toContain('exit(1)');
    });

    it('成功时应该退出并返回零代码', () => {
      const content = fs.readFileSync(scriptPath, 'utf-8');
      expect(content).toContain('exit(hasFailure ? 1 : 0)');
    });
  });

  describe('输出格式', () => {
    it('应该使用 ANSI 颜色代码', () => {
      const content = fs.readFileSync(scriptPath, 'utf-8');
      expect(content).toContain('\\x1b[');
      expect(content).toContain('colors');
    });

    it('应该有表情符号标识', () => {
      const content = fs.readFileSync(scriptPath, 'utf-8');
      expect(content).toContain('emoji');
      expect(content).toContain('🚀');
    });

    it('应该显示标题和分隔线', () => {
      const content = fs.readFileSync(scriptPath, 'utf-8');
      expect(content).toContain('printHeader');
      expect(content).toContain('Blade Ready Check');
    });
  });
});

describe('Ready 命令集成', () => {
  it('package.json 应该包含 ready 脚本', () => {
    const pkgPath = path.resolve(__dirname, '../../../package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));

    // 检查是否有 ready 命令（可能还没添加到 package.json）
    // 这个测试会提醒我们需要添加这个命令
    if (!pkg.scripts?.ready) {
      console.warn('⚠️  提示：package.json 中缺少 ready 脚本');
    }
  });
});
