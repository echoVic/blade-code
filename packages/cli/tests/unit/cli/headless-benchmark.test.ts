import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type BenchmarkHistory,
  type BenchmarkVerification,
  collectBenchmarkCaseMetrics,
  compareBenchmarkRuns,
  createBenchmarkWorkspace,
  DEFAULT_REAL_REPO_BENCHMARK_CASES,
  findBenchmarkBaseline,
  readBenchmarkHistory,
  runRealRepoBenchmark,
  summarizeBenchmarkRun,
  verifyBenchmarkWorkspace,
} from '../../../src/commands/headlessBenchmark.js';
import type { HeadlessJsonlEvent } from '../../../src/commands/headlessEvents.js';
import { ConfigManager } from '../../../src/config/ConfigManager.js';
import { DEFAULT_CONFIG } from '../../../src/config/defaults.js';
import { getPiModelCatalog } from '../../../src/services/pi/PiModelCatalog.js';
import { TOOL_CALL_ERROR_CODES } from '../../../src/tools/execution/ToolExecutionResults.js';

vi.unmock('node:child_process');
vi.unmock('child_process');
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});
async function workspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'blade-benchmark-unit-'));
  roots.push(root);
  return root;
}
function toolResult(name: string, target: string): HeadlessJsonlEvent {
  return {
    event_version: 1,
    type: 'tool_result',
    tool_name: name,
    target,
    summary: name,
    success: true,
  };
}
function verification(passed: boolean): BenchmarkVerification {
  return {
    passed,
    changedPaths: [],
    sourceSha256: {},
    checks: { scope: true, behavior: passed, toolEvidence: true },
  };
}

describe('controlled benchmark scoring', () => {
  it('does not score keyword claims as a verified repair', () => {
    const metrics = collectBenchmarkCaseMetrics({
      benchmarkCase: {
        id: 'narrow_fix',
        label: 'repair',
        prompt: 'Fix the implementation.',
      },
      durationMs: 100,
      exitCode: 0,
      events: [
        {
          event_version: 1,
          type: 'content',
          content: 'headless 阶段事件 已修复，测试通过',
        },
      ],
      verification: verification(false),
    });
    expect(metrics.success).toBe(false);
  });
  it('rejects error events even if the process and verifier report success', () => {
    const result = collectBenchmarkCaseMetrics({
      benchmarkCase: { id: 'analysis_only', label: 'analysis', prompt: 'Analyze.' },
      durationMs: 1,
      exitCode: 0,
      events: [{ event_version: 1, type: 'error', message: 'failed' }],
      verification: verification(true),
    });
    expect(result.success).toBe(false);
  });
  it('requires both a successful process and host verification', () => {
    for (const exitCode of [0, 1])
      for (const passed of [false, true]) {
        expect(
          collectBenchmarkCaseMetrics({
            benchmarkCase: { id: 'narrow_fix', label: 'repair', prompt: 'Fix it.' },
            durationMs: 1,
            exitCode,
            events: [],
            verification: verification(passed),
          }).success
        ).toBe(exitCode === 0 && passed);
      }
  });
  it('counts successful reads and retains only verified metrics, not model text', () => {
    const metrics = collectBenchmarkCaseMetrics({
      benchmarkCase: { id: 'analysis_only', label: 'analysis', prompt: 'Analyze.' },
      durationMs: 1280,
      exitCode: 0,
      verification: verification(true),
      events: [
        toolResult('Read', 'src/math.js'),
        toolResult('Read', 'src/math.js'),
        {
          event_version: 1,
          type: 'token_usage',
          input_tokens: 120,
          output_tokens: 40,
          total_tokens: 160,
          max_context_tokens: 200000,
        },
        { event_version: 1, type: 'content', content: 'PRIVATE_MODEL_RESPONSE' },
      ],
    });
    expect(metrics).toMatchObject({
      success: true,
      durationMs: 1280,
      totalTokens: 160,
      readFilesCount: 1,
    });
    expect(JSON.stringify(metrics)).not.toContain('PRIVATE_MODEL_RESPONSE');
    expect(summarizeBenchmarkRun([metrics, { ...metrics, success: false }])).toEqual({
      averageDurationMs: 1280,
      averageReadFilesCount: 1,
      averageTotalTokens: 160,
      averageModelRequests: 1,
      successRate: 0.5,
      toolCallCount: 4,
      failedToolCallRate: 0,
      malformedToolCallRate: 0,
    });
  });
  it('sums usage across model and compaction requests instead of the last request', () => {
    const metrics = collectBenchmarkCaseMetrics({
      benchmarkCase: { id: 'narrow_fix', label: 'repair', prompt: 'Fix it.' },
      durationMs: 1,
      exitCode: 0,
      verification: verification(true),
      events: [160, 220, 40].map((tokens) => ({
        event_version: 1,
        type: 'token_usage',
        input_tokens: tokens - 10,
        output_tokens: 10,
        total_tokens: tokens,
        max_context_tokens: 200000,
      })),
    });
    expect(metrics.totalTokens).toBe(420);
  });
  it('keeps old keyword-scored history intact and rejects mixing scores', async () => {
    const file = path.join(await workspace(), 'history.json');
    const original = '{"version":1,"runs":[]}';
    await writeFile(file, original);
    await expect(readBenchmarkHistory(file)).rejects.toThrow('controlled-coding-v2');
    expect(await readFile(file, 'utf8')).toBe(original);
  });
});

