import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runHeadless } from '../../../src/commands/headless.js';
import { HeadlessJsonlEventSchema } from '../../../src/commands/headlessEvents.js';
import { PermissionMode, type RuntimeConfig } from '../../../src/config/types.js';
import { getState } from '../../../src/store/vanilla.js';
import { runWithCwdOverride } from '../../../src/utils/cwd.js';
import {
  buildRealApiRuntimeConfig,
  expandDeepSeekModelMatrix,
  getEnabledModelConfigs,
  isRealApiTestEnabled,
  resolveRequiredDeepSeekQualificationModels,
} from './testConfig.js';

const execFileAsync = promisify(execFile);
const modelConfigs = isRealApiTestEnabled()
  ? process.env.REAL_API_RELEASE_MATRIX === '1'
    ? resolveRequiredDeepSeekQualificationModels()
    : expandDeepSeekModelMatrix(
        getEnabledModelConfigs().filter((config) => config.id === 'deepseek')
      )
  : [];
const enabled = modelConfigs.length > 0;
const originalStorageRoot = process.env.BLADE_STORAGE_ROOT;
let originalConfig: RuntimeConfig | null = null;

beforeAll(() => {
  if (!enabled) return;
  originalConfig = getState().config.config;
});

afterAll(() => {
  if (originalConfig) {
    getState().config.actions.setConfig(originalConfig);
  }
  if (originalStorageRoot === undefined) {
    delete process.env.BLADE_STORAGE_ROOT;
  } else {
    process.env.BLADE_STORAGE_ROOT = originalStorageRoot;
  }
});

