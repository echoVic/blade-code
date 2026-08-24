import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { testTypes } from '../../../scripts/test-config.js';
import {
  createTestProcessEnvironment,
  isolateManagedGitAttributionEnvironment,
  removeOwnedTestTemporaryRoot,
  reportTestTemporaryRootCleanupFailure,
} from '../../../scripts/test-environment.js';
import { runOwnedCommand } from '../../../scripts/test-runner.js';
import { resolveVitestCli } from '../../../scripts/vitest-cli.js';

vi.unmock('node:child_process');

const tempRoots: string[] = [];
const descendantPids = new Set<number>();

async function processIsGone(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = 5_000
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return predicate();
}

afterEach(async () => {
  for (const pid of descendantPids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // The regression passed and the process is already gone.
    }
  }
  descendantPids.clear();
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe.skipIf(process.platform === 'win32')('test runner process ownership', () => {
  it('allows the complete serial real API matrix to run for one hour', () => {
    expect(testTypes.realApi.timeout).toBe(60 * 60 * 1000);
  });

  it('allows the expanded release-blocking matrix to run for ninety minutes', () => {
    expect(testTypes.realApiQualification.timeout).toBe(90 * 60 * 1000);
    expect(testTypes.realApiQualification.files).toContain(
      'tests/integration/real-api/goal-mode-trajectory.test.ts'
    );
    expect(testTypes.realApiQualification.files).toContain(
      'tests/integration/real-api/release-coding-trajectory.test.ts'
    );
    expect(testTypes.realApiQualification.files).toContain(
      'tests/integration/real-api/task-list-team-trajectory.test.ts'
    );
    expect(testTypes.realApiQualification.files).toContain(
      'tests/integration/real-api/provider-retry-trajectory.test.ts'
    );
    expect(testTypes.realApiQualification.files).toContain(
      'tests/integration/real-api/provider-attempt-deadline-web-trajectory.test.ts'
    );
    expect(testTypes.realApiQualification.files).toContain(
      'tests/integration/real-api/prompt-cache-surface-trajectory.test.ts'
    );
    expect(testTypes.realApiQualification.files).toContain(
      'tests/integration/real-api/action-stationarity-trajectory.test.ts'
    );
    expect(testTypes.realApiQualification.files).toContain(
      'tests/integration/real-api/acp-session-fork-trajectory.test.ts'
    );
    expect(testTypes.realApiQualification.files).toContain(
      'tests/integration/real-api/goal-finalization-handoff-trajectory.test.ts'
    );
    expect(testTypes.realApiQualification.files).toContain(
      'tests/integration/real-api/subagent-result-adoption-trajectory.test.ts'
    );
    expect(testTypes.realApiQualification.files).toContain(
      'tests/integration/real-api/background-subagent-completion-trajectory.test.ts'
    );
    expect(testTypes.realApiQualification.files).toContain(
      'tests/integration/real-api/provider-request-admission-acp-trajectory.test.ts'
    );
    expect(testTypes.realApiQualification.files).toContain(
      'tests/integration/real-api/provider-request-admission-web-trajectory.test.ts'
    );
    expect(testTypes.realApiQualification.files).toContain(
      'tests/integration/real-api/foreground-bounded-output-trajectory.test.ts'
    );
    expect(testTypes.realApiQualification.files).toContain(
      'tests/integration/real-api/keyed-coordination-reclamation-trajectory.test.ts'
    );
    expect(testTypes.realApiQualification.files).toContain(
      'tests/integration/real-api/side-conversation-trajectory.test.ts'
    );
    expect(testTypes.realApiQualification.files).not.toContain(
      'tests/integration/real-api/blade-coding-task.test.ts'
    );
    expect(testTypes.realApiQualification.env).toMatchObject({
      REAL_API_TEST: '1',
      REAL_API_RELEASE_MATRIX: '1',
    });
  });

  it('keeps the complete token-budget handoff matrix release-blocking', async () => {
    const file = 'tests/integration/real-api/token-budget-handoff-trajectory.test.ts';
    expect(testTypes.realApiQualification.files).toContain(file);
    const source = await readFile(
      path.resolve(import.meta.dirname, '../../..', file),
      'utf8'
    );
    expect(source).toContain(
      "const surfaces = ['headless', 'pty', 'web', 'acp'] as const"
    );
    expect(source).toContain('matrix.length !== 8');
    expect(source).not.toContain('releaseBlockingSurfaces');
    expect(testTypes.realApiQualification.env).toMatchObject({
      REAL_API_TEST: '1',
      REAL_API_RELEASE_MATRIX: '1',
    });
  });

  it('keeps the complete large-prompt offload matrix release-blocking', async () => {
    const file = 'tests/integration/real-api/large-prompt-offload-trajectory.test.ts';
    expect(testTypes.realApiQualification.files).toContain(file);
    const source = await readFile(
      path.resolve(import.meta.dirname, '../../..', file),
      'utf8'
    );
    expect(source).toContain(
      "const surfaces = ['headless', 'pty', 'web', 'acp'] as const"
    );
    expect(source).toContain('matrix.length !== 8');
    expect(source).toContain('const SURFACE_TIMEOUT_MS = 270_000');
    expect(source).toContain('maxRetries: 0');
    expect(source).toContain('maxOutputTokens: REAL_API_OUTPUT_BUDGET');
    expect(source).toContain('temperature: 0');
    expect(source).toContain('modelMaxRetries: 0');
    expect(source).toContain('modelMaxOutputTokens: REAL_API_OUTPUT_BUDGET');
    expect(source).toContain('modelTemperature: 0');
  });

  it('keeps the real Provider embedded-browser GUI trajectory release-blocking', async () => {
    const file = 'tests/integration/real-api/browser-preview-trajectory.test.ts';
    expect(testTypes.realApiQualification.files).toContain(file);
    const source = await readFile(
      path.resolve(import.meta.dirname, '../../..', file),
      'utf8'
    );
    expect(source).toContain('buildRealApiRuntimeConfig(model)');
    expect(source).toContain('await chromium.launch({ headless: true })');
    expect(source).toContain("frameLocator('[data-preview-browser-frame]')");
    expect(source).toContain("getByRole('button', { name: 'Go back' })");
    expect(source).toContain("getByRole('button', { name: 'Go forward' })");
    expect(source).toContain("getByRole('button', { name: 'Reload page' })");
  });

  it('keeps raw PTY marker authorities in the release-blocking matrix', () => {
    const files = testTypes.realApiQualification.files;

    expect(files).toContain(
      'tests/integration/real-api/foreground-command-handoff-trajectory.test.ts'
    );
    expect(files).toContain(
      'tests/integration/real-api/foreground-provider-recovery-trajectory.test.ts'
    );
    expect(files).toContain(
      'tests/integration/real-api/tool-admission-trajectory.test.ts'
    );
  });

  it('keeps cross-provider fallback in the release-blocking matrix', () => {
    expect(testTypes.realApiQualification.files).toContain(
      'tests/integration/real-api/cross-provider-fallback-trajectory.test.ts'
    );
  });

  it('disables framework retry for the release-blocking real API matrix', async () => {
    const vitestConfig = await readFile(
      path.resolve(import.meta.dirname, '../../../vitest.config.ts'),
      'utf8'
    );

    expect(vitestConfig).toContain(
      "const isReleaseRealApiMatrix = process.env.REAL_API_RELEASE_MATRIX === '1'"
    );
    expect(vitestConfig).toContain('retry: isReleaseRealApiMatrix ? 0 : 1');
  });

  it('keeps the process-heavy integration suite above fixture command budgets', () => {
    expect(testTypes.integration.timeout).toBe(600_000);
  });

  it('allows the complete unit suite to scale beyond the legacy 45 second budget', () => {
    expect(testTypes.unit.timeout).toBe(480_000);
  });

  it('keeps wall-clock performance tests out of the coverage matrix', () => {
    expect(testTypes.all.coverageExcludedProjects).toEqual(['performance']);
  });

  it('resolves the Vitest CLI through its public package metadata', async () => {
    const cliPath = resolveVitestCli();
    expect(path.basename(cliPath)).toBe('vitest.mjs');
    await expect(access(cliPath)).resolves.toBeUndefined();
  });

  it('returns a normal exit without reporting timeout or abort', async () => {
    const result = await runOwnedCommand({
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
      cwd: os.tmpdir(),
      timeoutMs: 5_000,
      stdio: 'ignore',
    });

    expect(result).toEqual({
      exitCode: 0,
      signal: null,
      timedOut: false,
      aborted: false,
    });
  });

  it('removes only the managed Git attribution overlay from test environments', () => {
    const environment: NodeJS.ProcessEnv = {
      BLADE_ENVIRONMENT_SENTINEL: 'preserved',
      GIT_CONFIG_COUNT: '3',
      GIT_CONFIG_KEY_0: 'credential.helper',
      GIT_CONFIG_VALUE_0: 'safe-helper',
      GIT_CONFIG_KEY_1: 'user.name',
      GIT_CONFIG_VALUE_1: 'Blade Test',
      GIT_CONFIG_KEY_2: 'core.hooksPath',
      GIT_CONFIG_VALUE_2: '/tmp/trae-managed-hooks',
      TRAE_GIT_ATTRIBUTION_CONFIG_SLOT: '2',
      TRAE_GIT_ATTRIBUTION_FILE: '/tmp/trae-attribution',
      TRAE_GIT_ATTRIBUTION_HELPER: '/tmp/traex',
      TRAE_GIT_ATTRIBUTION_MANAGED_HOOK: '1',
    };

    isolateManagedGitAttributionEnvironment(environment);

    expect(environment).toMatchObject({
      BLADE_ENVIRONMENT_SENTINEL: 'preserved',
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'credential.helper',
      GIT_CONFIG_VALUE_0: 'safe-helper',
      GIT_CONFIG_KEY_1: 'user.name',
      GIT_CONFIG_VALUE_1: 'Blade Test',
    });
    expect(environment.GIT_CONFIG_KEY_2).toBeUndefined();
    expect(environment.GIT_CONFIG_VALUE_2).toBeUndefined();
    expect(environment.TRAE_GIT_ATTRIBUTION_CONFIG_SLOT).toBeUndefined();
    expect(environment.TRAE_GIT_ATTRIBUTION_FILE).toBeUndefined();
    expect(environment.TRAE_GIT_ATTRIBUTION_HELPER).toBeUndefined();
    expect(environment.TRAE_GIT_ATTRIBUTION_MANAGED_HOOK).toBeUndefined();
  });

  it('preserves user-owned Git hook overlays without the managed marker', () => {
    const environment: NodeJS.ProcessEnv = {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.hooksPath',
      GIT_CONFIG_VALUE_0: '/tmp/user-hooks',
    };

    isolateManagedGitAttributionEnvironment(environment);

    expect(environment).toEqual({
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.hooksPath',
      GIT_CONFIG_VALUE_0: '/tmp/user-hooks',
    });
  });

  it('gives the test child an owned temporary root without mutating the caller', () => {
    const source: NodeJS.ProcessEnv = {
      BLADE_ENVIRONMENT_SENTINEL: 'preserved',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.hooksPath',
      GIT_CONFIG_VALUE_0: '/tmp/trae-managed-hooks',
      TRAE_GIT_ATTRIBUTION_CONFIG_SLOT: '0',
      TRAE_GIT_ATTRIBUTION_HELPER: '/tmp/traex',
      TRAE_GIT_ATTRIBUTION_MANAGED_HOOK: '1',
    };

    const environment = createTestProcessEnvironment(
      source,
      '/tmp/blade-owned-test-root'
    );

    expect(environment).toEqual({
      BLADE_ENVIRONMENT_SENTINEL: 'preserved',
      TMPDIR: '/tmp/blade-owned-test-root',
      TMP: '/tmp/blade-owned-test-root',
      TEMP: '/tmp/blade-owned-test-root',
    });
    expect(source.GIT_CONFIG_COUNT).toBe('1');
    expect(source.TRAE_GIT_ATTRIBUTION_MANAGED_HOOK).toBe('1');
    expect(source.TMPDIR).toBeUndefined();
  });

  it('removes an owned temporary root recreated by a delayed writer', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'blade-owned-test-root-'));
    tempRoots.push(root);
    const delayedWrite = new Promise<void>((resolve, reject) => {
      setTimeout(() => {
        void mkdir(path.join(root, 'late-writer'), { recursive: true }).then(
          () => resolve(),
          reject
        );
      }, 25);
    });

    await removeOwnedTestTemporaryRoot(root, {
      maxWaitMs: 1_000,
      pollIntervalMs: 10,
      quietPeriodMs: 100,
    });
    await delayedWrite;

    await expect(access(root)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports cleanup failure without hiding the original test error', () => {
    const runError = new Error('unit suite failed');
    const cleanupError = new Error('temporary root remained active');
    const report = vi.fn();

    reportTestTemporaryRootCleanupFailure(runError, cleanupError, report);

    expect(runError.cause).toBe(cleanupError);
    expect(report).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledWith('测试临时目录清理失败', cleanupError);
  });

  it('fails closed for an inconsistent managed Git attribution overlay', () => {
    const environment: NodeJS.ProcessEnv = {
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'core.hooksPath',
      GIT_CONFIG_VALUE_0: '/tmp/trae-managed-hooks',
      TRAE_GIT_ATTRIBUTION_CONFIG_SLOT: '0',
      TRAE_GIT_ATTRIBUTION_MANAGED_HOOK: '1',
    };

    expect(() => isolateManagedGitAttributionEnvironment(environment)).toThrow(
      'Managed Git attribution environment is inconsistent'
    );
  });

  it('kills a TERM-ignoring descendant when the command times out', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'blade-test-runner-'));
    tempRoots.push(root);
    const script = path.join(root, 'parent.mjs');
    const descendantPidFile = path.join(root, 'descendant.pid');

    await writeFile(
      script,
      [
        "import { spawn } from 'node:child_process';",
        "import { writeFileSync } from 'node:fs';",
        'const descendant = spawn(process.execPath, [',
        "  '-e',",
        '  "process.on(\'SIGTERM\', () => {}); setInterval(() => {}, 1000);",',
        "], { stdio: 'ignore' });",
        'writeFileSync(process.argv[2], String(descendant.pid));',
        "process.on('SIGTERM', () => {});",
        'setInterval(() => {}, 1000);',
        '',
      ].join('\n')
    );

    const result = await runOwnedCommand({
      command: process.execPath,
      args: [script, descendantPidFile],
      cwd: root,
      timeoutMs: 1_500,
      gracePeriodMs: 100,
      stdio: 'ignore',
    });
    const descendantPid = Number.parseInt(
      await readFile(descendantPidFile, 'utf8'),
      10
    );
    descendantPids.add(descendantPid);

    expect(result).toMatchObject({ timedOut: true, exitCode: null });
    expect(await waitFor(() => processIsGone(descendantPid))).toBe(true);
    descendantPids.delete(descendantPid);
  }, 10_000);

  it('reaps the detached command group when the runner owner hard-exits', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'blade-test-owner-exit-'));
    tempRoots.push(root);
    const targetPidFile = path.join(root, 'target.pid');
    const fixture = path.resolve(
      import.meta.dirname,
      '../../fixtures/launch-owned-test-command.ts'
    );
    const owner = spawn('bun', [fixture, targetPidFile], {
      cwd: root,
      detached: true,
      stdio: 'ignore',
    });
    if (!owner.pid) throw new Error('Test runner owner PID is missing');
    descendantPids.add(owner.pid);

    expect(
      await waitFor(async () => {
        try {
          const targetPid = Number.parseInt(await readFile(targetPidFile, 'utf8'), 10);
          return Number.isSafeInteger(targetPid) && targetPid > 1;
        } catch {
          return false;
        }
      })
    ).toBe(true);
    const targetPid = Number.parseInt(await readFile(targetPidFile, 'utf8'), 10);
    descendantPids.add(targetPid);

    process.kill(owner.pid, 'SIGKILL');

    expect(await waitFor(() => processIsGone(owner.pid!))).toBe(true);
    expect(await waitFor(() => processIsGone(targetPid))).toBe(true);
    descendantPids.delete(owner.pid);
    descendantPids.delete(targetPid);
  }, 15_000);
});
