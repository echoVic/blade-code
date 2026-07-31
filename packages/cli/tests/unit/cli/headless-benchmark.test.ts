import { describe, expect, it } from 'vitest';

describe('headless real repo benchmark helpers', () => {
  it('聚合耗时、token、读取文件数和成功率', async () => {
    const { collectBenchmarkCaseMetrics, summarizeBenchmarkRun } = await import(
      '../../../src/commands/headlessBenchmark.js'
    );

    const metrics = collectBenchmarkCaseMetrics({
      benchmarkCase: {
        id: 'analysis_only',
        label: '只分析',
        prompt: 'Analyze the renderer only.',
        successMatchers: ['MessageRenderer.tsx', /markdownParser/],
      },
      durationMs: 1280,
      exitCode: 0,
      events: [
        {
          event_version: 1,
          type: 'phase',
          phase: 'searching',
          status: 'ongoing',
          message: 'Still searching with Grep',
        },
        {
          event_version: 1,
          type: 'tool_start',
          tool_name: 'Read',
          summary: 'Reading MessageRenderer.tsx',
          target: 'packages/cli/src/ui/components/MessageRenderer.tsx',
        },
        {
          event_version: 1,
          type: 'tool_start',
          tool_name: 'Read',
          summary: 'Reading MessageRenderer.tsx again',
          target: 'packages/cli/src/ui/components/MessageRenderer.tsx',
        },
        {
          event_version: 1,
          type: 'token_usage',
          input_tokens: 120,
          output_tokens: 40,
          total_tokens: 160,
          max_context_tokens: 200000,
        },
        {
          event_version: 1,
          type: 'content',
          content: 'Touched MessageRenderer.tsx and markdownParser.ts',
        },
      ],
    });

    expect(metrics).toEqual(
      expect.objectContaining({
        success: true,
        durationMs: 1280,
        totalTokens: 160,
        readFilesCount: 1,
        blindSearchEvents: 1,
        targetHitEvents: 0,
      })
    );

    const summary = summarizeBenchmarkRun([metrics, { ...metrics, success: false }]);

    expect(summary).toEqual({
      averageDurationMs: 1280,
      averageReadFilesCount: 1,
      averageTotalTokens: 160,
      successRate: 0.5,
    });
  });
});