function failedToolResult(
  name: string,
  errorCode?: string,
  errorType = 'validation_error'
): HeadlessJsonlEvent {
  return {
    event_version: 1,
    type: 'tool_result',
    tool_name: name,
    summary: name,
    success: false,
    error_type: errorType,
    ...(errorCode ? { error_code: errorCode } : {}),
  };
}

function usage(
  tokens: number,
  extra: Partial<Extract<HeadlessJsonlEvent, { type: 'token_usage' }>> = {}
): HeadlessJsonlEvent {
  return {
    event_version: 1,
    type: 'token_usage',
    input_tokens: tokens - 10,
    output_tokens: 10,
    total_tokens: tokens,
    max_context_tokens: 200000,
    ...extra,
  };
}

describe('controlled benchmark tool-call quality', () => {
  it('classifies malformed tool calls by their stable error code', () => {
    const metrics = collectBenchmarkCaseMetrics({
      benchmarkCase: { id: 'narrow_fix', label: 'repair', prompt: 'Fix it.' },
      durationMs: 1,
      exitCode: 0,
      verification: verification(true),
      events: [
        failedToolResult('Edit', TOOL_CALL_ERROR_CODES.invalidArguments),
        failedToolResult('Edtt', TOOL_CALL_ERROR_CODES.unknownTool),
        failedToolResult('Edit', TOOL_CALL_ERROR_CODES.invalidParameters),
        failedToolResult('Edit', TOOL_CALL_ERROR_CODES.invalidParameters),
        // A test failure before the repair is task flow, not a malformed call.
        failedToolResult('Bash', undefined, 'execution_error'),
        toolResult('Edit', 'src/math.js'),
        toolResult('Bash', 'npm test'),
      ],
    });
    expect(metrics.toolCalls).toEqual({
      total: 7,
      failed: 5,
      invalidArguments: 1,
      unknownTool: 1,
      invalidParameters: 2,
    });
    const summary = summarizeBenchmarkRun([metrics]);
    expect(summary.toolCallCount).toBe(7);
    expect(summary.failedToolCallRate).toBeCloseTo(5 / 7);
    expect(summary.malformedToolCallRate).toBeCloseTo(4 / 7);
  });

  it('counts only primary model requests and aggregates cache usage and cost', () => {
    const primary = collectBenchmarkCaseMetrics({
      benchmarkCase: { id: 'narrow_fix', label: 'repair', prompt: 'Fix it.' },
      durationMs: 1,
      exitCode: 0,
      verification: verification(true),
      events: [
        usage(1000, { cache_read_tokens: 0, cache_write_tokens: 900, cost_usd: 0.002 }),
        usage(1100, { cache_read_tokens: 900, cache_write_tokens: 0, cost_usd: 0.001 }),
        usage(300, { scope: 'auxiliary', cost_usd: 0.0005 }),
      ],
    });
    expect(primary).toMatchObject({
      totalTokens: 2400,
      modelRequests: 2,
      promptCacheUsage: {
        totalInputTokens: 2370,
        cacheReadTokens: 900,
        cacheWriteTokens: 900,
      },
    });
    expect(primary.costUsd).toBeCloseTo(0.0035);
    const summary = summarizeBenchmarkRun([primary]);
    expect(summary.averageModelRequests).toBe(2);
    expect(summary.promptCacheHitRate).toBeCloseTo(900 / 2370);
    expect(summary.averageCostUsd).toBeCloseTo(0.0035);
  });

  it('reports unknown cost instead of a partial sum and omits unreported cache use', () => {
    const metrics = collectBenchmarkCaseMetrics({
      benchmarkCase: { id: 'narrow_fix', label: 'repair', prompt: 'Fix it.' },
      durationMs: 1,
      exitCode: 0,
      verification: verification(true),
      events: [usage(1000, { cost_usd: 0.002 }), usage(1100)],
    });
    expect(metrics.costUsd).toBeUndefined();
    const summary = summarizeBenchmarkRun([metrics]);
    expect(summary).not.toHaveProperty('averageCostUsd');
    expect(summary).not.toHaveProperty('promptCacheHitRate');
  });
});

