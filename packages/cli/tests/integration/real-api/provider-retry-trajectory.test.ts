import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
} from './testConfig.js';

const execFileAsync = promisify(execFile);
const modelConfig = isRealApiTestEnabled()
  ? expandDeepSeekModelMatrix(
      getEnabledModelConfigs().filter((config) => config.id === 'deepseek')
    ).find((config) => config.model.includes('flash'))
  : undefined;
const enabled = modelConfig !== undefined;
const originalStorageRoot = process.env.BLADE_STORAGE_ROOT;
let originalConfig: RuntimeConfig | null = null;

beforeAll(() => {
  if (!enabled) return;
  originalConfig = getState().config.config;
});

afterAll(() => {
  if (originalConfig) getState().config.actions.setConfig(originalConfig);
  if (originalStorageRoot === undefined) {
    delete process.env.BLADE_STORAGE_ROOT;
  } else {
    process.env.BLADE_STORAGE_ROOT = originalStorageRoot;
  }
});

async function readRequestBody(request: import('node:http').IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function upstreamUrl(baseUrl: string, requestUrl: string | undefined): URL {
  const target = new URL(baseUrl);
  const incoming = new URL(requestUrl ?? '/', 'http://127.0.0.1');
  target.pathname = `${target.pathname.replace(/\/$/, '')}/${incoming.pathname.replace(
    /^\//,
    ''
  )}`;
  target.search = incoming.search;
  return target;
}

async function startTransientProxy(baseUrl: string) {
  let requestCount = 0;
  let injectedFailures = 0;
  const privateBodyMarker = 'PRIVATE_PROVIDER_RETRY_BODY_MUST_NOT_SURFACE';
  const server = createServer((request, response) => {
    void (async () => {
      const body = await readRequestBody(request);
      requestCount++;
      if (injectedFailures === 0) {
        injectedFailures++;
        response.writeHead(503, {
          'content-type': 'application/json',
          'retry-after': '0',
        });
        response.end(
          JSON.stringify({
            error: { type: 'server_error', message: privateBodyMarker },
          })
        );
        return;
      }

      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (!value || name === 'host' || name === 'content-length') continue;
        headers.set(name, Array.isArray(value) ? value.join(', ') : value);
      }
      const upstream = await fetch(upstreamUrl(baseUrl, request.url), {
        method: request.method ?? 'POST',
        headers,
        body: request.method === 'GET' || request.method === 'HEAD' ? undefined : body,
        redirect: 'manual',
      });
      const responseHeaders: Record<string, string> = {};
      upstream.headers.forEach((value, name) => {
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
      response.writeHead(upstream.status, responseHeaders);
      if (upstream.body) {
        const reader = upstream.body.getReader();
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          response.write(Buffer.from(chunk.value));
        }
      }
      response.end();
    })().catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined);
        return;
      }
      response.writeHead(502, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { type: 'proxy_error' } }));
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
    baseURL: `http://127.0.0.1:${address.port}`,
    privateBodyMarker,
    requestCount: () => requestCount,
    injectedFailures: () => injectedFailures,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

describe.skipIf(!enabled)('Provider retry trajectory (real API)', () => {
  it('recovers one coding turn from an injected pre-stream 503', async () => {
    if (!modelConfig) throw new Error('DeepSeek Flash configuration is required');
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'blade-provider-retry-'));
    const proxy = await startTransientProxy(
      modelConfig.baseURL ?? 'https://api.deepseek.com'
    );
    let output = '';
    let errorOutput = '';

    try {
      process.env.BLADE_STORAGE_ROOT = path.join(workspace, '.blade-storage');
      getState().config.actions.setConfig({
        ...buildRealApiRuntimeConfig({ ...modelConfig, baseURL: proxy.baseURL }),
        permissionMode: PermissionMode.YOLO,
      });
      await mkdir(path.join(workspace, 'src'), { recursive: true });
      await mkdir(path.join(workspace, 'test'), { recursive: true });
      await writeFile(
        path.join(workspace, 'package.json'),
        `${JSON.stringify({
          name: 'blade-provider-retry-fixture',
          private: true,
          type: 'module',
          scripts: { test: 'node --test' },
        })}\n`
      );
      await writeFile(
        path.join(workspace, 'src', 'add.js'),
        'export function add(left, right) {\n  return left - right;\n}\n'
      );
      await writeFile(
        path.join(workspace, 'test', 'add.test.js'),
        [
          "import assert from 'node:assert/strict';",
          "import test from 'node:test';",
          "import { add } from '../src/add.js';",
          '',
          "test('adds two numbers', () => {",
          '  assert.equal(add(4, 3), 7);',
          '});',
          '',
        ].join('\n')
      );

      const exitCode = await runWithCwdOverride(workspace, () =>
        runHeadless(
          {
            headless: true,
            outputFormat: 'jsonl',
            maxTurns: 12,
            allowedTools: ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash'],
            appendSystemPrompt:
              'After editing the source, call Bash with exactly "npm test".',
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
      const retryEvents = events.filter((event) => event.type === 'provider_retry');
      const mutationStarts = events.filter(
        (event) =>
          event.type === 'tool_start' &&
          (event.tool_name === 'Edit' || event.tool_name === 'Write')
      );

      expect(exitCode, errorOutput.replaceAll(modelConfig.apiKey, '[redacted]')).toBe(
        0
      );
      expect(proxy.injectedFailures()).toBe(1);
      expect(proxy.requestCount()).toBeGreaterThanOrEqual(2);
      expect(retryEvents.slice(0, 3).map((event) => event.phase)).toEqual([
        'scheduled',
        'attempt',
        'recovered',
      ]);
      expect(retryEvents[0]).toMatchObject({
        attempt: 1,
        max_retries: 2,
        reason: 'server_error',
        status_code: 503,
        delay_ms: 0,
      });
      expect(mutationStarts).toHaveLength(1);
      expect(
        events.filter(
          (event) => event.type === 'tool_start' && event.tool_name === 'Bash'
        )
      ).toHaveLength(1);
      expect(await readFile(path.join(workspace, 'src', 'add.js'), 'utf8')).toContain(
        'return left + right;'
      );
      const verification = await execFileAsync(process.execPath, ['--test'], {
        cwd: workspace,
        timeout: 30_000,
      });
      expect(verification.stdout).toContain('pass 1');
      expect(`${output}\n${errorOutput}`).not.toContain(proxy.privateBodyMarker);
      expect(`${output}\n${errorOutput}`).not.toContain(modelConfig.apiKey);
    } finally {
      await proxy.close();
      await rm(workspace, { recursive: true, force: true });
    }
  }, 180_000);
});
