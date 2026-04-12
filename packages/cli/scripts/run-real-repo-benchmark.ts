import {
  DEFAULT_REAL_REPO_BENCHMARK_CASES,
  runRealRepoBenchmark,
} from '../src/commands/headlessBenchmark.js';

function getArgValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

async function main() {
  const model = getArgValue('--model');
  const historyPath = getArgValue('--history-path');
  const result = await runRealRepoBenchmark({ model, historyPath });

  console.log('Real repo benchmark completed.');
  console.log(`History: ${result.historyPath}`);
  for (const benchmarkCase of result.results) {
    console.log(
      [
        `${benchmarkCase.label}`,
        `success=${benchmarkCase.success}`,
        `duration_ms=${benchmarkCase.durationMs.toFixed(1)}`,
        `tokens=${benchmarkCase.totalTokens}`,
        `read_files=${benchmarkCase.readFilesCount}`,
        `blind_search=${benchmarkCase.blindSearchEvents}`,
        `target_hit=${benchmarkCase.targetHitEvents}`,
      ].join(' | ')
    );
  }
  console.log(
    [
      'summary',
      `success_rate=${(result.summary.successRate * 100).toFixed(1)}%`,
      `avg_duration_ms=${result.summary.averageDurationMs.toFixed(1)}`,
      `avg_tokens=${result.summary.averageTotalTokens.toFixed(1)}`,
      `avg_read_files=${result.summary.averageReadFilesCount.toFixed(1)}`,
      `cases=${DEFAULT_REAL_REPO_BENCHMARK_CASES.length}`,
    ].join(' | ')
  );
}

void main();