const CASE_IDS = DEFAULT_REAL_REPO_BENCHMARK_CASES.map(
  (benchmarkCase) => benchmarkCase.id
);

function historyRun(
  overrides: {
    model?: string;
    timestamp?: string;
    summary?: Record<string, number>;
  } = {}
) {
  return {
    timestamp: overrides.timestamp ?? '2026-10-01T00:00:00.000Z',
    suite: 'controlled-coding-v2' as const,
    model: overrides.model ?? 'test-model',
    summary: {
      averageDurationMs: 9000,
      averageReadFilesCount: 2,
      averageTotalTokens: 10000,
      successRate: 1,
      ...overrides.summary,
    },
    results: CASE_IDS.map((caseId) => ({ caseId, success: true })),
  };
}

function currentRun(
  summary: Record<string, number>,
  failedCase?: (typeof CASE_IDS)[number]
) {
  return {
    summary: {
      averageDurationMs: 9000,
      averageReadFilesCount: 2,
      averageTotalTokens: 10000,
      averageModelRequests: 4,
      successRate: 1,
      toolCallCount: 12,
      failedToolCallRate: 0.1,
      malformedToolCallRate: 0,
      ...summary,
    },
    results: CASE_IDS.map((caseId) => ({ caseId, success: caseId !== failedCase })),
  };
}

