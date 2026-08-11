import { execFile, spawn } from 'node:child_process';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { materializeRealApiEnvironment } from '../../scripts/real-api-credentials.js';
import { PermissionMode } from '../../src/config/types.js';
import {
  buildRealApiRuntimeConfig,
  resolveForkQualificationModels,
} from '../integration/real-api/testConfig.js';

const [root, mode = 'web', rawPort = '4346'] = process.argv.slice(2);
if (
  !root ||
  !path.isAbsolute(root) ||
  !['web', 'tui'].includes(mode) ||
  !/^\d+$/.test(rawPort)
) {
  throw new Error(
    'Usage: bun launch-reactive-compaction.ts <absolute-root> <web|tui> [port]'
  );
}

const port = Number(rawPort);
const execFileAsync = promisify(execFile);
const home = path.join(root, 'home');
const workspace = path.join(root, 'project');
const storage = path.join(root, 'storage');
const projectedEnvironment = materializeRealApiEnvironment(process.env);
for (const [name, value] of Object.entries(projectedEnvironment)) {
  if (value !== undefined) process.env[name] = value;
}
process.env.REAL_API_TEST = '1';
process.env.HOME = home;
process.env.BLADE_STORAGE_ROOT = storage;
process.env.BLADE_TELEMETRY_DISABLED = '1';

const model = resolveForkQualificationModels(process.env).find(
  (candidate) => candidate.id === 'deepseek' && candidate.model === 'deepseek-v4-flash'
);
if (!model) throw new Error('DeepSeek Flash qualification model is unavailable');

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

async function startProxy(baseUrl: string) {
  let requestCount = 0;
  let contextLimitCount = 0;
  let delayedCompactions = 0;
  let closePromise: Promise<void> | undefined;
  const server = createServer((request, response) => {
    void (async () => {
      const body = await readRequestBody(request);
      const requestNumber = ++requestCount;
      if (contextLimitCount === 0) {
        contextLimitCount++;
        response.writeHead(413, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            error: {
              type: 'invalid_request_error',
              code: 'context_length_exceeded',
              message: 'context_length_exceeded',
            },
          })
        );
        process.stdout.write('[reactive-compaction-proxy] injected context limit\n');
        return;
      }
      if (requestNumber === 2) {
        delayedCompactions++;
        process.stdout.write('[reactive-compaction-proxy] compaction delayed\n');
        await new Promise((resolve) => setTimeout(resolve, 5_000));
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
    counts: () => ({ requestCount, contextLimitCount, delayedCompactions }),
    close: () => {
      if (closePromise) return closePromise;
      server.closeAllConnections();
      closePromise = new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (
            !error ||
            (error as NodeJS.ErrnoException).code === 'ERR_SERVER_NOT_RUNNING'
          ) {
            resolve();
            return;
          }
          reject(error);
        });
      });
      return closePromise;
    },
  };
}

const proxy = await startProxy(model.baseURL ?? 'https://api.deepseek.com');
const config = buildRealApiRuntimeConfig({ ...model, baseURL: proxy.baseURL });
await Promise.all([
  mkdir(path.join(home, '.blade'), { recursive: true }),
  mkdir(workspace, { recursive: true }),
]);
await writeFile(
  path.join(home, '.blade', 'config.json'),
  `${JSON.stringify(
    {
      currentModelId: config.currentModelId,
      models: config.models,
      modelProviders: config.modelProviders,
      permissionMode: PermissionMode.YOLO,
      hooks: { enabled: false },
      disableAllHooks: true,
      mcpServers: {},
    },
    null,
    2
  )}\n`
);
await writeFile(
  path.join(workspace, 'README.md'),
  '# Reactive compaction qualification\n'
);
await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: workspace });
await execFileAsync('git', ['config', 'user.email', 'blade@example.test'], {
  cwd: workspace,
});
await execFileAsync('git', ['config', 'user.name', 'Blade Test'], {
  cwd: workspace,
});
await execFileAsync('git', ['add', '.'], { cwd: workspace });
await execFileAsync('git', ['commit', '-qm', 'fixture'], { cwd: workspace });
const canonicalWorkspace = await realpath(workspace);
const bladeEntry = path.resolve(import.meta.dirname, '../../dist/blade.js');
const args =
  mode === 'web' ? [bladeEntry, 'serve', '--port', String(port)] : [bladeEntry];
const child = spawn(process.execPath, args, {
  cwd: canonicalWorkspace,
  env: process.env,
  stdio: mode === 'web' ? ['ignore', 'pipe', 'pipe'] : 'inherit',
});
if (mode === 'web') {
  child.stdout?.pipe(process.stdout);
  child.stderr?.pipe(process.stderr);
}
process.stdout.write(
  `${JSON.stringify({
    home,
    workspace: canonicalWorkspace,
    storage,
    mode,
    port,
    proxy: proxy.baseURL,
    model: model.model,
    prompt:
      'Remember marker REACTIVE_SURFACE_MEMORY_7319. Reply with exactly REACTIVE_SURFACE_OK and nothing else.',
  })}\n`
);

const stop = () => child.kill('SIGTERM');
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
try {
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code && code !== 0) {
        reject(new Error(`Blade ${mode} exited with code ${code}`));
        return;
      }
      if (signal && signal !== 'SIGTERM') {
        reject(new Error(`Blade ${mode} exited from signal ${signal}`));
        return;
      }
      resolve();
    });
  });
} finally {
  process.stdout.write(
    `${JSON.stringify({ mode, ...proxy.counts(), stopped: true })}\n`
  );
  await proxy.close();
}
