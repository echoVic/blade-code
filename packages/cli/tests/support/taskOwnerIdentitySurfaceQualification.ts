import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  realpath,
  writeFile,
} from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { spawn as spawnPty } from 'bun-pty';
import { chromium } from 'playwright';
import { SessionLease } from '../../src/agent/runtime/SessionLease.js';
import { getProjectStoragePath } from '../../src/context/storage/pathUtils.js';
import { SessionService } from '../../src/services/SessionService.js';
import { reserveLoopbackPort as reservePort } from './asyncTestUtils.js';
import { createTuiPtyEnvironment } from './ptyInput.js';

const root = await realpath(
  await mkdtemp(
    path.join(process.platform === 'darwin' ? '/tmp' : os.tmpdir(), 'bladeowner')
  )
);
const workspace = path.join(root, 'team-project_with_underscore');
const storage = path.join(root, 'storage');
const home = path.join(root, 'home');
const repo = path.resolve(import.meta.dirname, '../../../..');
const backendPort = await reservePort();
const frontendPort = await reservePort();
await mkdir(workspace, { recursive: true });
await mkdir(path.join(home, '.blade'), { recursive: true });
await writeFile(
  path.join(home, '.blade', 'config.json'),
  JSON.stringify({
    currentModelId: 'offline-ui',
    models: [{ id: 'offline-ui', provider: 'deepseek', model: 'deepseek-v4-flash' }],
    hooks: { enabled: false },
    disableAllHooks: true,
    mcpServers: {},
  }),
  { mode: 0o600 }
);
process.env.BLADE_STORAGE_ROOT = storage;
const environment = {
  ...process.env,
  HOME: home,
  BLADE_STORAGE_ROOT: storage,
  BLADE_VERSION: '999.0.0',
  BLADE_AUTO_MEMORY: '0',
  BLADE_TELEMETRY_DISABLED: '1',
};
const children: ChildProcess[] = [];
let serverOutput = '';
let liveLease: SessionLease | undefined;
const result: Record<string, unknown> = { root, workspace };
const proxySockets = new Set<Socket>();
let registryConnects = 0;
const otherProxyRequests: string[] = [];
const stalledProxy = createServer((socket) => {
  proxySockets.add(socket);
  socket.once('close', () => proxySockets.delete(socket));
  socket.once('data', (data) => {
    if (data.toString().startsWith('CONNECT registry.npmjs.org:443')) {
      registryConnects++;
    } else {
      otherProxyRequests.push(data.toString().split('\r\n')[0] ?? 'unknown');
    }
  });
});

async function waitFor(check: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(label);
}

async function seed(sessionId: string, title: string, stale: boolean) {
  await SessionService.createSessionMetadata(sessionId, workspace, { title });
  await SessionService.updateSessionMetadata(sessionId, workspace, {
    taskStatus: 'running',
    taskOwnerPid: process.pid,
  });
  if (stale) {
    const digest = createHash('sha256').update(sessionId).digest('hex');
    const file = path.join(
      getProjectStoragePath(workspace),
      '.locks',
      `${digest}.lock`
    );
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        sessionId,
        ownerId: 'stale-ui-owner',
        pid: process.pid,
        processIdentity: { platform: process.platform, fingerprint: '0'.repeat(64) },
        acquiredAt: '2024-01-01T00:00:00.000Z',
      }),
      { mode: 0o600 }
    );
  }
}

