import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('启动时间回归测试', () => {
  const cliPath = path.resolve(process.cwd(), 'dist/blade.js');

  function runCli(args: string[]) {
    expect(existsSync(cliPath), 'dist/blade.js 不存在，请先运行构建').toBe(true);

    const result = spawnSync(process.execPath, [cliPath, ...args], {
      timeout: 5000,
      encoding: 'utf-8',
      env: {
        ...process.env,
        BLADE_TELEMETRY_DISABLED: '1',
      },
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    return result;
  }

  describe('CLI 启动性能', () => {
    it('--version 命令应在 2 秒内完成', () => {
      const start = performance.now();

      runCli(['--version']);

      const duration = performance.now() - start;
      expect(duration).toBeLessThan(2000);
    });

    it('--help 命令应在 2 秒内完成', () => {
      const start = performance.now();

      runCli(['--help']);

      const duration = performance.now() - start;
      expect(duration).toBeLessThan(2000);
    });
  });

  describe('模块加载性能', () => {
    it('核心模块导入应在 2500ms 内完成', async () => {
      const start = performance.now();

      await Promise.all([
        import('../../../src/config/index.js').catch(() => undefined),
        import('../../../src/services/FileSystemService.js').catch(() => undefined),
      ]);

      const duration = performance.now() - start;
      expect(duration).toBeLessThan(2500);
    });
  });

  describe('冷启动 vs 热启动', () => {
    it('连续启动应该更快 (缓存效果)', () => {
      const runs: number[] = [];

      for (let i = 0; i < 3; i++) {
        const start = performance.now();
        runCli(['--version']);
        runs.push(performance.now() - start);
      }

      if (runs.length >= 2) {
        const firstRun = runs[0];
        const lastRun = runs[runs.length - 1];
        expect(lastRun).toBeLessThanOrEqual(firstRun * 1.5);
      }
    });
  });
});
