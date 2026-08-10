import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseSchema } from '../schema/index.js';
import { getCwd } from '../utils/cwd.js';
import { runHeadless } from './headless.js';
import type { HeadlessJsonlEvent } from './headlessEvents.js';
import { HeadlessJsonlEventSchema } from './headlessEvents.js';

export interface RealRepoBenchmarkCase {
  id: 'analysis_only' | 'narrow_fix' | 'cross_module_fix';
  label: string;
  prompt: string;
  successMatchers: Array<string | RegExp>;
}

export interface BenchmarkCaseMetrics {
  caseId: RealRepoBenchmarkCase['id'];
  label: string;
  durationMs: number;
  totalTokens: number;
  readFilesCount: number;
  success: boolean;
  exitCode: number;
  blindSearchEvents: number;
  targetHitEvents: number;
  output: string;
}

export interface BenchmarkRunSummary {
  averageDurationMs: number;
  averageReadFilesCount: number;
  averageTotalTokens: number;
  successRate: number;
}

export interface BenchmarkHistoryEntry {
  timestamp: string;
  repoRoot: string;
  model?: string;
  summary: BenchmarkRunSummary;
  results: BenchmarkCaseMetrics[];
}

export interface BenchmarkHistory {
  version: 1;
  runs: BenchmarkHistoryEntry[];
}

export const DEFAULT_REAL_REPO_BENCHMARK_CASES: RealRepoBenchmarkCase[] = [
  {
    id: 'analysis_only',
    label: '只分析',
    prompt:
      '只做分析，不修改代码。请说明 MessageRenderer 如何渲染 heading、nested list、blockquote、table、diff 和 fenced code，并指出关键文件。',
    successMatchers: ['MessageRenderer', 'markdownParser'],
  },
  {
    id: 'narrow_fix',
    label: '窄范围修复',
    prompt:
      '只在 headless 相关模块内完成修复。增强阶段事件，让消费端能区分“仍在搜索”和“已命中目标”，并总结修改文件。',
    successMatchers: ['headless', '阶段事件'],
  },
  {
    id: 'cross_module_fix',
    label: '跨模块修复',
    prompt:
      '允许跨模块修改。为 MessageRenderer 与 ConfirmationPrompt 增加测试覆盖，并在必要时同步调整 headless benchmark 输出，最后总结修改点。',
    successMatchers: ['MessageRenderer', 'ConfirmationPrompt'],
  },
];

export const DEFAULT_BENCHMARK_HISTORY_PATH = path.join(
  getCwd(),
  '.blade',
  'benchmarks',
  'headless-real-repo-history.json'
);

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function matchesSuccess(
  output: string,
  successMatchers: Array<string | RegExp>
): boolean {
  return successMatchers.every((matcher) => {
    if (typeof matcher === 'string') {
      return output.includes(matcher);
    }
    return matcher.test(output);
  });
}

export function collectBenchmarkCaseMetrics(input: {
  benchmarkCase: RealRepoBenchmarkCase;
  durationMs: number;
  exitCode: number;
  events: HeadlessJsonlEvent[];
}): BenchmarkCaseMetrics {
  const { benchmarkCase, durationMs, exitCode, events } = input;
  const totalTokens =
    events
      .filter(
        (event): event is Extract<HeadlessJsonlEvent, { type: 'token_usage' }> =>
          event.type === 'token_usage'
      )
      .at(-1)?.total_tokens ?? 0;

  const readFiles = new Set(
    events
      .filter(
        (
          event
        ): event is Extract<
          HeadlessJsonlEvent,
          { type: 'tool_start' | 'tool_result' }
        > =>
          (event.type === 'tool_start' || event.type === 'tool_result') &&
          event.tool_name === 'Read' &&
          typeof event.target === 'string'
      )
      .map((event) => event.target)
  );

  const output = events
    .filter(
      (
        event
      ): event is Extract<HeadlessJsonlEvent, { type: 'content' | 'content_delta' }> =>
        event.type === 'content' || event.type === 'content_delta'
    )
    .map((event) => (event.type === 'content' ? event.content : event.delta))
    .join('');

  const blindSearchEvents = events.filter(
    (event) =>
      event.type === 'phase' &&
      event.phase === 'searching' &&
      event.status === 'ongoing'
  ).length;

  const targetHitEvents = events.filter(
    (event) =>
      event.type === 'phase' && event.phase === 'target_hit' && event.status === 'hit'
  ).length;

  return {
    caseId: benchmarkCase.id,
    label: benchmarkCase.label,
    durationMs,
    totalTokens,
    readFilesCount: readFiles.size,
    success: exitCode === 0 && matchesSuccess(output, benchmarkCase.successMatchers),
    exitCode,
    blindSearchEvents,
    targetHitEvents,
    output,
  };
}

