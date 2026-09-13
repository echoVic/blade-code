import { describe, expect, it } from 'vitest';

const shouldRun = process.env.BLADE_RUN_REAL_REPO_BENCHMARK === '1';

describe('受控代码 benchmark', () => {
  it.skipIf(!shouldRun)(
    '通过宿主验证三类任务并记录耗时、累计 token、读取数和成功率',
    async () => {
      const { DEFAULT_REAL_REPO_BENCHMARK_CASES, runRealRepoBenchmark } = await import(
        '../../../src/commands/headlessBenchmark.js'
      );

      const result = await runRealRepoBenchmark();

      expect(result.results).toHaveLength(DEFAULT_REAL_REPO_BENCHMARK_CASES.length);
      expect(result.summary.successRate).toBe(1);
      expect(result.results.every((entry) => entry.verification.passed)).toBe(true);
      expect(result.historyPath).toContain(
        '.blade/benchmarks/controlled-coding-v2-history.json'
      );
      expect(result.results.map((benchmarkCase) => benchmarkCase.caseId)).toEqual([
        'analysis_only',
        'narrow_fix',
        'cross_module_fix',
      ]);
    }
  );
});
