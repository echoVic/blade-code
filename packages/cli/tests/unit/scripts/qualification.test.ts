import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createQualificationPlan,
  resolveProductionEnvironment,
  resolveQualificationCheckEnvironment,
  resolveQualificationRoot,
  runQualification,
} from '../../../scripts/qualification.js';
import {
  assertTuiTaskAttentionRunnerOutputSafe,
  awaitTuiTaskAttentionSettlement,
  createTuiTaskAttentionSecretScanner,
  createTuiTaskAttentionStreamCapture,
  sanitizeTuiTaskAttentionError,
} from '../../support/tuiTaskAttentionPtyDriver.js';

describe('production qualification contract', () => {
  const workflowsDirectory = path.resolve(
    __dirname,
    '../../../../../.github/workflows'
  );
  const ciWorkflowPath = path.join(workflowsDirectory, 'ci.yml');
  const packagePath = path.resolve(__dirname, '../../../package.json');
  const qualificationScript = path.resolve(__dirname, '../../../scripts/qualify.ts');
  const qualificationCore = path.resolve(
    __dirname,
    '../../../scripts/qualification.ts'
  );

  it('exposes separate local and production qualification commands', () => {
    const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8')) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.['qualify:local']).toBe(
      'node scripts/run-bun.js run scripts/qualify.ts local'
    );
    expect(packageJson.scripts?.['qualify:production']).toBe(
      'node scripts/run-bun.js run scripts/qualify.ts production'
    );
    expect(packageJson.scripts?.['test:real-api:qualification']).toBe(
      'node scripts/test.js realApiQualification'
    );
    expect(packageJson.scripts?.['browser:install']).toBe(
      'playwright install chromium'
    );
    expect(packageJson.scripts?.['browser:check']).toBe(
      'node scripts/run-bun.js run scripts/browser-check.ts'
    );
    expect(packageJson.scripts?.ready).toBe(
      'node scripts/run-bun.js run scripts/qualify.ts production'
    );
    expect(fs.existsSync(qualificationScript)).toBe(true);
  });

  it('installs the pinned Chromium runtime before coverage integration tests', () => {
    const workflow = fs.readFileSync(ciWorkflowPath, 'utf8');
    const coverageStart = workflow.indexOf('\n  coverage:');
    const coverageEnd = workflow.indexOf('\n  ci-pass:', coverageStart);
    const coverageJob = workflow.slice(coverageStart, coverageEnd);
    const installIndex = coverageJob.indexOf(
      'run: bunx playwright install --with-deps chromium'
    );
    const sandboxIndex = coverageJob.indexOf(
      'CHROME_DEVEL_SANDBOX=/usr/local/sbin/chrome-devel-sandbox'
    );
    const browserCheckIndex = coverageJob.indexOf(
      'run: bun run --filter blade-code browser:check'
    );
    const testIndex = coverageJob.indexOf(
      'run: bun run --filter blade-code test:coverage'
    );

    expect(coverageStart).toBeGreaterThanOrEqual(0);
    expect(coverageEnd).toBeGreaterThan(coverageStart);
    expect(coverageJob).toContain('path: ~/.cache/ms-playwright');
    expect(installIndex).toBeGreaterThanOrEqual(0);
    expect(sandboxIndex).toBeGreaterThan(installIndex);
    expect(browserCheckIndex).toBeGreaterThan(sandboxIndex);
    expect(testIndex).toBeGreaterThan(browserCheckIndex);
  });

  it('keeps the complete cache action inventory on the Node 24 runtime', () => {
    const cacheReferences = fs
      .readdirSync(workflowsDirectory)
      .filter((fileName) => /\.ya?ml$/.test(fileName))
      .sort()
      .flatMap((fileName) => {
        const workflow = fs.readFileSync(
          path.join(workflowsDirectory, fileName),
          'utf8'
        );

        return (workflow.match(/actions\/cache@[^\s#]+/g) ?? []).map(
          (reference) => `${fileName}:${reference}`
        );
      });

    expect(cacheReferences).toEqual(
      Array.from({ length: 6 }, () => 'ci.yml:actions/cache@v6')
    );
  });

  it('keeps coverage publishing actions on Node 24-compatible releases', () => {
    const actionReferences = fs
      .readdirSync(workflowsDirectory)
      .filter((fileName) => /\.ya?ml$/.test(fileName))
      .sort()
      .flatMap((fileName) => {
        const workflow = fs.readFileSync(
          path.join(workflowsDirectory, fileName),
          'utf8'
        );

        return (
          workflow.match(
            /(?:actions\/upload-artifact|codecov\/codecov-action)@[^\s#]+/g
          ) ?? []
        ).map((reference) => `${fileName}:${reference}`);
      });

    expect(actionReferences).toEqual([
      'ci.yml:codecov/codecov-action@v7',
      'ci.yml:actions/upload-artifact@v7',
    ]);
  });

  it('keeps qualification policy in an independently testable module', () => {
    expect(fs.existsSync(qualificationCore)).toBe(true);
  });

  it('registers the production Chromium durable task unread trajectory', () => {
    const testConfig = fs.readFileSync(
      path.resolve(__dirname, '../../../scripts/test-config.js'),
      'utf8'
    );
    const trajectory = fs.readFileSync(
      path.resolve(
        __dirname,
        '../../integration/real-api/durable-task-unread-trajectory.test.ts'
      ),
      'utf8'
    );
    const driver = fs.readFileSync(
      path.resolve(__dirname, '../../support/durableTaskUnreadWebDriver.ts'),
      'utf8'
    );

    expect(testConfig).toContain(
      "'tests/integration/real-api/durable-task-unread-trajectory.test.ts'"
    );
    expect(trajectory).toContain('resolveRequiredDeepSeekQualificationModels');
    expect(trajectory).toContain("process.env.REAL_API_RELEASE_MATRIX !== '1'");
    expect(trajectory).toContain('maxRetries: 0');
    expect(driver).toContain('../../dist/blade.js');
    expect(driver).toContain('await chromium.launch({ headless: true })');
  });

  it('registers the production raw PTY durable task attention trajectory', () => {
    const testConfig = fs.readFileSync(
      path.resolve(__dirname, '../../../scripts/test-config.js'),
      'utf8'
    );
    const trajectoryPath = path.resolve(
      __dirname,
      '../../integration/real-api/tui-task-attention-trajectory.test.ts'
    );
    const deterministicPath = path.resolve(
      __dirname,
      '../../integration/tui-task-attention.test.ts'
    );
    const driverPath = path.resolve(
      __dirname,
      '../../support/tuiTaskAttentionPtyDriver.ts'
    );
    const runnerPath = path.resolve(
      __dirname,
      '../../support/tuiTaskAttentionPtyRunner.ts'
    );
    const trajectory = fs.readFileSync(trajectoryPath, 'utf8');
    const deterministic = fs.readFileSync(deterministicPath, 'utf8');
    const driver = fs.readFileSync(driverPath, 'utf8');
    const runner = fs.readFileSync(runnerPath, 'utf8');

    expect(testConfig).toContain(
      "'tests/integration/real-api/tui-task-attention-trajectory.test.ts'"
    );
    expect(fs.existsSync(trajectoryPath)).toBe(true);
    expect(fs.existsSync(driverPath)).toBe(true);
    expect(fs.existsSync(runnerPath)).toBe(true);
    expect(trajectory).toContain('resolveRequiredDeepSeekQualificationModels');
    expect(trajectory).toContain('frameworkRetryBudget(context)');
    expect(trajectory).toContain('configured.overrides?.maxRetries');
    expect(trajectory).toContain("process.platform !== 'win32'");
    expect(driver).toContain('../../dist/blade.js');
    expect(driver).toContain('TUI_TASK_ATTENTION_PTY_USES_PRODUCTION_DIST');
    expect(runner).toContain("import { spawn } from 'bun-pty'");
    expect(runner).toContain('input.nodeExecutable');
    expect(runner).toContain('ArmedPtyMarkerLatch');
    expect(trajectory.match(/AbortSignal\.timeout/g)).toHaveLength(3);
    expect(trajectory).toContain('HEALTH_REQUEST_TIMEOUT_MS = 2_000');
    expect(trajectory).toContain('TASK_DISPATCH_TIMEOUT_MS = 15_000');
    expect(trajectory).toContain('completionTimeoutMs: 190_000');
    expect(deterministic).toContain('productionCliReady ??=');
    expect(deterministic).toContain('beforeAll(async () =>');
    expect(deterministic).toContain('BUILD_DEADLINE_MS = 120_000');
    expect(deterministic).toContain('BUILD_HOOK_TIMEOUT_MS = 180_000');
    expect(deterministic).toContain("describe.skipIf(process.platform === 'win32')");
  });

  it('rejects secrets anywhere in raw task attention runner output before parsing', () => {
    const secret = 'qualification-secret';

    expect(() =>
      assertTuiTaskAttentionRunnerOutputSafe(
        JSON.stringify({ success: true, unexpected: secret }),
        '',
        [secret]
      )
    ).toThrow('credentials');
    expect(() =>
      assertTuiTaskAttentionRunnerOutputSafe(
        JSON.stringify({ success: true }),
        `unprojected stderr ${secret}`,
        [secret]
      )
    ).toThrow('credentials');
  });

  it('retains an early secret leak after bounded output rolls forward', () => {
    const secret = 'early-qualification-secret';
    const scanner = createTuiTaskAttentionSecretScanner([secret]);

    scanner.observe(`prefix ${secret}`);
    scanner.observe('x'.repeat(128 * 1024));

    expect(scanner.leakedSecretLabels()).toEqual(['secret-1']);
  });

  it('keeps a secret latch after early output rolls out of the retained tail', () => {
    const secret = 'rolled-off-secret';
    const capture = createTuiTaskAttentionStreamCapture([secret], 32);

    capture.append(`early ${secret}`);
    capture.append('x'.repeat(128));

    expect(capture.output()).not.toContain(secret);
    expect(capture.leakedSecretLabels()).toEqual(['secret-1']);
  });

  it('bounds settlement when a killed runner never resolves', async () => {
    const pending = new Promise<never>(() => undefined);
    const startedAt = Date.now();

    await awaitTuiTaskAttentionSettlement(pending, 10);

    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it('recursively redacts ordinary and aggregate task attention errors', () => {
    const secret = 'nested-error-secret';
    const nested = new Error(`cause ${secret}`);
    const aggregate = new AggregateError(
      [new Error(`member ${secret}`, { cause: nested })],
      `aggregate ${secret}`,
      { cause: new Error(`outer cause ${secret}`) }
    );

    const sanitized = sanitizeTuiTaskAttentionError(aggregate, [secret]);
    const serialized = JSON.stringify(sanitized, Object.getOwnPropertyNames(sanitized));

    expect(serialized).not.toContain(secret);
    expect(sanitized.message).toContain('[REDACTED]');
    expect(sanitized).toBeInstanceOf(AggregateError);
    expect((sanitized as AggregateError).errors).toHaveLength(1);
    expect((sanitized as AggregateError).errors[0].message).toContain('[REDACTED]');
  });

  it('resolves the monorepo root from the CLI scripts directory', () => {
    const scriptsDirectory = path.resolve(__dirname, '../../../scripts');

    expect(resolveQualificationRoot(scriptsDirectory)).toBe(
      path.resolve(__dirname, '../../../../..')
    );
  });

  it('builds before performance in the deterministic local gate', () => {
    const plan = createQualificationPlan('local');
    const checkIds = plan.map((check) => check.id);

    expect(checkIds).toEqual([
      'type-check',
      'format-check',
      'lint',
      'unit',
      'integration',
      'cli',
      'headless-core',
      'e2e',
      'snapshot',
      'security',
      'build',
      'web-test',
      'web-type-check',
      'performance',
    ]);
    expect(plan).toHaveLength(14);
    expect(checkIds.indexOf('build')).toBeLessThan(checkIds.indexOf('web-test'));
    expect(checkIds.indexOf('build')).toBeLessThan(checkIds.indexOf('performance'));
    expect(plan.some((check) => check.network === 'paid-api')).toBe(false);
  });

  it('keeps CLI tests out of the generic integration project', () => {
    const vitestConfig = fs.readFileSync(
      path.resolve(__dirname, '../../../vitest.config.ts'),
      'utf8'
    );

    expect(vitestConfig).toContain(
      "exclude: ['tests/integration/real-api/**', 'tests/integration/cli/**']"
    );
  });

  it('runs production performance and real API checks only after building', () => {
    const plan = createQualificationPlan('production');
    const buildIndex = plan.findIndex((check) => check.id === 'build');
    const performanceIndex = plan.findIndex((check) => check.id === 'performance');
    const browserIndex = plan.findIndex((check) => check.id === 'browser-check');
    const realApiIndex = plan.findIndex((check) => check.id === 'real-api');

    expect(buildIndex).toBeGreaterThanOrEqual(0);
    expect(performanceIndex).toBeGreaterThan(buildIndex);
    expect(browserIndex).toBeGreaterThan(performanceIndex);
    expect(realApiIndex).toBeGreaterThan(browserIndex);
    expect(realApiIndex).toBeGreaterThan(buildIndex);
    expect(plan).toHaveLength(16);
    expect(plan[browserIndex]).toMatchObject({
      command: 'bun',
      args: ['run', '--filter', 'blade-code', 'browser:check'],
    });
    expect(plan[realApiIndex]).toMatchObject({
      command: 'bun',
      args: ['run', 'test:real-api:qualification'],
      network: 'paid-api',
    });
  });

  it('fails closed when production credentials are missing', () => {
    expect(() => resolveProductionEnvironment({})).toThrow(
      'DeepSeek credentials are required'
    );
  });

  it('accepts the split Blade credential store without copying its secret', () => {
    expect(
      resolveProductionEnvironment({}, { hasConfiguredDeepSeekApiKey: true })
    ).toEqual({
      REAL_API_TEST: '1',
    });
  });

  it('requires both production qualification models', () => {
    expect(() =>
      resolveProductionEnvironment({
        DEEPSEEK_API_KEY: 'test-secret',
        DEEPSEEK_MODELS: 'deepseek-v4-flash',
      })
    ).toThrow('deepseek-v4-pro');
  });

  it('defaults production qualification to both required models', () => {
    const env = resolveProductionEnvironment({
      DEEPSEEK_API_KEY: 'test-secret',
    });

    expect(env.DEEPSEEK_MODELS).toBe('deepseek-v4-flash,deepseek-v4-pro');
    expect(env.DEEPSEEK_MODEL).toBe('deepseek-v4-flash');
    expect(env.DEEPSEEK_BASE_URL).toBe('https://api.deepseek.com');
    expect(env.REAL_API_TEST).toBe('1');
  });

  it('exposes credentials only to the paid real API check', () => {
    const base = {
      PATH: '/usr/bin',
      DEEPSEEK_API_KEY: 'ambient-secret',
      GPT_MODEL: 'ambient-gpt',
      REAL_API_TEST: '1',
      BLADE_REAL_API_CREDENTIALS_FILE: '/private/credentials.json',
    };
    const paid = {
      ...base,
      DEEPSEEK_API_KEY: 'materialized-secret',
      CLAUDE_API_KEY: 'claude-secret',
      DOMESTIC_API_KEY: 'optional-domestic-secret',
    };
    const requiredPaid = {
      ...base,
      DEEPSEEK_API_KEY: 'materialized-secret',
      CLAUDE_API_KEY: 'claude-secret',
    };

    expect(
      resolveQualificationCheckEnvironment(
        { id: 'unit', name: 'Unit', command: 'bun', args: [] },
        base,
        paid
      )
    ).toEqual({ PATH: '/usr/bin' });
    expect(
      resolveQualificationCheckEnvironment(
        {
          id: 'browser-check',
          name: 'Chromium preflight',
          command: 'bun',
          args: [],
        },
        base,
        paid
      )
    ).toEqual({ PATH: '/usr/bin' });
    expect(
      resolveQualificationCheckEnvironment(
        {
          id: 'real-api',
          name: 'Real API',
          command: 'bun',
          args: [],
          network: 'paid-api',
        },
        base,
        paid
      )
    ).toEqual(requiredPaid);
  });

  it('includes optional paid providers only when explicitly requested', () => {
    const paid = {
      REAL_API_TEST: '1',
      REAL_API_INCLUDE_OPTIONAL_PROVIDERS: '1',
      DOMESTIC_API_KEY: 'optional-domestic-secret',
      DOMESTIC_MODEL: 'domestic-model',
    };

    expect(
      resolveQualificationCheckEnvironment(
        {
          id: 'real-api',
          name: 'Real API',
          command: 'bun',
          args: [],
          network: 'paid-api',
        },
        {},
        paid
      )
    ).toEqual(paid);
  });

  it('executes checks in order and stops at the first failure', async () => {
    const started: string[] = [];
    const result = await runQualification(
      [
        { id: 'first', name: 'First', command: 'one', args: [] },
        { id: 'second', name: 'Second', command: 'two', args: [] },
        { id: 'third', name: 'Third', command: 'three', args: [] },
      ],
      {
        cwd: '/workspace',
        env: {},
        execute: async (check) => {
          started.push(check.id);
          return check.id === 'second' ? 9 : 0;
        },
      }
    );

    expect(started).toEqual(['first', 'second']);
    expect(result).toMatchObject({ passed: false, failedCheck: 'second' });
  });

  it('prevents paid execution when the Chromium preflight fails', async () => {
    const started: string[] = [];
    const result = await runQualification(
      [
        {
          id: 'browser-check',
          name: 'Chromium preflight',
          command: 'bun',
          args: [],
        },
        {
          id: 'real-api',
          name: 'Real API',
          command: 'bun',
          args: [],
          network: 'paid-api',
        },
      ],
      {
        cwd: '/workspace',
        env: {},
        execute: async (check) => {
          started.push(check.id);
          return check.id === 'browser-check' ? 1 : 0;
        },
      }
    );

    expect(started).toEqual(['browser-check']);
    expect(result).toMatchObject({
      passed: false,
      failedCheck: 'browser-check',
      completedChecks: 0,
    });
  });

  it('reports success only after every check exits zero', async () => {
    const result = await runQualification(
      [
        { id: 'first', name: 'First', command: 'one', args: [] },
        { id: 'second', name: 'Second', command: 'two', args: [] },
      ],
      { cwd: '/workspace', env: {}, execute: async () => 0 }
    );

    expect(result).toMatchObject({ passed: true, completedChecks: 2 });
  });
});
