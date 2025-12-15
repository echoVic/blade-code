import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const CLI_ENTRY = path.resolve('dist', 'blade.js');

describe('Blade CLI 版本信息', () => {
  it('--version 应该输出语义化版本号', () => {
    if (!existsSync(CLI_ENTRY)) {
      console.warn(
        '[cli] dist/blade.js 不存在，跳过版本测试（请先执行 npm run build）'
      );
      return;
    }

    const result = spawnSync('node', [CLI_ENTRY, '--version'], {
      encoding: 'utf-8',
      env: {
        ...process.env,
        BLADE_TELEMETRY_DISABLED: '1',
      },
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+(-.+)?$/);
  });
});
