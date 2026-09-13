import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConfigManager } from '../config/ConfigManager.js';
import { getPiModelCatalog } from '../services/pi/PiModelCatalog.js';
import { getModelApiKeyEnvironmentVariable } from '../services/pi/resolveModelConfig.js';
import { getCwd } from '../utils/cwd.js';
import {
  finalizeCommandAdmissionGate,
  releaseCommandAdmissionGate,
  spawnCommandAdmissionGate,
} from '../utils/process/CommandAdmissionGate.js';
import { type HeadlessJsonlEvent, HeadlessJsonlEventSchema } from './headlessEvents.js';

export interface RealRepoBenchmarkCase {
  id: 'analysis_only' | 'narrow_fix' | 'cross_module_fix';
  label: string;
  prompt: string;
}

export interface BenchmarkVerification {
  passed: boolean;
  changedPaths: string[];
  sourceSha256: Record<string, string>;
  checks: { scope: boolean; behavior: boolean; toolEvidence: boolean };
}

export interface BenchmarkCaseMetrics {
  caseId: RealRepoBenchmarkCase['id'];
  label: string;
  durationMs: number;
  totalTokens: number;
  readFilesCount: number;
  success: boolean;
  exitCode: number;
  verification: BenchmarkVerification;
}

export interface BenchmarkRunSummary {
  averageDurationMs: number;
  averageReadFilesCount: number;
  averageTotalTokens: number;
  successRate: number;
}

export interface BenchmarkHistoryEntry {
  timestamp: string;
  suite: 'controlled-coding-v2';
  model: string;
  summary: BenchmarkRunSummary;
  results: BenchmarkCaseMetrics[];
}

export interface BenchmarkHistory {
  version: 2;
  runs: BenchmarkHistoryEntry[];
}

export const DEFAULT_REAL_REPO_BENCHMARK_CASES: readonly RealRepoBenchmarkCase[] = [
  {
    id: 'analysis_only',
    label: 'Read-only diagnosis',
    prompt:
      'Read src/math.js. Without modifying any files or running commands, identify its exported function and the arithmetic operation it actually performs. Return the file, export, and operation fields using the required structured output. Use addition or subtraction for the operation.',
  },
  {
    id: 'narrow_fix',
    label: 'Single-file repair',
    prompt:
      'Inspect src/math.js and test/math.test.js. Fix add(left, right) to add both numbers. Modify only src/math.js; do not change tests or package.json or add files. Run exactly npm test after the edit and finish only when it passes.',
  },
  {
    id: 'cross_module_fix',
    label: 'Cross-module migration',
    prompt:
      'Inspect src/discount.js, src/checkout.js, and test/checkout.test.js. Replace discountRate (fractional rates) with discountPercent (whole percentages): pro=20, team=10, others=0. Update checkout to use discountPercent and preserve the discounted total. Modify only src/discount.js and src/checkout.js; do not change tests or package.json or add files. Run exactly npm test after the edits and finish only when it passes.',
  },
];

export const DEFAULT_BENCHMARK_HISTORY_PATH = path.join(
  getCwd(),
  '.blade',
  'benchmarks',
  'controlled-coding-v2-history.json'
);

const ANALYSIS_SCHEMA = {
  type: 'object',
  properties: {
    file: { type: 'string' },
    export: { type: 'string' },
    operation: { type: 'string' },
  },
  required: ['file', 'export', 'operation'],
  additionalProperties: false,
};
const MATH_SOURCE = 'export function add(left, right) { return left - right; }\n';
const DISCOUNT_SOURCE =
  "export function discountRate(tier) { return tier === 'pro' ? 0.2 : tier === 'team' ? 0.1 : 0; }\n";
const CHECKOUT_SOURCE =
  "import { discountRate } from './discount.js';\nexport function checkout(subtotal, tier) { return subtotal * (1 - discountRate(tier)); }\n";
const PACKAGE =
  JSON.stringify({
    name: 'blade-controlled-benchmark',
    private: true,
    type: 'module',
    scripts: { test: 'node --test' },
  }) + '\n';

export type BenchmarkSnapshot = Map<string, Buffer>;