describe.skipIf(!enabled)('release coding trajectory (real API)', () => {
  for (const modelConfig of modelConfigs) {
    it(`${modelConfig.model} passes controlled benchmark host verification without touching the caller workspace`, {
      timeout: 900_000,
    }, async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'blade-benchmark-real-'));
      const caller = path.join(root, 'caller');
      const home = path.join(root, 'home');
      const historyPath = path.join(root, 'history.json');
      try {
        await mkdir(caller, { recursive: true });
        await mkdir(path.join(home, '.blade'), { recursive: true, mode: 0o700 });
        const sentinel = path.join(caller, 'untouched.txt');
        await writeFile(sentinel, 'CALLER_MUST_NOT_CHANGE\n');
        const config = buildRealApiRuntimeConfig(modelConfig);
        await writeFile(
          path.join(home, '.blade', 'config.json'),
          JSON.stringify({
            currentModelId: config.currentModelId,
            models: config.models,
            modelProviders: config.modelProviders,
          }),
          { mode: 0o600 }
        );
        const result = await execFileAsync(
          'bun',
          [
            path.resolve(
              import.meta.dirname,
              '../../../scripts/run-real-repo-benchmark.ts'
            ),
            '--model',
            config.currentModelId,
            '--history-path',
            historyPath,
          ],
          {
            cwd: caller,
            timeout: 840_000,
            maxBuffer: 1024 * 1024,
            env: {
              ...process.env,
              HOME: home,
              USERPROFILE: home,
              BLADE_STORAGE_ROOT: path.join(home, '.blade'),
              BLADE_API_KEY: modelConfig.apiKey,
            },
          }
        );
        const history = JSON.parse(await readFile(historyPath, 'utf8')) as {
          version: number;
          runs: Array<{
            suite: string;
            summary: { successRate: number };
            results: Array<{
              caseId: string;
              success: boolean;
              verification: { passed: boolean; changedPaths: string[] };
            }>;
          }>;
        };
        expect(history.version).toBe(2);
        expect(history.runs).toHaveLength(1);
        expect(history.runs[0].suite).toBe('controlled-coding-v2');
        expect(
          history.runs[0].summary.successRate,
          JSON.stringify(history.runs[0].results)
        ).toBe(1);
        expect(
          history.runs[0].results.map((entry) => entry.verification.changedPaths)
        ).toEqual([[], ['src/math.js'], ['src/checkout.js', 'src/discount.js']]);
        expect(
          history.runs[0].results.every(
            (entry) => entry.success && entry.verification.passed
          )
        ).toBe(true);
        expect(await readdir(caller)).toEqual(['untouched.txt']);
        expect(await readFile(sentinel, 'utf8')).toBe('CALLER_MUST_NOT_CHANGE\n');
        expect(JSON.stringify(history) + result.stdout + result.stderr).not.toContain(
          modelConfig.apiKey
        );
        console.log(
          `[controlled-benchmark] ${JSON.stringify({ model: modelConfig.model, summary: history.runs[0].summary, results: history.runs[0].results })}`
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it(`${modelConfig.model} fixes and verifies a production Headless task`, async () => {
      const workspace = await mkdtemp(path.join(os.tmpdir(), 'blade-release-coding-'));
      let output = '';
      let errorOutput = '';

      try {
        process.env.BLADE_STORAGE_ROOT = path.join(workspace, '.blade-storage');
        getState().config.actions.setConfig({
          ...buildRealApiRuntimeConfig(modelConfig),
          permissionMode: PermissionMode.YOLO,
          maxQueuedTaskBytes: 64 * 1024,
        });
        await mkdir(path.join(workspace, 'src'), { recursive: true });
        await mkdir(path.join(workspace, 'test'), { recursive: true });
        await writeFile(
          path.join(workspace, 'package.json'),
          `${JSON.stringify({
            name: 'blade-release-coding-fixture',
            private: true,
            type: 'module',
            scripts: { test: 'node --test' },
          })}\n`
        );
        await writeFile(
          path.join(workspace, 'src', 'add.js'),
          [
            'export function add(left, right) {',
            '  return left - right;',
            '}',
            '',
          ].join('\n')
        );
        const originalTest = [
          "import assert from 'node:assert/strict';",
          "import test from 'node:test';",
          "import { add } from '../src/add.js';",
          '',
          "test('adds two numbers', () => {",
          '  assert.equal(add(4, 3), 7);',
          '});',
          '',
        ].join('\n');
        await writeFile(path.join(workspace, 'test', 'add.test.js'), originalTest);

        const exitCode = await runWithCwdOverride(workspace, () =>
          runHeadless(
            {
              headless: true,
              outputFormat: 'jsonl',
              maxTurns: 12,
              taskIsolation: 'local',
              allowedTools: ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash'],
              appendSystemPrompt:
                'After the source edit, call Bash with exactly "npm test". ' +
                'Do not finish before that command succeeds.',
              message:
                'Read src/add.js and test/add.test.js. Fix only src/add.js so ' +
                'add(4, 3) returns 7, then call Bash with exactly "npm test".',
            },
            {
              stdout: {
                write(chunk: string) {
                  output += chunk;
                  return true;
                },
              },
              stderr: {
                write(chunk: string) {
                  errorOutput += chunk;
                  return true;
                },
              },
            }
          )
        );
        const events = output
          .split('\n')
          .filter(Boolean)
          .map((line) => HeadlessJsonlEventSchema.parse(JSON.parse(line)));
        const toolNames = events
          .filter((event) => event.type === 'tool_start')
          .map((event) => event.tool_name);

        expect(exitCode, errorOutput.replaceAll(modelConfig.apiKey, '[redacted]')).toBe(
          0
        );
        expect(toolNames).toContain('Read');
        expect(toolNames.some((name) => name === 'Edit' || name === 'Write')).toBe(
          true
        );
        expect(toolNames).toContain('Bash');
        expect(await readFile(path.join(workspace, 'src', 'add.js'), 'utf8')).toContain(
          'return left + right;'
        );
        expect(
          await readFile(path.join(workspace, 'test', 'add.test.js'), 'utf8')
        ).toBe(originalTest);
        const verification = await execFileAsync(process.execPath, ['--test'], {
          cwd: workspace,
          timeout: 30_000,
        });
        expect(verification.stdout).toContain('pass 1');
        expect(`${output}\n${errorOutput}`).not.toContain(modelConfig.apiKey);
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    }, 180_000);
  }
});
