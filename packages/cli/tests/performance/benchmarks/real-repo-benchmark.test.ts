import { describe, expect, it } from 'vitest';

const shouldRun = process.env.BLADE_RUN_REAL_REPO_BENCHMARK === '1';

describe('真实仓库 benchmark', () => {
  it.skipIf(!shouldRun)(
    '固定三类任务并持续记录耗时、token、读取文件数、成功率',
    async () => {
      const { DEFAULT_REAL_REPO_BENCHMARK_CASES, runRealRepoBenchmark } = await import(
        '../../../src/commands/headlessBenchmark.js'
      );

      const result = await runRealRepoBenchmark();

      expect(result.results).toHaveLength(DEFAULT_REAL_REPO_BENCHMARK_CASES.length);
      expect(result.summary.successRate).toBeGreaterThanOrEqual(0);
      expect(result.summary.successRate).toBeLessThanOrEqual(1);
      expect(result.historyPath).toContain(
        '.blade/benchmarks/headless-real-repo-history.json'
      );
      expect(result.results.map((benchmarkCase) => benchmarkCase.caseId)).toEqual([
        'analysis_only',
        'narrow_fix',
        'cross_module_fix',
      ]);
    }
  );
});
