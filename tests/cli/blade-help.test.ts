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
  });
});
