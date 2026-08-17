import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { buildRealApiConfig } from './codingTaskHarness.js';
import {
  isRealApiTestEnabled,
  resolveDeepSeekQualificationSettings,
} from './testConfig.js';

const qualification = isRealApiTestEnabled()
  ? resolveDeepSeekQualificationSettings()
  : undefined;
const describeReal = qualification ? describe : describe.skip;
const cliEntry = path.resolve('dist', 'blade.js');
const ptyRunner = path.resolve('tests', 'support', 'tuiPtyRunner.ts');
const execFileAsync = promisify(execFile);

async function startRecordingProxy(upstreamBaseUrl: string) {
  const requestBodies: string[] = [];
  const upstream = new URL(upstreamBaseUrl);
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const body = Buffer.concat(chunks);
      requestBodies.push(body.toString('utf8'));

      const incoming = new URL(request.url ?? '/', 'http://blade-proxy.invalid');
      const target = new URL(upstream);
      const incomingPath =
        target.pathname.endsWith('/v1') && incoming.pathname.startsWith('/v1/')
          ? incoming.pathname.slice(3)
          : incoming.pathname;
      target.pathname = `${target.pathname.replace(/\/+$/, '')}/${incomingPath.replace(
        /^\/+/,
        ''
      )}`;
      target.search = incoming.search;

      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (
          value === undefined ||
          ['host', 'connection', 'content-length'].includes(name.toLowerCase())
        ) {
          continue;
        }
        headers.set(name, Array.isArray(value) ? value.join(', ') : value);
      }
      const upstreamResponse = await fetch(target, {
        method: request.method,
        headers,
        body: body.length > 0 ? body : undefined,
      });
      response.statusCode = upstreamResponse.status;
      upstreamResponse.headers.forEach((value, name) => {
        if (
          !['connection', 'content-encoding', 'content-length'].includes(
            name.toLowerCase()
          )
        ) {
          response.setHeader(name, value);
        }
      });
      response.end(Buffer.from(await upstreamResponse.arrayBuffer()));
    })().catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined);
        return;
      }
      response.statusCode = 502;
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          error: { message: 'TUI input qualification proxy failed' },
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
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requestBodies,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

describeReal('production TUI batched input trajectory (real API)', () => {
  it('sends one bracketed paste payload intact to DeepSeek Flash', async () => {
    if (!qualification) throw new Error('DeepSeek qualification is unavailable');
    const model = qualification.models[0];
    const root = await mkdtemp(path.join(os.tmpdir(), 'blade-tui-paste-api-'));
    const workspace = path.join(root, 'workspace');
    const home = path.join(root, 'home');
    const storageRoot = path.join(home, '.blade');
    const proxy = await startRecordingProxy(qualification.baseURL);
    const prompt =
      'Join these tokens without spaces and reply with only the result: ' +
      'TUI_ BRACKETED_ REAL_ API_ OK.';
    const expected = 'TUI_BRACKETED_REAL_API_OK';

    try {
      await Promise.all([
        mkdir(workspace, { recursive: true }),
        mkdir(storageRoot, { recursive: true }),
      ]);
      await writeFile(
        path.join(storageRoot, 'config.json'),
        `${JSON.stringify(
          buildRealApiConfig({
            modelId: model,
            model,
            baseUrl: proxy.baseUrl,
            maxOutputTokens: 128,
          }),
          null,
          2
        )}\n`,
        'utf8'
      );

      const childEnv = Object.fromEntries(
        Object.entries({
          ...process.env,
          HOME: home,
          BLADE_STORAGE_ROOT: storageRoot,
          BLADE_TELEMETRY_DISABLED: '1',
          BLADE_ALLOW_ROOT: '1',
          DEEPSEEK_API_KEY: qualification.apiKey,
          TERM: 'xterm-256color',
          BLADE_TUI_TEST_CLI_ENTRY: cliEntry,
          BLADE_TUI_TEST_WORKSPACE: workspace,
          BLADE_TUI_TEST_PROMPT: prompt,
          BLADE_TUI_TEST_EXPECTED: expected,
          BLADE_TUI_TEST_SESSION_ID: `tui-paste-api-${Date.now()}`,
        }).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
      );
      const child = await execFileAsync('bun', [ptyRunner], {
        cwd: path.resolve('.'),
        env: childEnv,
        timeout: 210_000,
        maxBuffer: 1024 * 1024,
      });
      const evidence = JSON.parse(child.stdout) as {
        success: boolean;
        sawExpected: boolean;
        output: string;
      };

      expect(proxy.requestBodies.length).toBeGreaterThan(0);
      expect(proxy.requestBodies.join('\n')).toContain(prompt);
      expect(evidence).toMatchObject({ success: true, sawExpected: true });
      expect(evidence.output).not.toContain(qualification.apiKey);
    } finally {
      await proxy.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  }, 240_000);
});
