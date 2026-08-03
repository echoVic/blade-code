import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isVerificationCommand } from '../../../src/agent/loop/completionPolicy.js';
import {
  buildRealApiConfig,
  parseHeadlessJsonl,
  redactSecrets,
} from './codingTaskHarness.js';
import { isRealApiTestEnabled } from './testConfig.js';

const cliEntry = path.resolve('dist', 'blade.js');
const apiKey = process.env.DEEPSEEK_API_KEY ?? '';
const baseUrl = process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com';
const models = (process.env.DEEPSEEK_MODELS ?? 'deepseek-v4-flash,deepseek-v4-pro')
  .split(',')
  .map((model) => model.trim())
  .filter(Boolean);
const enabled = isRealApiTestEnabled() && Boolean(apiKey);

interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

function runGit(cwd: string, args: string[]): void {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Blade Test',
      GIT_AUTHOR_EMAIL: 'blade-test@example.invalid',
      GIT_COMMITTER_NAME: 'Blade Test',
      GIT_COMMITTER_EMAIL: 'blade-test@example.invalid',
    },
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
}

function createWorkspace(): string {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'blade-cli-agents-'));
  mkdirSync(path.join(workspace, 'src'), { recursive: true });
  mkdirSync(path.join(workspace, 'test'), { recursive: true });
  writeFileSync(
    path.join(workspace, 'package.json'),
    JSON.stringify(
      {
        name: 'blade-cli-agents-trajectory',
        private: true,
        type: 'module',
        scripts: { test: 'node --test' },
      },
      null,
      2
    )
  );
  writeFileSync(
    path.join(workspace, 'src', 'channel.js'),
    "export const channel = 'BROKEN';\n"
  );
  writeFileSync(
    path.join(workspace, 'test', 'channel.test.js'),
    [
      "import assert from 'node:assert/strict';",
      "import test from 'node:test';",
      "import { channel } from '../src/channel.js';",
      '',
      "test('replaces the broken channel', () => {",
      "  assert.notEqual(channel, 'BROKEN');",
      '});',
      '',
    ].join('\n')
  );
  runGit(workspace, ['init', '-q']);
  runGit(workspace, ['add', '.']);
  runGit(workspace, ['commit', '-qm', 'fixture']);
  return workspace;
}

function listJsonlFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return listJsonlFiles(entryPath);
    return entry.isFile() && entry.name.endsWith('.jsonl') ? [entryPath] : [];
  });
}