export async function createBenchmarkWorkspace(
  workspace: string,
  caseId: RealRepoBenchmarkCase['id']
): Promise<BenchmarkSnapshot> {
  const files: Record<string, string> = {
    'package.json': PACKAGE,
    ...(caseId === 'cross_module_fix'
      ? {
          'src/discount.js': DISCOUNT_SOURCE,
          'src/checkout.js': CHECKOUT_SOURCE,
          'test/checkout.test.js':
            "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { discountPercent } from '../src/discount.js';\nimport { checkout } from '../src/checkout.js';\ntest('percentage API and caller', () => { assert.equal(discountPercent('pro'), 20); assert.equal(discountPercent('team'), 10); assert.equal(checkout(100, 'pro'), 80); assert.equal(checkout(100, 'team'), 90); });\n",
        }
      : {
          'src/math.js': MATH_SOURCE,
          'test/math.test.js':
            "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/math.js';\ntest('adds numbers', () => { assert.equal(add(4, 3), 7); assert.equal(add(-2, 3), 1); });\n",
        }),
  };
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(workspace, name);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, content, { mode: 0o600 });
  }
  return snapshotBenchmarkWorkspace(workspace);
}

export async function snapshotBenchmarkWorkspace(
  workspace: string
): Promise<BenchmarkSnapshot> {
  const snapshot: BenchmarkSnapshot = new Map();
  let bytes = 0;
  let entries = 0;
  const visit = async (relative: string): Promise<void> => {
    for (const name of await readdir(path.join(workspace, relative))) {
      if (++entries > 128)
        throw new Error('Benchmark workspace exceeds its file limit');
      const key = relative ? `${relative}/${name}` : name;
      const absolute = path.join(workspace, key);
      const info = await lstat(absolute);
      if (info.isSymbolicLink())
        throw new Error('Benchmark workspace contains a symbolic link');
      if (info.isDirectory()) {
        snapshot.set(`${key}/`, Buffer.alloc(0));
        await visit(key);
      } else {
        if (!info.isFile() || info.nlink !== 1 || info.size > 128 * 1024)
          throw new Error('Benchmark workspace contains an unsupported file');
        bytes += info.size;
        if (bytes > 1024 * 1024)
          throw new Error('Benchmark workspace exceeds its byte limit');
        snapshot.set(key, await readFile(absolute));
      }
    }
  };
  await visit('');
  return snapshot;
}

function nodeExecutable(): string {
  return execFileSync('node', ['-p', 'process.execPath'], {
    encoding: 'utf8',
    timeout: 5_000,
    env: { PATH: process.env.PATH },
  }).trim();
}

async function runBenchmarkCommand(input: {
  node: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
  stdin?: string;
}): Promise<{ exitCode: number; stdout: string }> {
  if (input.signal?.aborted) throw new Error('Benchmark cancelled');
  const { child, processTree } = spawnCommandAdmissionGate(input.node, input.args, {
    cwd: input.cwd,
    env: input.env,
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const chunks: Buffer[] = [];
  let bytes = 0;
  let failed = false;
  let termination: ReturnType<typeof processTree.terminate> | undefined;
  const stop = () => {
    failed = true;
    termination ??= processTree.terminate();
  };
  const settled = new Promise<number>((resolve, reject) => {
    child.once('error', () => reject(new Error('Benchmark command could not start')));
    child.once('close', (code) => resolve(code ?? 1));
  });
  child.stdout?.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes <= 4 * 1024 * 1024) chunks.push(chunk);
    else stop();
  });
  const timer = setTimeout(stop, input.timeoutMs);
  input.signal?.addEventListener('abort', stop, { once: true });
  try {
    if (input.signal?.aborted) stop();
    if (!failed) {
      await releaseCommandAdmissionGate(child);
      child.stdin?.end(input.stdin ?? '');
    }
    const exitCode = await settled;
    if (termination) await termination;
    const finalized = await finalizeCommandAdmissionGate(child, processTree);
    if (!finalized.success) throw new Error('Benchmark process cleanup failed');
    return {
      exitCode: failed ? 1 : exitCode,
      stdout: Buffer.concat(chunks).toString('utf8'),
    };
  } catch {
    stop();
    await termination;
    await settled.catch(() => undefined);
    throw new Error('Benchmark command failed');
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener('abort', stop);
  }
}

