import { createServer } from 'node:http';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { materializeRealApiEnvironment } from '../../scripts/real-api-credentials.js';
import {
  buildRealApiRuntimeConfig,
  resolveForkQualificationModels,
} from '../integration/real-api/testConfig.js';

const [root, rawPort = '4325', rawCallbackPort = '7787'] = process.argv.slice(2);
if (
  !root ||
  !path.isAbsolute(root) ||
  !/^\d+$/.test(rawPort) ||
  !/^\d+$/.test(rawCallbackPort)
) {
  throw new Error(
    'Usage: bun launch-mcp-oauth-gui.ts <absolute-root> [port] [callback-port]'
  );
}

const port = Number(rawPort);
const callbackPort = Number(rawCallbackPort);
await assertPortAvailable(callbackPort);
const execFileAsync = promisify(execFile);
const home = path.join(root, 'home');
const workspace = path.join(root, 'project');
const storage = path.join(root, 'storage');
const readyFile = path.join(root, 'oauth-ready.json');
const traceFile = path.join(root, 'oauth-trace.jsonl');
const fakeServer = path.resolve(import.meta.dirname, 'fake-mcp-oauth-server.mjs');
const projectedEnvironment = materializeRealApiEnvironment(process.env);
for (const [name, value] of Object.entries(projectedEnvironment)) {
  if (value !== undefined) process.env[name] = value;
}
process.env.REAL_API_TEST = '1';
process.env.HOME = home;
process.env.BLADE_STORAGE_ROOT = storage;

const model = resolveForkQualificationModels(process.env).find(
  (candidate) => candidate.id === 'deepseek' && candidate.model === 'deepseek-v4-flash'
);
if (!model) throw new Error('DeepSeek Flash qualification model is unavailable');
const config = buildRealApiRuntimeConfig(model);

await mkdir(path.join(home, '.blade'), { recursive: true });
await mkdir(workspace, { recursive: true });
const oauthFixture = spawn(process.execPath, [fakeServer], {
  env: {
    ...process.env,
    MCP_OAUTH_READY_FILE: readyFile,
    MCP_OAUTH_TRACE_FILE: traceFile,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
oauthFixture.stdout?.pipe(process.stdout);
oauthFixture.stderr?.pipe(process.stderr);
const ready = await waitForReady(readyFile);

await writeFile(
  path.join(home, '.blade', 'config.json'),
  `${JSON.stringify(
    {
      currentModelId: config.currentModelId,
      models: config.models,
      modelProviders: config.modelProviders,
      mcpServers: {
        oauth: {
          type: 'http',
          url: ready.mcpUrl,
          oauth: {
            enabled: true,
            scopes: ['mcp:tools'],
            callbackPort,
          },
          timeout: 15_000,
          idleTimeout: 5_000,
        },
      },
    },
    null,
    2
  )}\n`
);
await writeFile(path.join(workspace, 'README.md'), '# MCP OAuth GUI fixture\n');
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
const blade = spawn(process.execPath, [bladeEntry, 'serve', '--port', String(port)], {
  cwd: canonicalWorkspace,
  env: process.env,
  stdio: ['ignore', 'pipe', 'pipe'],
});
blade.stdout?.pipe(process.stdout);
blade.stderr?.pipe(process.stderr);
process.stdout.write(
  `${JSON.stringify({
    home,
    workspace: canonicalWorkspace,
    storage,
    traceFile,
    oauthPid: ready.pid,
    oauthOrigin: ready.origin,
    port,
    callbackPort,
  })}\n`
);

const stop = () => {
  blade.kill('SIGTERM');
  oauthFixture.kill('SIGTERM');
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
process.once('exit', stop);
await new Promise<void>((resolve, reject) => {
  blade.once('error', reject);
  blade.once('exit', (code, signal) => {
    if (code && code !== 0) {
      reject(new Error(`Blade server exited with code ${code}`));
      return;
    }
    if (signal && signal !== 'SIGTERM') {
      reject(new Error(`Blade server exited from signal ${signal}`));
      return;
    }
    resolve();
  });
});
oauthFixture.kill('SIGTERM');
await waitForExit(oauthFixture);

interface OAuthReady {
  pid: number;
  origin: string;
  mcpUrl: string;
}

async function waitForReady(filePath: string): Promise<OAuthReady> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(filePath, 'utf8')) as OAuthReady;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error('Timed out waiting for OAuth fixture');
}

async function assertPortAvailable(targetPort: number): Promise<void> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(targetPort, '127.0.0.1', resolve);
  });
  await new Promise<void>((resolve) => probe.close(() => resolve()));
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
}