export function summarizeBenchmarkRun(
  results: BenchmarkCaseMetrics[]
): BenchmarkRunSummary {
  return {
    averageDurationMs: average(results.map((result) => result.durationMs)),
    averageReadFilesCount: average(results.map((result) => result.readFilesCount)),
    averageTotalTokens: average(results.map((result) => result.totalTokens)),
    successRate: average(results.map((result) => (result.success ? 1 : 0))),
  };
}

export async function readBenchmarkHistory(
  historyPath = DEFAULT_BENCHMARK_HISTORY_PATH
): Promise<BenchmarkHistory> {
  try {
    const raw = await readFile(historyPath, 'utf-8');
    const parsed = JSON.parse(raw) as BenchmarkHistory;
    if (parsed.version !== 1 || !Array.isArray(parsed.runs)) {
      return { version: 1, runs: [] };
    }
    return parsed;
  } catch {
    return { version: 1, runs: [] };
  }
}

export async function appendBenchmarkHistory(
  entry: BenchmarkHistoryEntry,
  historyPath = DEFAULT_BENCHMARK_HISTORY_PATH
): Promise<void> {
  const history = await readBenchmarkHistory(historyPath);
  history.runs.push(entry);
  await mkdir(path.dirname(historyPath), { recursive: true });
  await writeFile(historyPath, JSON.stringify(history, null, 2));
}

export async function runRealRepoBenchmark(
  options: {
    benchmarkCases?: RealRepoBenchmarkCase[];
    historyPath?: string;
    model?: string;
  } = {}
): Promise<{
  historyPath: string;
  results: BenchmarkCaseMetrics[];
  summary: BenchmarkRunSummary;
}> {
  const benchmarkCases = options.benchmarkCases ?? DEFAULT_REAL_REPO_BENCHMARK_CASES;
  const historyPath = options.historyPath ?? DEFAULT_BENCHMARK_HISTORY_PATH;
  const results: BenchmarkCaseMetrics[] = [];

  for (const benchmarkCase of benchmarkCases) {
    let stdoutBuffer = '';
    const stdout = {
      write(chunk: string) {
        stdoutBuffer += chunk;
        return true;
      },
    };
    const stderr = {
      write(_chunk: string) {
        return true;
      },
    };

    const start = performance.now();
    const exitCode = await runHeadless(
      {
        headless: true,
        outputFormat: 'jsonl',
        message: benchmarkCase.prompt,
        model: options.model,
      },
      { stdout, stderr }
    );
    const durationMs = performance.now() - start;

    const events = stdoutBuffer
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => parseSchema(HeadlessJsonlEventSchema, JSON.parse(line)));

    results.push(
      collectBenchmarkCaseMetrics({
        benchmarkCase,
        durationMs,
        exitCode,
        events,
      })
    );
  }

  const summary = summarizeBenchmarkRun(results);
  await appendBenchmarkHistory(
    {
      timestamp: new Date().toISOString(),
      repoRoot: getCwd(),
      model: options.model,
      summary,
      results,
    },
    historyPath
  );

  return { historyPath, results, summary };
}
