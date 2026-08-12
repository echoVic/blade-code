import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('启动时间回归测试', () => {
  const cliPath = path.resolve(process.cwd(), 'dist/blade.js');

  function runCli(args: string[]): number {
    expect(existsSync(cliPath), 'dist/blade.js 不存在，请先运行构建').toBe(true);

    const start = performance.now();
    const result = spawnSync(process.execPath, [cliPath, ...args], {
      timeout: 30_000,
      encoding: 'utf-8',
      env: {
        ...process.env,
        BLADE_TELEMETRY_DISABLED: '1',
      },
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout.trim().length).toBeGreaterThan(0);
    return performance.now() - start;
  }

  function measureCli(args: string[], sampleCount: number): number[] {
    return Array.from({ length: sampleCount }, () => runCli(args));
  }

  function median(samples: number[]): number {
    const sorted = [...samples].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  describe('CLI 启动性能', () => {
    it('预热后各入口保持相对稳定', () => {
      runCli(['--version']);
      runCli(['--help']);

      const versionSamples = measureCli(['--version'], 3);
      const helpSamples = measureCli(['--help'], 3);
      const versionMedian = median(versionSamples);
      const helpMedian = median(helpSamples);
      const versionSpread = Math.max(...versionSamples) / versionMedian;

      console.info(
        JSON.stringify({
          versionSamples,
          helpSamples,
          helpToVersionRatio: helpMedian / versionMedian,
          versionSpread,
        })
      );

      expect(helpMedian / versionMedian).toBeLessThan(5);
      expect(versionSpread).toBeLessThan(6);
    }, 180_000);
  });

  describe('模块加载性能', () => {
    it('核心模块可以完成冷导入并记录耗时', async () => {
      const start = performance.now();

      const modules = await Promise.all([
        import('../../../src/config/index.js'),
        import('../../../src/services/FileSystemService.js'),
      ]);

      const duration = performance.now() - start;
      console.info(JSON.stringify({ coldModuleImportMs: duration }));
      expect(modules).toHaveLength(2);
    });
  });
});
