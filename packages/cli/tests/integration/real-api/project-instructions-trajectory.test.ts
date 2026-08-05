import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildRealApiConfig,
  parseHeadlessJsonl,
  redactSecrets,
} from './codingTaskHarness.js';
import { isRealApiTestEnabled } from './testConfig.js';

const cliEntry = path.resolve('dist', 'blade.js');
const apiKey = process.env.DEEPSEEK_API_KEY ?? '';
const upstreamBaseUrl = process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com';
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

interface RecordingProxy {
  baseUrl: string;
  requestBodies: string[];
  close: () => Promise<void>;
}

interface InstructionFixture {
  path: string;
  content: string;
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

function createWorkspace(): {
  repository: string;
  workingDirectory: string;
  instructionFiles: InstructionFixture[];
} {
  const repository = mkdtempSync(path.join(os.tmpdir(), 'blade-real-api-rules-'));
  const workingDirectory = path.join(repository, 'packages', 'service');
  const instructionFiles = [
    {
      path: path.join(repository, 'AGENTS.md'),
      content: [
        '# Repository policy',
        "The exported policy value is 'ROOT_POLICY_VALUE'.",
        'More specific directory instructions override this value.',
        '',
      ].join('\n'),
    },
    {
      path: path.join(workingDirectory, 'BLADE.md'),
      content: [
        '# Service policy',
        "For this service, src/policy.js must export exactly 'SCOPED_POLICY_VALUE'.",
        'This service rule overrides the repository policy.',
        '',
      ].join('\n'),
    },
  ];
  mkdirSync(path.join(workingDirectory, 'src'), { recursive: true });
  mkdirSync(path.join(workingDirectory, 'test'), { recursive: true });
  for (const instruction of instructionFiles) {
    writeFileSync(instruction.path, instruction.content);
  }
  writeFileSync(
    path.join(workingDirectory, 'package.json'),
    JSON.stringify(
      {
        name: 'blade-project-instruction-trajectory',
        private: true,
        type: 'module',
        scripts: { test: 'node --test' },
      },
      null,
      2
    )
  );
  writeFileSync(
    path.join(workingDirectory, 'src', 'policy.js'),
    "export const policy = 'BROKEN';\n"
  );
  writeFileSync(
    path.join(workingDirectory, 'test', 'policy.test.js'),
    [
      "import assert from 'node:assert/strict';",
      "import test from 'node:test';",
      "import { policy } from '../src/policy.js';",
      '',
      "test('replaces the broken policy value', () => {",
      "  assert.notEqual(policy, 'BROKEN');",
      '});',
      '',
    ].join('\n')
  );
  runGit(repository, ['init', '-q']);
  runGit(repository, ['add', '.']);
  runGit(repository, ['commit', '-qm', 'fixture']);
  return { repository, workingDirectory, instructionFiles };
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function forwardRequest(
  request: IncomingMessage,
  response: ServerResponse,
  requestBody: string
): Promise<void> {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (name === 'host' || name === 'content-length' || value === undefined) continue;
    headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }

  const upstreamResponse = await fetch(new URL(request.url ?? '/', upstreamBaseUrl), {
    method: request.method,
    headers,
    body: requestBody,
  });
  const responseHeaders: Record<string, string> = {};
  upstreamResponse.headers.forEach((value, name) => {
    if (
      ![
        'connection',
        'content-encoding',
        'content-length',
        'transfer-encoding',
      ].includes(name)
    ) {
      responseHeaders[name] = value;
    }
  });
  response.writeHead(upstreamResponse.status, responseHeaders);
  response.end(Buffer.from(await upstreamResponse.arrayBuffer()));
}

async function startRecordingProxy(
  onFirstRequest?: () => void
): Promise<RecordingProxy> {
  const requestBodies: string[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const requestBody = await readRequestBody(request);
      requestBodies.push(requestBody);
      if (requestBodies.length === 1) {
        onFirstRequest?.();
      }
      await forwardRequest(request, response, requestBody);
    })().catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined);
        return;
      }
      response.writeHead(502, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          error: {
            message: error instanceof Error ? error.message : 'Proxy forwarding failed',
            type: 'proxy_error',
          },
        })
      );
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requestBodies,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

