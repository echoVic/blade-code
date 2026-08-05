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

  function measureCli(args: string[], sampleCount: number): number[] {
    return Array.from({ length: sampleCount }, () => {
      const start = performance.now();
      runCli(args);
      return performance.now() - start;
    });
  }

  function expectMedianBelowBudget(samples: number[], budgetMs: number): void {
    const sorted = [...samples].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    expect(
      median,
      `startup samples: ${samples.map((sample) => sample.toFixed(1)).join(', ')}ms`
    ).toBeLessThan(budgetMs);
  }

  describe('CLI 启动性能', () => {
    it('--version 命令应在 2 秒内完成', () => {
      expectMedianBelowBudget(measureCli(['--version'], 3), 2000);
    });

    it('--help 命令应在 2 秒内完成', () => {
      expectMedianBelowBudget(measureCli(['--help'], 3), 2000);
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

  describe('连续启动', () => {
    it('多次启动的中位数应保持在 2 秒预算内', () => {
      expectMedianBelowBudget(measureCli(['--version'], 5), 2000);
    });
  });
});
