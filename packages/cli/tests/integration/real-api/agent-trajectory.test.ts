import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runHeadless } from '../../../src/commands/headless.js';
import { HeadlessJsonlEventSchema } from '../../../src/commands/headlessEvents.js';
import { runWithCwdOverride } from '../../../src/utils/cwd.js';
import { isRealApiTestEnabled } from './testConfig.js';

const execFileAsync = promisify(execFile);
const shouldRun = isRealApiTestEnabled();
const originalStorageRoot = process.env.BLADE_STORAGE_ROOT;

describe.skipIf(!shouldRun)('Production Agent Trajectory (Real API)', () => {
  let workspace = '';
  let originalTest = '';

  beforeAll(async () => {
    workspace = await mkdtemp(path.join(os.tmpdir(), 'blade-agent-trajectory-'));
    process.env.BLADE_STORAGE_ROOT = path.join(workspace, '.blade-storage');
    await mkdir(path.join(workspace, 'src'), { recursive: true });
    await mkdir(path.join(workspace, 'test'), { recursive: true });

    await writeFile(
      path.join(workspace, 'package.json'),
      JSON.stringify(
        {
          name: 'blade-agent-trajectory-fixture',
          private: true,
          type: 'module',
          scripts: {
            test: 'node --test',
          },
        },
        null,
        2
      )
    );
    await writeFile(
      path.join(workspace, 'src', 'clamp.js'),
      [
        'export function clamp(value, min, max) {',
        '  return Math.max(max, Math.min(min, value));',
        '}',
        '',
      ].join('\n')
    );

    originalTest = [
      "import assert from 'node:assert/strict';",
      "import test from 'node:test';",
      "import { clamp } from '../src/clamp.js';",
      '',
      "test('clamps values to the inclusive range', () => {",
      '  assert.equal(clamp(-5, 0, 10), 0);',
      '  assert.equal(clamp(5, 0, 10), 5);',
      '  assert.equal(clamp(15, 0, 10), 10);',
      '});',
      '',
    ].join('\n');
    await writeFile(path.join(workspace, 'test', 'clamp.test.js'), originalTest);
  });

  afterAll(async () => {
    if (originalStorageRoot === undefined) {
      delete process.env.BLADE_STORAGE_ROOT;
    } else {
      process.env.BLADE_STORAGE_ROOT = originalStorageRoot;
    }
    if (workspace) {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('uses the production loop to inspect, edit, and verify an isolated project', async () => {
    let output = '';
    const stdout = {
      write(chunk: string) {
        output += chunk;
        return true;
      },
    };
    const stderr = {
      write(_chunk: string) {
        return true;
      },
    };

    const exitCode = await runWithCwdOverride(workspace, () =>
      runHeadless(
        {
          headless: true,
          outputFormat: 'jsonl',
          maxTurns: 12,
          allowedTools: ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash'],
          appendSystemPrompt:
            'For this task, after the final source edit you must call Bash with ' +
            'the command "npm test". Do not report completion before that command succeeds.',
          message:
            'Fix the failing clamp implementation in this project. Inspect the ' +
            'existing implementation and tests, do not modify tests, make the ' +
            'smallest correct source change, then call Bash with the exact command ' +
            '"npm test" before finishing.',
        },
        { stdout, stderr }
      )
    );

    const events = output
      .split('\n')
      .filter(Boolean)
      .map((line) => HeadlessJsonlEventSchema.parse(JSON.parse(line)));
    const toolNames = events
      .filter((event) => event.type === 'tool_start')
      .map((event) => event.tool_name);

    expect(exitCode).toBe(0);
    expect(toolNames).toContain('Read');
    expect(toolNames.some((name) => name === 'Edit' || name === 'Write')).toBe(true);
    expect(toolNames).toContain('Bash');
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'phase',
          phase: 'completed',
          status: 'done',
        }),
      ])
    );

    const source = await readFile(path.join(workspace, 'src', 'clamp.js'), 'utf-8');
    const testSource = await readFile(
      path.join(workspace, 'test', 'clamp.test.js'),
      'utf-8'
    );
    expect(source).not.toContain('Math.max(max, Math.min(min, value))');
    expect(testSource).toBe(originalTest);

    const verification = await execFileAsync(process.execPath, ['--test'], {
      cwd: workspace,
      timeout: 30_000,
    });
    expect(verification.stdout).toContain('pass 1');
  }, 300_000);
});