describe('controlled benchmark regression comparison', () => {
  it('uses the latest earlier run of the same model and skips unparseable runs', () => {
    const history = {
      version: 2,
      runs: [
        historyRun({ timestamp: '2026-10-01T00:00:00.000Z' }),
        historyRun({ timestamp: '2026-10-02T00:00:00.000Z', model: 'other-model' }),
        { suite: 'controlled-coding-v2', timestamp: '2026-10-03T00:00:00.000Z' },
      ],
    } as BenchmarkHistory;
    expect(findBenchmarkBaseline(history, 'test-model')?.timestamp).toBe(
      '2026-10-01T00:00:00.000Z'
    );
    expect(findBenchmarkBaseline(history, 'missing-model')).toBeUndefined();
  });

  it('compares only metrics the baseline recorded', () => {
    const comparison = compareBenchmarkRuns(
      historyRun(),
      currentRun({ malformedToolCallRate: 0.5 })
    );
    expect(comparison.metrics.map((entry) => entry.metric)).toEqual([
      'successRate',
      'averageTotalTokens',
      'averageDurationMs',
      'averageReadFilesCount',
    ]);
    expect(comparison.regressed).toBe(false);
  });

  it('flags a lost case, any new malformed call, and efficiency beyond tolerance', () => {
    const baseline = historyRun({
      summary: { averageModelRequests: 4, malformedToolCallRate: 0 },
    });
    expect(compareBenchmarkRuns(baseline, currentRun({})).regressed).toBe(false);

    const lostCase = compareBenchmarkRuns(
      baseline,
      currentRun({ successRate: 2 / 3 }, 'narrow_fix')
    );
    expect(lostCase.regressedCases).toEqual(['narrow_fix']);
    expect(lostCase.regressed).toBe(true);

    const malformed = compareBenchmarkRuns(
      baseline,
      currentRun({ malformedToolCallRate: 1 / 12 })
    );
    expect(
      malformed.metrics.find((entry) => entry.metric === 'malformedToolCallRate')
    ).toMatchObject({ baseline: 0, current: 1 / 12, regressed: true });

    const withinTolerance = compareBenchmarkRuns(
      baseline,
      currentRun({ averageTotalTokens: 15000, averageModelRequests: 6 })
    );
    expect(withinTolerance.regressed).toBe(false);
    const beyondTolerance = compareBenchmarkRuns(
      baseline,
      currentRun({ averageTotalTokens: 15001 })
    );
    expect(beyondTolerance.regressed).toBe(true);
  });

  it('reports latency, cache hits, and failed tool calls without gating on them', () => {
    const comparison = compareBenchmarkRuns(
      historyRun({
        summary: { promptCacheHitRate: 0.9, failedToolCallRate: 0 },
      }),
      currentRun({
        averageDurationMs: 90000,
        promptCacheHitRate: 0.1,
        failedToolCallRate: 0.5,
      })
    );
    expect(comparison.metrics.filter((entry) => entry.regressed)).toEqual([]);
    expect(
      comparison.metrics.find((entry) => entry.metric === 'averageDurationMs')
    ).toMatchObject({ baseline: 9000, current: 90000 });
    expect(comparison.regressed).toBe(false);
  });

  it('treats an improvement as a pass', () => {
    const comparison = compareBenchmarkRuns(
      historyRun({ summary: { successRate: 2 / 3 } }),
      currentRun({ averageTotalTokens: 2000 })
    );
    expect(comparison.regressed).toBe(false);
  });
});

describe('controlled benchmark runner', () => {
  it('does not trust a zero-exit CLI that claims success without changing files', async () => {
    const root = await workspace();
    const cliEntry = path.join(root, 'fake-cli.cjs');
    await writeFile(
      cliEntry,
      `process.stdout.write(JSON.stringify({event_version:1,type:'content',content:'headless 阶段事件 all tests passed PRIVATE_BENCHMARK_TEXT'})+'\\n');`
    );
    vi.spyOn(ConfigManager.getInstance(), 'initialize').mockResolvedValue({
      ...DEFAULT_CONFIG,
      currentModelId: 'test-model',
      modelProviders: {},
      models: [{ id: 'test-model', provider: 'deepseek', model: 'deepseek-flash' }],
    });
    vi.spyOn(getPiModelCatalog().models, 'getAuth').mockResolvedValue({
      auth: { apiKey: 'PRIVATE_BENCHMARK_KEY' },
    });
    vi.stubEnv('BLADE_API_KEY', 'PRIVATE_BENCHMARK_KEY');
    const historyPath = path.join(root, 'history.json');
    const result = await runRealRepoBenchmark({ historyPath, cliEntry });
    expect(result.results).toHaveLength(3);
    expect(result.summary.successRate).toBe(0);
    expect(result.results.every((entry) => !entry.verification.passed)).toBe(true);
    expect(result.comparison).toBeUndefined();
    const history = await readFile(historyPath, 'utf8');
    expect(history).not.toContain('PRIVATE_BENCHMARK_TEXT');
    expect(history).not.toContain('PRIVATE_BENCHMARK_KEY');
    expect(JSON.parse(history).runs[0]).toMatchObject({
      model: 'test-model',
      provider: 'deepseek',
      providerModel: 'deepseek-flash',
      bladeVersion: expect.stringMatching(/^\d+\.\d+\.\d+/),
    });

    const rerun = await runRealRepoBenchmark({ historyPath, cliEntry });
    expect(rerun.comparison).toMatchObject({
      baselineTimestamp: JSON.parse(history).runs[0].timestamp,
      regressedCases: [],
      regressed: false,
    });
    expect(JSON.parse(await readFile(historyPath, 'utf8')).runs).toHaveLength(2);
  });
});

