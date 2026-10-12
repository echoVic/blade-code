import {
  type BenchmarkComparedMetric,
  DEFAULT_REAL_REPO_BENCHMARK_CASES,
  runRealRepoBenchmark,
} from '../src/commands/headlessBenchmark.js';

function getArgValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

const RATE_METRICS = new Set<BenchmarkComparedMetric>([
  'successRate',
  'promptCacheHitRate',
  'failedToolCallRate',
  'malformedToolCallRate',
]);

function formatMetric(metric: BenchmarkComparedMetric, value: number): string {
  if (RATE_METRICS.has(metric)) return `${(value * 100).toFixed(1)}%`;
  if (metric === 'averageCostUsd') return `$${value.toFixed(6)}`;
  return value.toFixed(1);
}

async function main() {
  const model = getArgValue('--model');
  const historyPath = getArgValue('--history-path');
  const result = await runRealRepoBenchmark({ model, historyPath });

  console.log('Controlled coding benchmark v2 completed (not a real-repository score).');
  console.log(`History: ${result.historyPath}`);
  for (const benchmarkCase of result.results) {
    const { toolCalls } = benchmarkCase;
    console.log(
      [
        `${benchmarkCase.label}`,
        `success=${benchmarkCase.success}`,
        `duration_ms=${benchmarkCase.durationMs.toFixed(1)}`,
        `tokens=${benchmarkCase.totalTokens}`,
        `model_requests=${benchmarkCase.modelRequests}`,
        `read_files=${benchmarkCase.readFilesCount}`,
        `tool_calls=${toolCalls.total}`,
        `failed_tool_calls=${toolCalls.failed}`,
        `invalid_arguments=${toolCalls.invalidArguments}`,
        `unknown_tool=${toolCalls.unknownTool}`,
        `invalid_parameters=${toolCalls.invalidParameters}`,
        `host_verified=${benchmarkCase.verification.passed}`,
        `changed_files=${benchmarkCase.verification.changedPaths.join(',')}`,
      ].join(' | ')
    );
  }
  const { summary } = result;
  console.log(
    [
      'summary',
      `success_rate=${formatMetric('successRate', summary.successRate)}`,
      `avg_duration_ms=${formatMetric('averageDurationMs', summary.averageDurationMs)}`,
      `avg_tokens=${formatMetric('averageTotalTokens', summary.averageTotalTokens)}`,
      `avg_model_requests=${formatMetric('averageModelRequests', summary.averageModelRequests)}`,
      `avg_cost=${summary.averageCostUsd === undefined ? 'unknown' : formatMetric('averageCostUsd', summary.averageCostUsd)}`,
      `cache_hit_rate=${summary.promptCacheHitRate === undefined ? 'unreported' : formatMetric('promptCacheHitRate', summary.promptCacheHitRate)}`,
      `avg_read_files=${formatMetric('averageReadFilesCount', summary.averageReadFilesCount)}`,
      `tool_calls=${summary.toolCallCount}`,
      `failed_tool_call_rate=${formatMetric('failedToolCallRate', summary.failedToolCallRate)}`,
      `malformed_tool_call_rate=${formatMetric('malformedToolCallRate', summary.malformedToolCallRate)}`,
      `cases=${DEFAULT_REAL_REPO_BENCHMARK_CASES.length}`,
    ].join(' | ')
  );

  const { comparison } = result;
  if (!comparison) {
    console.log('baseline: none (first recorded run for this model)');
  } else {
    console.log(
      [
        `baseline: ${comparison.baselineTimestamp}`,
        ...(comparison.baselineBladeVersion
          ? [`blade=${comparison.baselineBladeVersion}`]
          : []),
        ...(comparison.baselineProviderModel
          ? [`provider_model=${comparison.baselineProviderModel}`]
          : []),
      ].join(' | ')
    );
    for (const entry of comparison.metrics) {
      console.log(
        `  ${entry.regressed ? 'REGRESSED' : 'ok'} ${entry.metric}: ${formatMetric(entry.metric, entry.baseline)} -> ${formatMetric(entry.metric, entry.current)}`
      );
    }
    if (comparison.regressedCases.length > 0)
      console.log(`  REGRESSED cases: ${comparison.regressedCases.join(', ')}`);
    console.log(`regression=${comparison.regressed}`);
  }
  if (
    result.results.some((benchmarkCase) => !benchmarkCase.success) ||
    comparison?.regressed
  )
    process.exitCode = 1;
}

void main().catch(() => {
  console.error('Controlled benchmark failed; no successful score was issued.');
  process.exitCode = 1;
});