function launch(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = environment
) {
  const child = spawn(command, args, {
    cwd,
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  child.stdout?.on('data', (data) => {
    serverOutput = (serverOutput + data).slice(-16_000);
  });
  child.stderr?.on('data', (data) => {
    serverOutput = (serverOutput + data).slice(-16_000);
  });
  return child;
}

try {
  await new Promise<void>((resolve, reject) => {
    stalledProxy.once('error', reject);
    stalledProxy.listen(0, '127.0.0.1', resolve);
  });
  const proxyAddress = stalledProxy.address();
  assert(proxyAddress && typeof proxyAddress !== 'string');
  await seed('ui-active-owner', 'OWNER ACTIVE', false);
  liveLease = await SessionLease.acquire('ui-active-owner', workspace);
  await seed('ui-orphan-owner', 'OWNER ORPHAN', true);
  launch(
    'node',
    [
      path.join(repo, 'packages/cli/dist/blade.js'),
      '--debug',
      'Service',
      '--trust-workspace',
      'serve',
      '--port',
      String(backendPort),
    ],
    workspace,
    { ...environment, HTTPS_PROXY: `http://127.0.0.1:${proxyAddress.port}` }
  );
  const vite = launch(
    'bun',
    [
      'run',
      '--filter',
      'blade-web',
      'dev',
      '--host',
      '127.0.0.1',
      '--port',
      String(frontendPort),
    ],
    repo,
    { ...environment, VITE_API_TARGET: `http://127.0.0.1:${backendPort}` }
  );
  await waitFor(async () => {
    try {
      return (await fetch(`http://127.0.0.1:${frontendPort}/health`)).ok;
    } catch {
      return false;
    }
  }, 'Web dev server not ready');
  assert.equal(vite.exitCode, null);
  const browserScript = path.join(import.meta.dirname, 'taskOwnerIdentityChromium.py');
  const browser = spawn(
    'python3',
    [
      browserScript,
      `http://127.0.0.1:${frontendPort}`,
      root,
      chromium.executablePath(),
    ],
    {
      env: environment,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  children.push(browser);
  let browserOutput = '';
  browser.stdout?.on('data', (data) => {
    browserOutput += data;
  });
  browser.stderr?.on('data', (data) => {
    browserOutput += data;
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    browser.once('exit', resolve);
    browser.once('error', reject);
  });
  await writeFile(path.join(root, 'browser.log'), browserOutput);
  assert.equal(code, 0, browserOutput);
  result.web = JSON.parse(browserOutput.trim());

  await seed('ui-pty-orphan', 'OWNER PTY ORPHAN', true);
  const terminal = spawnPty(
    'node',
    [path.join(repo, 'packages/cli/dist/blade.js'), '--trust-workspace', '--resume'],
    {
      cwd: workspace,
      cols: 140,
      rows: 45,
      name: 'xterm-256color',
      env: createTuiPtyEnvironment(environment),
    }
  );
  let ptyOutput = '';
  let exited = false;
  const exit = new Promise<void>((resolve) =>
    terminal.onExit(() => {
      exited = true;
      resolve();
    })
  );
  terminal.onData((data) => {
    ptyOutput = (ptyOutput + stripVTControlCharacters(data)).slice(-48_000);
  });
  try {
    await waitFor(
      () => /\[INTERRUPTED\] OWNER PTY ORPHAN/.test(ptyOutput),
      'TUI did not show recovered interrupted task'
    );
    assert.match(ptyOutput, /\[RUNNING\] OWNER ACTIVE/);
    await writeFile(path.join(root, 'pty.txt'), ptyOutput);
    result.pty = { interrupted: true, activePreserved: true };
  } finally {
    if (!exited) terminal.kill('SIGTERM');
    await Promise.race([exit, new Promise((resolve) => setTimeout(resolve, 3000))]);
    if (!exited) terminal.kill('SIGKILL');
    await exit;
  }
  const startupEvidence = [];
  for (const executable of ['node', 'bun']) {
    const startupHome = path.join(root, `startup-${executable}`);
    await mkdir(path.join(startupHome, '.blade'), { recursive: true });
    await copyFile(
      path.join(home, '.blade', 'config.json'),
      path.join(startupHome, '.blade', 'config.json')
    );
    await assert.rejects(access(path.join(startupHome, '.blade', 'skills')), {
      code: 'ENOENT',
    });
    const previousConnects = registryConnects;
    const startedAt = Date.now();
    const startupTerminal = spawnPty(
      executable,
      [path.join(repo, 'packages/cli/dist/blade.js'), '--trust-workspace', '--resume'],
      {
        cwd: workspace,
        cols: 140,
        rows: 45,
        name: 'xterm-256color',
        env: createTuiPtyEnvironment({
          ...environment,
          HOME: startupHome,
          HTTPS_PROXY: `http://127.0.0.1:${proxyAddress.port}`,
        }),
      }
    );
    let startupOutput = '';
    let startupExited = false;
    const startupExit = new Promise<void>((resolve) =>
      startupTerminal.onExit(() => {
        startupExited = true;
        resolve();
      })
    );
    startupTerminal.onData((data) => {
      startupOutput = (startupOutput + stripVTControlCharacters(data)).slice(-48_000);
    });
    try {
      await waitFor(
        () => /\[INTERRUPTED\] OWNER PTY ORPHAN/.test(startupOutput),
        `${executable} TUI did not start while registry was stalled`
      );
      assert(
        registryConnects > previousConnects,
        `${executable} did not attempt a registry connection`
      );
      assert(
        proxySockets.size > 0,
        `${executable} waited until its registry request ended`
      );
      assert.doesNotMatch(startupOutput, /Update available!/);
      const readyMs = Date.now() - startedAt;
      await waitFor(
        () => proxySockets.size === 0,
        `${executable} registry connections outlived the deadline`
      );
      assert.equal(startupExited, false);
      assert.deepEqual(otherProxyRequests, []);
      await assert.rejects(access(path.join(startupHome, '.blade', 'skills')), {
        code: 'ENOENT',
      });
      startupEvidence.push({
        executable,
        noSkillDownload: true,
        readyWhileRegistryPending: true,
        readyMs,
        registryDeadlineReleased: true,
      });
    } finally {
      await writeFile(path.join(root, `startup-${executable}.txt`), startupOutput);
      if (!startupExited) startupTerminal.kill('SIGTERM');
      await Promise.race([
        startupExit,
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]);
      if (!startupExited) startupTerminal.kill('SIGKILL');
      await startupExit;
      for (const socket of proxySockets) socket.destroy();
      await waitFor(
        () => proxySockets.size === 0,
        'Startup proxy connections did not close'
      );
    }
  }
  result.startup = startupEvidence;
  const cachedHome = path.join(root, 'startup-node');
  await writeFile(
    path.join(cachedHome, '.blade', 'version-cache.json'),
    JSON.stringify({ latestVersion: '999.0.1', checkedAt: Date.now() })
  );
  const beforeCached = registryConnects;
  const cachedTerminal = spawnPty(
    'node',
    [path.join(repo, 'packages/cli/dist/blade.js'), '--trust-workspace', '--resume'],
    {
      cwd: workspace,
      cols: 140,
      rows: 45,
      name: 'xterm-256color',
      env: createTuiPtyEnvironment({
        ...environment,
        HOME: cachedHome,
        HTTPS_PROXY: `http://127.0.0.1:${proxyAddress.port}`,
      }),
    }
  );
  let cachedOutput = '';
  let cachedExited = false;
  const cachedExit = new Promise<void>((resolve) =>
    cachedTerminal.onExit(() => {
      cachedExited = true;
      resolve();
    })
  );
  cachedTerminal.onData((data) => {
    cachedOutput = (cachedOutput + stripVTControlCharacters(data)).slice(-48_000);
  });
  try {
    await waitFor(
      () => cachedOutput.includes('Update available!'),
      'Fresh cached update did not show its prompt'
    );
    assert.equal(registryConnects, beforeCached);
    cachedTerminal.write('2');
    await waitFor(
      () => /\[INTERRUPTED\] OWNER PTY ORPHAN/.test(cachedOutput),
      'Skip update did not return to the session selector'
    );
    result.cachedUpdate = {
      promptShown: true,
      skipContinued: true,
      noRegistryRequest: registryConnects === beforeCached,
    };
  } finally {
    await writeFile(path.join(root, 'cached-update.txt'), cachedOutput);
    if (!cachedExited) cachedTerminal.kill('SIGTERM');
    await Promise.race([
      cachedExit,
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
    if (!cachedExited) cachedTerminal.kill('SIGKILL');
    await cachedExit;
  }
  await writeFile(path.join(root, 'result.json'), JSON.stringify(result, null, 2));
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  await writeFile(path.join(root, 'server.log'), serverOutput);
  process.stderr.write(`Surface qualification failed; evidence=${root}\n`);
  throw error;
} finally {
  for (const child of children.reverse()) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM');
    else child.kill('SIGTERM');
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
    if (child.exitCode === null && child.signalCode === null) {
      if (child.pid && process.platform !== 'win32')
        process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    }
    await exited;
  }
  for (const socket of proxySockets) socket.destroy();
  if (stalledProxy.listening) {
    await new Promise<void>((resolve, reject) =>
      stalledProxy.close((error) => (error ? reject(error) : resolve()))
    );
  }
  await liveLease?.release();
}