describe('controlled benchmark host verification', () => {
  it.each([
    'broken',
    'correct',
    'test-tampering',
    'exit-zero',
    'symlink',
    'no-tool-evidence',
  ] as const)('validates a single-file repair: %s', async (variant) => {
    const root = await workspace();
    const before = await createBenchmarkWorkspace(root, 'narrow_fix');
    if (variant !== 'broken')
      await writeFile(
        path.join(root, 'src/math.js'),
        variant === 'exit-zero'
          ? 'process.exit(0);\nexport function add(a,b){return a-b;}'
          : 'export function add(a,b){return a+b;}'
      );
    if (variant === 'test-tampering')
      await writeFile(path.join(root, 'test/math.test.js'), '');
    if (variant === 'symlink') {
      await rm(path.join(root, 'src/math.js'));
      await symlink(path.join(root, 'package.json'), path.join(root, 'src/math.js'));
    }
    const result = await verifyBenchmarkWorkspace({
      caseId: 'narrow_fix',
      workspace: root,
      before,
      events:
        variant === 'no-tool-evidence'
          ? []
          : [
              toolResult('Edit', path.join(root, 'src/math.js')),
              toolResult('Bash', 'npm test'),
            ],
    });
    expect(result.passed).toBe(variant === 'correct');
  });
  it('rejects adding an empty directory during a read-only diagnosis', async () => {
    const root = await workspace();
    const before = await createBenchmarkWorkspace(root, 'analysis_only');
    await mkdir(path.join(root, 'unexpected'));
    const result = await verifyBenchmarkWorkspace({
      caseId: 'analysis_only',
      workspace: root,
      before,
      events: [
        toolResult('Read', 'src/math.js'),
        {
          event_version: 1,
          type: 'structured_output',
          output: { file: 'src/math.js', export: 'add', operation: 'subtraction' },
          schema_digest: 'a'.repeat(64),
        },
      ],
    });
    expect(result.passed).toBe(false);
  });
  it('bounds a verifier that never returns', async () => {
    const root = await workspace();
    const before = await createBenchmarkWorkspace(root, 'narrow_fix');
    await writeFile(
      path.join(root, 'src/math.js'),
      'export function add(){while(true){}}'
    );
    const result = await verifyBenchmarkWorkspace({
      caseId: 'narrow_fix',
      workspace: root,
      before,
      events: [toolResult('Edit', 'src/math.js'), toolResult('Bash', 'npm test')],
    });
    expect(result.checks.behavior).toBe(false);
    expect(result.passed).toBe(false);
  });
  it('does not accept a test run before the final edit', async () => {
    const root = await workspace();
    const before = await createBenchmarkWorkspace(root, 'narrow_fix');
    await writeFile(
      path.join(root, 'src/math.js'),
      'export function add(a,b){return a+b;}'
    );
    expect(
      (
        await verifyBenchmarkWorkspace({
          caseId: 'narrow_fix',
          workspace: root,
          before,
          events: [toolResult('Bash', 'npm test'), toolResult('Edit', 'src/math.js')],
        })
      ).passed
    ).toBe(false);
  });
  it('does not trust candidate mutations of the assertion library', async () => {
    const root = await workspace();
    const before = await createBenchmarkWorkspace(root, 'narrow_fix');
    await writeFile(
      path.join(root, 'src/math.js'),
      "import assert from 'node:assert/strict'; assert.equal = () => {}; export function add(a,b) { return a-b; }"
    );
    expect(
      (
        await verifyBenchmarkWorkspace({
          caseId: 'narrow_fix',
          workspace: root,
          before,
          events: [toolResult('Edit', 'src/math.js'), toolResult('Bash', 'npm test')],
        })
      ).passed
    ).toBe(false);
  });

  it('requires migration of both the API and its caller', async () => {
    const root = await workspace();
    const before = await createBenchmarkWorkspace(root, 'cross_module_fix');
    const events = [
      toolResult('Edit', 'src/discount.js'),
      toolResult('Edit', 'src/checkout.js'),
      toolResult('Bash', 'npm test'),
    ];
    await writeFile(
      path.join(root, 'src/discount.js'),
      "export function discountPercent(tier){return tier==='pro'?20:tier==='team'?10:0;}\n"
    );
    expect(
      (
        await verifyBenchmarkWorkspace({
          caseId: 'cross_module_fix',
          workspace: root,
          before,
          events,
        })
      ).passed
    ).toBe(false);
    await writeFile(
      path.join(root, 'src/checkout.js'),
      "import { discountPercent } from './discount.js'; export function checkout(amount,tier){return amount*(1-discountPercent(tier)/100);}"
    );
    expect(
      (
        await verifyBenchmarkWorkspace({
          caseId: 'cross_module_fix',
          workspace: root,
          before,
          events,
        })
      ).passed
    ).toBe(true);
  });
  it('accepts equivalent floating-point arithmetic in the migrated caller', async () => {
    const root = await workspace();
    const before = await createBenchmarkWorkspace(root, 'cross_module_fix');
    await writeFile(
      path.join(root, 'src/discount.js'),
      "export function discountPercent(tier){return tier==='pro'?20:tier==='team'?10:0;}\n"
    );
    await writeFile(
      path.join(root, 'src/checkout.js'),
      "import { discountPercent } from './discount.js'; export function checkout(amount,tier){return amount-amount*discountPercent(tier)/100;}\n"
    );
    const result = await verifyBenchmarkWorkspace({
      caseId: 'cross_module_fix',
      workspace: root,
      before,
      events: [
        toolResult('Edit', 'src/discount.js'),
        toolResult('Edit', 'src/checkout.js'),
        toolResult('Bash', 'npm test'),
      ],
    });
    expect(result.passed).toBe(true);
  });
  it('requires read evidence, exact analysis, and unchanged files', async () => {
    const root = await workspace();
    const before = await createBenchmarkWorkspace(root, 'analysis_only');
    const events: HeadlessJsonlEvent[] = [
      toolResult('Read', 'src/math.js'),
      {
        event_version: 1,
        type: 'structured_output',
        output: { file: 'src/math.js', export: 'add', operation: 'subtraction' },
        schema_digest: 'a'.repeat(64),
      },
    ];
    expect(
      (
        await verifyBenchmarkWorkspace({
          caseId: 'analysis_only',
          workspace: root,
          before,
          events,
        })
      ).passed
    ).toBe(true);
    await writeFile(
      path.join(root, 'src/math.js'),
      'export function add(a,b){return a+b;}'
    );
    expect(
      (
        await verifyBenchmarkWorkspace({
          caseId: 'analysis_only',
          workspace: root,
          before,
          events,
        })
      ).passed
    ).toBe(false);
  });
});
