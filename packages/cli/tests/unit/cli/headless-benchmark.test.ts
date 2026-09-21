import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  collectBenchmarkCaseMetrics,
  createBenchmarkWorkspace,
  readBenchmarkHistory,
  runRealRepoBenchmark,
  summarizeBenchmarkRun,
  verifyBenchmarkWorkspace,
  type BenchmarkVerification,
} from '../../../src/commands/headlessBenchmark.js';
import type { HeadlessJsonlEvent } from '../../../src/commands/headlessEvents.js';
import { ConfigManager } from '../../../src/config/ConfigManager.js';
import { DEFAULT_CONFIG } from '../../../src/config/defaults.js';
import { getPiModelCatalog } from '../../../src/services/pi/PiModelCatalog.js';

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
      successRate: 0.5,
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
    const history = await readFile(historyPath, 'utf8');
    expect(history).not.toContain('PRIVATE_BENCHMARK_TEXT');
    expect(history).not.toContain('PRIVATE_BENCHMARK_KEY');
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