function runBlade(
  workingDirectory: string,
  home: string,
  model: string,
  proxyBaseUrl: string
): Promise<CommandResult> {
  const configDirectory = path.join(home, '.blade');
  mkdirSync(configDirectory, { recursive: true });
  writeFileSync(
    path.join(configDirectory, 'config.json'),
    JSON.stringify(
      buildRealApiConfig({ modelId: model, model, baseUrl: proxyBaseUrl }),
      null,
      2
    )
  );

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
        '--max-turns',
        '8',
        '--model',
        model,
        [
          'Apply the project instructions already present in your system context.',
          'Do not search for or read instruction files; do not modify them or the test.',
          'Read src/policy.js, replace its broken value according to the most specific rule,',
          'then run npm test and finish only when it passes. Modify only src/policy.js.',
        ].join(' '),
      ],
      {
        cwd: workingDirectory,
        env: {
          ...process.env,
          HOME: home,
          BLADE_STORAGE_ROOT: configDirectory,
          DEEPSEEK_API_KEY: apiKey,
          BLADE_TELEMETRY_DISABLED: '1',
          BLADE_ALLOW_ROOT: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
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
      resolve({ status: null, stdout, stderr, error });
    });
    child.once('close', (status) => {
      clearTimeout(timeout);
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

function extractInstructionPayload(requestBody: string): string {
  if (!requestBody) return '';
  const parsed = JSON.parse(requestBody) as {
    messages?: Array<{ content?: unknown }>;
  };
  return (
    (parsed.messages ?? [])
      .map((message) =>
        typeof message.content === 'string'
          ? message.content
          : JSON.stringify(message.content)
      )
      .find((content) => content.includes('<project-instructions>')) ?? ''
  );
}

describe.skipIf(!enabled)('project instruction trajectory (real API)', () => {
  describe.each(models)('%s', (model) => {
    it('injects scoped rules into the real coding loop with deterministic precedence', async () => {
      if (!existsSync(cliEntry)) {
        throw new Error(
          `Missing ${cliEntry}; run "bun run build:cli" before real API tests`
        );
      }

      const { repository, workingDirectory, instructionFiles } = createWorkspace();
      const home = mkdtempSync(path.join(os.tmpdir(), 'blade-real-api-rules-home-'));
      let instructionsRemovedBeforeForward = false;
      const proxy = await startRecordingProxy(() => {
        for (const instruction of instructionFiles) {
          rmSync(instruction.path, { force: true });
        }
        instructionsRemovedBeforeForward = instructionFiles.every(
          (instruction) => !existsSync(instruction.path)
        );
      });

      try {
        const result = await runBlade(workingDirectory, home, model, proxy.baseUrl);
        const parsed = parseHeadlessJsonl(result.stdout);
        const toolStarts = parsed.events
          .filter((event) => event.type === 'tool_start')
          .map((event) => event.tool_name);
        const instructionPayload = extractInstructionPayload(
          proxy.requestBodies[0] ?? ''
        );
        const rootRuleIndex = instructionPayload.indexOf('ROOT_POLICY_VALUE');
        const scopedRuleIndex = instructionPayload.indexOf('SCOPED_POLICY_VALUE');
        const instructionsRecreatedByAgent = instructionFiles.some((instruction) =>
          existsSync(instruction.path)
        );
        for (const instruction of instructionFiles) {
          writeFileSync(instruction.path, instruction.content);
        }
        const changedPaths = spawnSync('git', ['diff', '--name-only'], {
          cwd: repository,
          encoding: 'utf8',
        })
          .stdout.trim()
          .split(/\r?\n/)
          .filter(Boolean);
        const finalSource = readFileSync(
          path.join(workingDirectory, 'src', 'policy.js'),
          'utf8'
        );
        expect(result.error).toBeUndefined();
        expect(result.status, redactSecrets(result.stderr, [apiKey])).toBe(0);
        expect(parsed.nonJsonLines).toEqual([]);
        expect(parsed.events.filter((event) => event.type === 'error')).toEqual([]);
        expect(proxy.requestBodies.length).toBeGreaterThan(0);
        expect(instructionsRemovedBeforeForward).toBe(true);
        expect(instructionsRecreatedByAgent).toBe(false);
        expect(rootRuleIndex).toBeGreaterThanOrEqual(0);
        expect(scopedRuleIndex).toBeGreaterThan(rootRuleIndex);
        expect(instructionPayload).toContain('path="AGENTS.md"');
        expect(instructionPayload).toContain('path="packages/service/BLADE.md"');
        expect(toolStarts.some((name) => ['Read', 'Glob', 'Grep'].includes(name))).toBe(
          true
        );
        expect(toolStarts).toContain('Edit');
        expect(toolStarts).toContain('Bash');
        expect(changedPaths).toEqual(['packages/service/src/policy.js']);
        expect(finalSource).toContain("'SCOPED_POLICY_VALUE'");
        expect(`${result.stdout}\n${result.stderr}`).not.toContain(apiKey);
      } finally {
        await proxy.close();
        rmSync(repository, { recursive: true, force: true });
        rmSync(home, { recursive: true, force: true });
      }
    }, 300_000);
  });
});