async function verifyBehavior(
  caseId: RealRepoBenchmarkCase['id'],
  snapshot: BenchmarkSnapshot,
  node: string
): Promise<boolean> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'blade-benchmark-check-'));
  try {
    await writeFile(path.join(root, 'package.json'), '{"type":"module"}\n', {
      mode: 0o600,
    });
    for (const name of caseId === 'cross_module_fix'
      ? ['discount.js', 'checkout.js']
      : ['math.js']) {
      const content = snapshot.get(`src/${name}`);
      if (!content) return false;
      await writeFile(path.join(root, name), content, { mode: 0o600 });
    }
    const marker = randomUUID();
    const evaluation =
      caseId === 'cross_module_fix'
        ? "const discount = await import('./discount.js'); const { checkout } = await import('./checkout.js'); const values = [discount.discountPercent('pro'), discount.discountPercent('team'), discount.discountPercent('none'), checkout(0,'pro'), checkout(17,'pro'), checkout(100,'team'), checkout(203.5,'none'), 'discountRate' in discount];"
        : "const { add } = await import('./math.js'); const values = [add(0,0), add(4,3), add(-2,3), add(10,-7), add(1.25,2.75)];";
    const expected =
      caseId === 'cross_module_fix'
        ? [20, 10, 0, 0, 17 * 0.8, 90, 203.5, false]
        : [0, 7, 1, 3, 4];
    const result = await runBenchmarkCommand({
      node,
      args: ['--input-type=module'],
      cwd: root,
      env: {
        PATH: process.env.PATH,
        HOME: root,
        TMPDIR: root,
        SystemRoot: process.env.SystemRoot,
      },
      timeoutMs: 5_000,
      stdin: `const write = process.stdout.write.bind(process.stdout); const encode = JSON.stringify;\n${evaluation}\nwrite(encode({ marker: ${JSON.stringify(marker)}, values }));\n`,
    });
    if (result.exitCode !== 0) return false;
    let output: unknown;
    try {
      output = JSON.parse(result.stdout);
    } catch {
      return false;
    }
    if (
      !output ||
      typeof output !== 'object' ||
      !('marker' in output) ||
      output.marker !== marker ||
      !('values' in output) ||
      !Array.isArray(output.values) ||
      output.values.length !== expected.length
    )
      return false;
    const values: unknown[] = output.values;
    return expected.every((value, index) => {
      const actual = values[index];
      return typeof value === 'number'
        ? typeof actual === 'number' &&
            Number.isFinite(actual) &&
            Math.abs(actual - value) <= 1e-9
        : actual === value;
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export async function verifyBenchmarkWorkspace(input: {
  caseId: RealRepoBenchmarkCase['id'];
  workspace: string;
  before: BenchmarkSnapshot;
  events: readonly HeadlessJsonlEvent[];
}): Promise<BenchmarkVerification> {
  const checks = { scope: false, behavior: false, toolEvidence: false };
  let after: BenchmarkSnapshot;
  try {
    after = await snapshotBenchmarkWorkspace(input.workspace);
  } catch {
    return { passed: false, changedPaths: [], sourceSha256: {}, checks };
  }
  const changedPaths = [...new Set([...input.before.keys(), ...after.keys()])]
    .filter(
      (name) =>
        !input.before.has(name) ||
        !after.has(name) ||
        !input.before.get(name)!.equals(after.get(name)!)
    )
    .sort();
  const expected =
    input.caseId === 'analysis_only'
      ? []
      : input.caseId === 'narrow_fix'
        ? ['src/math.js']
        : ['src/checkout.js', 'src/discount.js'];
  checks.scope = JSON.stringify(changedPaths) === JSON.stringify(expected);
  const sourceSha256 = Object.fromEntries(
    [...after]
      .filter(([name]) => name.startsWith('src/') && !name.endsWith('/'))
      .map(([name, content]) => [
        name,
        createHash('sha256').update(content).digest('hex'),
      ])
  );
  const results = input.events.filter(
    (event) => event.type === 'tool_result' && event.success === true
  );
  if (input.caseId === 'analysis_only') {
    const outputs = input.events.filter((event) => event.type === 'structured_output');
    checks.behavior =
      outputs.length === 1 &&
      outputs[0].output.file === 'src/math.js' &&
      outputs[0].output.export === 'add' &&
      outputs[0].output.operation === 'subtraction';
    checks.toolEvidence = results.some(
      (event) =>
        event.type === 'tool_result' &&
        event.tool_name === 'Read' &&
        path.resolve(input.workspace, event.target ?? '') ===
          path.join(input.workspace, 'src/math.js')
    );
  } else {
    const lastMutation = input.events.findLastIndex(
      (event) =>
        event.type === 'tool_result' && ['Edit', 'Write'].includes(event.tool_name)
    );
    checks.toolEvidence =
      input.events.some(
        (event, index) =>
          index > lastMutation &&
          event.type === 'tool_result' &&
          event.success === true &&
          event.tool_name === 'Bash' &&
          event.target === 'npm test'
      ) &&
      expected.every((name) =>
        results.some(
          (event) =>
            event.type === 'tool_result' &&
            ['Edit', 'Write'].includes(event.tool_name) &&
            path.resolve(input.workspace, event.target ?? '') ===
              path.join(input.workspace, name)
        )
      );
    if (checks.scope)
      checks.behavior = await verifyBehavior(input.caseId, after, nodeExecutable());
  }
  return {
    passed: Object.values(checks).every(Boolean),
    changedPaths,
    sourceSha256,
    checks,
  };
}

function average(values: number[]): number {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0;
}

export function collectBenchmarkCaseMetrics(input: {
  benchmarkCase: RealRepoBenchmarkCase;
  durationMs: number;
  exitCode: number;
  events: HeadlessJsonlEvent[];
  verification: BenchmarkVerification;
}): BenchmarkCaseMetrics {
  const { benchmarkCase, durationMs, exitCode, events, verification } = input;
  const totalTokens = events.reduce(
    (total, event) => total + (event.type === 'token_usage' ? event.total_tokens : 0),
    0
  );
  const readFiles = new Set(
    events
      .filter(
        (event) =>
          event.type === 'tool_result' &&
          event.tool_name === 'Read' &&
          event.success === true &&
          event.target
      )
      .map((event) => (event.type === 'tool_result' ? event.target : undefined))
  );
  return {
    caseId: benchmarkCase.id,
    label: benchmarkCase.label,
    durationMs,
    totalTokens,
    readFilesCount: readFiles.size,
    success:
      exitCode === 0 &&
      !events.some((event) => event.type === 'error') &&
      verification.passed &&
      Object.values(verification.checks).every(Boolean),
    exitCode,
    verification,
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
  let raw: string;
  try {
    raw = await readFile(historyPath, 'utf8');
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    )
      return { version: 2, runs: [] };
    throw error;
  }
  const parsed = JSON.parse(raw) as BenchmarkHistory;
  if (
    parsed.version !== 2 ||
    !Array.isArray(parsed.runs) ||
    parsed.runs.some((run) => run.suite !== 'controlled-coding-v2')
  )
    throw new Error(
      'Benchmark history is not controlled-coding-v2; choose a new history path'
    );
  return parsed;
}

export async function appendBenchmarkHistory(
  entry: BenchmarkHistoryEntry,
  historyPath = DEFAULT_BENCHMARK_HISTORY_PATH
): Promise<void> {
  const history = await readBenchmarkHistory(historyPath);
  history.runs.push(entry);
  await mkdir(path.dirname(historyPath), { recursive: true, mode: 0o700 });
  await writeFile(historyPath, JSON.stringify(history, null, 2) + '\n', {
    mode: 0o600,
  });
}

export async function runRealRepoBenchmark(
  options: { historyPath?: string; model?: string; cliEntry?: string } = {}
): Promise<{
  historyPath: string;
  results: BenchmarkCaseMetrics[];
  summary: BenchmarkRunSummary;
}> {
  const historyPath = options.historyPath ?? DEFAULT_BENCHMARK_HISTORY_PATH;
  await readBenchmarkHistory(historyPath);
  const cliEntry =
    options.cliEntry ?? path.resolve(import.meta.dirname, '../../dist/blade.js');
  await access(cliEntry);
  const config = await ConfigManager.getInstance().initialize();
  const requested = options.model ?? config.currentModelId;
  const selected = config.models.find(
    (model) => model.id === requested || model.model === requested
  );
  if (!selected) throw new Error('Benchmark model is not configured');
  const catalog = getPiModelCatalog();
  const auth = await catalog.models.getAuth(catalog.resolveConfig(selected));
  const apiKey =
    process.env[getModelApiKeyEnvironmentVariable(selected.id)] ??
    process.env.BLADE_API_KEY ??
    auth?.auth.apiKey;
  if (!apiKey)
    throw new Error('Benchmark requires configured API-key model authentication');
  const node = nodeExecutable();
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  const results: BenchmarkCaseMetrics[] = [];
  try {
    for (const benchmarkCase of DEFAULT_REAL_REPO_BENCHMARK_CASES) {
      if (controller.signal.aborted) throw new Error('Benchmark cancelled');
      const root = await realpath(
        await mkdtemp(path.join(os.tmpdir(), 'blade-controlled-benchmark-'))
      );
      try {
        const workspace = path.join(root, 'workspace');
        const home = path.join(root, 'home');
        const storage = path.join(home, '.blade');
        await mkdir(storage, { recursive: true, mode: 0o700 });
        const before = await createBenchmarkWorkspace(workspace, benchmarkCase.id);
        if (
          benchmarkCase.id !== 'analysis_only' &&
          (await verifyBehavior(benchmarkCase.id, before, node))
        )
          throw new Error('Benchmark fixture unexpectedly passed before repair');
        await writeFile(
          path.join(storage, 'config.json'),
          JSON.stringify({
            currentModelId: selected.id,
            models: [
              {
                ...selected,
                fallbackModels: [],
                overrides: {
                  ...selected.overrides,
                  baseUrl:
                    process.env.BLADE_BASE_URL ??
                    selected.overrides?.baseUrl ??
                    auth?.auth.baseUrl,
                  customHeaders: {
                    ...selected.overrides?.customHeaders,
                    ...auth?.auth.headers,
                  },
                  maxRetries: 0,
                  maxOutputTokens: selected.overrides?.maxOutputTokens ?? 4096,
                  timeout: 120_000,
                  streamIdleTimeout: 120_000,
                },
              },
            ],
            modelProviders: config.modelProviders,
            maxTurns: 16,
            hooks: { enabled: false },
            disableAllHooks: true,
            mcpServers: {},
            lspServers: {},
            enabledPlugins: {},
            providerForegroundRecoveryMs: 0,
          }),
          { mode: 0o600 }
        );
        const started = performance.now();
        const command = await runBenchmarkCommand({
          node,
          cwd: workspace,
          env: {
            PATH: process.env.PATH,
            HOME: home,
            USERPROFILE: home,
            TMPDIR: root,
            TEMP: root,
            TMP: root,
            SystemRoot: process.env.SystemRoot,
            BLADE_STORAGE_ROOT: storage,
            BLADE_API_KEY: apiKey,
            BLADE_AUTO_MEMORY: '0',
            BLADE_TELEMETRY_DISABLED: '1',
            BLADE_VERSION: '999.0.0',
          },
          args: [
            cliEntry,
            '--headless',
            '--output-format',
            'jsonl',
            '--trust-workspace',
            '--permission-mode',
            'yolo',
            '--max-turns',
            '16',
            '--no-verification-agent',
            '--allowed-tools',
            benchmarkCase.id === 'analysis_only'
              ? 'Read,Glob,Grep'
              : 'Read,Glob,Grep,Edit,Write,Bash',
            ...(benchmarkCase.id === 'analysis_only'
              ? ['--json-schema', JSON.stringify(ANALYSIS_SCHEMA)]
              : []),
            '--',
            benchmarkCase.prompt,
          ],
          timeoutMs: 240_000,
          signal: controller.signal,
        });
        const durationMs = performance.now() - started;
        const events: HeadlessJsonlEvent[] = [];
        let validEvents = true;
        for (const line of command.stdout.split('\n').filter((value) => value.trim())) {
          try {
            events.push(HeadlessJsonlEventSchema.parse(JSON.parse(line)));
          } catch {
            validEvents = false;
          }
        }
        const verification = await verifyBenchmarkWorkspace({
          caseId: benchmarkCase.id,
          workspace,
          before,
          events,
        });
        results.push(
          collectBenchmarkCaseMetrics({
            benchmarkCase,
            durationMs,
            exitCode: validEvents ? command.exitCode : 1,
            events,
            verification,
          })
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
    if (controller.signal.aborted) throw new Error('Benchmark cancelled');
    const summary = summarizeBenchmarkRun(results);
    await appendBenchmarkHistory(
      {
        timestamp: new Date().toISOString(),
        suite: 'controlled-coding-v2',
        model: selected.id,
        summary,
        results,
      },
      historyPath
    );
    return { historyPath, results, summary };
  } finally {
    process.off('SIGINT', abort);
    process.off('SIGTERM', abort);
  }
}
