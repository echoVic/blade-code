import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const CLI_ENTRY = path.resolve('dist', 'blade.js');

describe('Blade CLI 基本行为', () => {
  it('执行 --help 应该成功并输出帮助信息', () => {
    if (!existsSync(CLI_ENTRY)) {
      console.warn(
        '[cli] dist/blade.js 不存在，跳过 CLI 测试（请先运行 npm run build）'
      );
      return;
    }

    const result = spawnSync('node', [CLI_ENTRY, '--help'], {
      encoding: 'utf-8',
      env: {
        ...process.env,
        BLADE_TELEMETRY_DISABLED: '1',
      },
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    const combinedOutput = `${result.stdout}\n${result.stderr}`;
    expect(combinedOutput.length).toBeGreaterThan(0);
    expect(combinedOutput.toLowerCase()).toContain('blade');
    expect(combinedOutput).toContain('--headless');
    expect(combinedOutput).toContain('browser');
  });

  it('执行 browser --help 应列出显式安装和状态命令', () => {
    if (!existsSync(CLI_ENTRY)) {
      console.warn(
        '[cli] dist/blade.js 不存在，跳过 CLI 测试（请先运行 npm run build）'
      );
      return;
    }

    const result = spawnSync('node', [CLI_ENTRY, 'browser', '--help'], {
      encoding: 'utf-8',
      env: {
        ...process.env,
        BLADE_TELEMETRY_DISABLED: '1',
      },
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    const combinedOutput = `${result.stdout}\n${result.stderr}`;
    expect(combinedOutput).toContain('browser status');
    expect(combinedOutput).toContain('browser install');
  });

  it('执行 --headless /help 应该走 headless 入口并成功退出', () => {
    if (!existsSync(CLI_ENTRY)) {
      console.warn(
        '[cli] dist/blade.js 不存在，跳过 CLI 测试（请先运行 npm run build）'
      );
      return;
    }

    const result = spawnSync('node', [CLI_ENTRY, '--headless', '/help'], {
      encoding: 'utf-8',
      env: {
        ...process.env,
        BLADE_TELEMETRY_DISABLED: '1',
      },
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    const combinedOutput = `${result.stdout}\n${result.stderr}`;
    expect(combinedOutput).toContain('可用的 Slash Commands');
    expect(combinedOutput).toContain('**/help**');
  });

  it('普通参数错误不应默认打印堆栈', () => {
    if (!existsSync(CLI_ENTRY)) {
      console.warn(
        '[cli] dist/blade.js 不存在，跳过 CLI 测试（请先运行 npm run build）'
      );
      return;
    }

    const result = spawnSync('node', [CLI_ENTRY, '--output-format', 'json'], {
      encoding: 'utf-8',
      env: {
        ...process.env,
        BLADE_TELEMETRY_DISABLED: '1',
      },
    });

    expect(result.status).toBe(1);
    const combinedOutput = `${result.stdout}\n${result.stderr}`;
    expect(combinedOutput).toContain(
      '--output-format can only be used with --print or --headless'
    );
    expect(combinedOutput).toContain('Run with --debug to show the stack trace.');
    expect(combinedOutput).not.toContain('Stack trace:');
  });
});