function parseTranscript(filePath: string): Array<Record<string, unknown>> {
  return readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function hasSuccessfulCustomAgentTrajectory(home: string): boolean {
  const files = listJsonlFiles(path.join(home, '.blade', 'projects'));
  const childSessionIds = new Set<string>();

  for (const file of files.filter((candidate) =>
    path.basename(candidate).startsWith('headless-')
  )) {
    for (const event of parseTranscript(file)) {
      const data = event.data as Record<string, unknown> | undefined;
      const payload = data?.payload as Record<string, unknown> | undefined;
      if (
        event.type === 'part_created' &&
        data?.partType === 'subtask_ref' &&
        payload?.agentType === 'channel-specialist' &&
        typeof payload.childSessionId === 'string'
      ) {
        childSessionIds.add(payload.childSessionId);
      }
    }
  }

  return [...childSessionIds].some((sessionId) => {
    const childFile = files.find(
      (candidate) => path.basename(candidate, '.jsonl') === sessionId
    );
    if (!childFile) return false;

    const successfulTools = new Set<string>();
    const verificationCommands: string[] = [];
    for (const event of parseTranscript(childFile)) {
      const data = event.data as Record<string, unknown> | undefined;
      const payload = data?.payload as Record<string, unknown> | undefined;
      if (event.type !== 'part_created' || !payload) continue;

      if (data?.partType === 'tool_call' && typeof payload.toolName === 'string') {
        const input = payload.input as Record<string, unknown> | undefined;
        const command = input?.command;
        if (
          payload.toolName === 'Bash' &&
          typeof command === 'string' &&
          isVerificationCommand(command)
        ) {
          verificationCommands.push(command);
        }
      } else if (
        data?.partType === 'tool_result' &&
        typeof payload.toolName === 'string' &&
        !payload.error
      ) {
        successfulTools.add(payload.toolName);
      }
    }

    return (
      successfulTools.has('Read') &&
      successfulTools.has('Edit') &&
      successfulTools.has('Bash') &&
      verificationCommands.length > 0
    );
  });
}

function runBlade(
  workspace: string,
  home: string,
  model: string,
  expectedValue: string
): Promise<CommandResult> {
  const configDirectory = path.join(home, '.blade');
  mkdirSync(configDirectory, { recursive: true });
  writeFileSync(
    path.join(configDirectory, 'config.json'),
    JSON.stringify(buildRealApiConfig({ modelId: model, model, baseUrl }), null, 2)
  );
  const agents = JSON.stringify({
    'channel-specialist': {
      description:
        'Focused implementation agent for the channel repair; use it for this task.',
      prompt: [
        '# Invocation policy',
        `The required channel value is exactly '${expectedValue}'.`,
        'Act as the coding executor. Read src/channel.js, edit only that source file,',
        'run npm test with Bash, inspect the exit code, and finish only after it passes.',
        'Do not delegate or merely explain the change.',
      ].join('\n'),
      tools: ['Read', 'Edit', 'Bash'],
      permissionMode: 'dontAsk',
      maxTurns: 12,
    },
  });

  return new Promise((resolve) => {
    const child = spawn(
      'node',
      [
        cliEntry,
        '--headless',
        '--output-format',
        'jsonl',
        '--permission-mode',
        'yolo',
        '--model',
        model,
        '--max-turns',
        '6',
        '--append-system-prompt',
        [
          'For this request, call Task exactly once with subagent_type channel-specialist.',
          'Do not call any other subagent or tool. After Task succeeds, return a final answer.',
        ].join(' '),
        '--allowed-tools',
        'Task',
        '--agents',
        agents,
        [
          'Delegate this repair exclusively to channel-specialist with the Task tool.',
          'The specialist already has the complete invocation policy and implementation',
          'tools. Do not inspect or solve the task directly.',
        ].join(' '),
      ],
      {
        cwd: workspace,
        env: {
          ...process.env,
          HOME: home,
          BLADE_STORAGE_ROOT: configDirectory,
          BLADE_API_KEY: apiKey,
          BLADE_TELEMETRY_DISABLED: '1',
          BLADE_ALLOW_ROOT: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let forceKill: ReturnType<typeof setTimeout> | undefined;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      forceKill = setTimeout(() => child.kill('SIGKILL'), 5_000);
    }, 240_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      resolve({ status: null, stdout, stderr, error });
    });
    child.once('close', (status) => {
      clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      resolve({
        status,
        stdout,
        stderr,
        error: timedOut
          ? new Error('Blade CLI timed out after 240 seconds')
          : undefined,
      });
    });
  });
}

function formatFailure(result: CommandResult): string {
  const output = redactSecrets(
    [`stderr:\n${result.stderr}`, `stdout:\n${result.stdout}`].join('\n'),
    [apiKey]
  );
  return output.slice(-12_000);
}

describe.skipIf(!enabled)('CLI custom agents trajectory (real API)', () => {
  describe.each(models)('%s', (model) => {
    it('delegates a real coding task through an invocation-scoped agent', async () => {
      if (!existsSync(cliEntry)) {
        throw new Error(
          `Missing ${cliEntry}; run "bun run build:cli" before real API tests`
        );
      }

      const workspace = createWorkspace();
      const home = mkdtempSync(path.join(os.tmpdir(), 'blade-cli-agents-home-'));
      const expectedValue = `CLI_AGENT_${model.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}`;

      try {
        const result = await runBlade(workspace, home, model, expectedValue);
        const parsed = parseHeadlessJsonl(result.stdout);
        const toolStarts = parsed.events
          .filter((event) => event.type === 'tool_start')
          .map((event) => event.tool_name);
        const successfulToolResults = parsed.events.flatMap((event) =>
          event.type === 'tool_result' && event.success ? [event.tool_name] : []
        );
        const taskResult = parsed.events.find(
          (event) =>
            event.type === 'tool_result' && event.tool_name === 'Task' && event.success
        );
        const changedPaths = execFileSync('git', ['diff', '--name-only'], {
          cwd: workspace,
          encoding: 'utf8',
        })
          .trim()
          .split(/\r?\n/)
          .filter(Boolean);
        const source = readFileSync(path.join(workspace, 'src', 'channel.js'), 'utf8');
        const verification = spawnSync('npm', ['test'], {
          cwd: workspace,
          encoding: 'utf8',
        });
        const hasChildTrajectory = hasSuccessfulCustomAgentTrajectory(home);

        expect(result.error, formatFailure(result)).toBeUndefined();
        expect(result.status, formatFailure(result)).toBe(0);
        expect(parsed.nonJsonLines).toEqual([]);
        expect(parsed.events.filter((event) => event.type === 'error')).toEqual([]);
        expect(toolStarts).toContain('Task');
        expect(successfulToolResults).toContain('Task');
        expect(successfulToolResults).not.toContain('Read');
        expect(successfulToolResults).not.toContain('Edit');
        expect(successfulToolResults).not.toContain('Bash');
        expect(taskResult).toEqual(expect.objectContaining({ success: true }));
        expect(hasChildTrajectory).toBe(true);
        expect(changedPaths).toEqual(['src/channel.js']);
        expect(source).toBe(`export const channel = '${expectedValue}';\n`);
        expect(verification.status, verification.stderr).toBe(0);
        expect(`${result.stdout}\n${result.stderr}`).not.toContain(apiKey);
      } finally {
        rmSync(workspace, { recursive: true, force: true });
        rmSync(home, { recursive: true, force: true });
      }
    }, 360_000);
  });
});
