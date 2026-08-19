import { execFile, spawn } from 'node:child_process';
import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { materializeRealApiEnvironment } from '../../scripts/real-api-credentials.js';
import { PermissionMode } from '../../src/config/types.js';
import {
  buildRealApiRuntimeConfig,
  resolveRequiredDeepSeekQualificationModels,
} from '../integration/real-api/testConfig.js';

interface LauncherInput {
  root: string;
  workspace: string;
  home: string;
  storageRoot: string;
  port: number;
  model: string;
  proxyBaseURL: string;
}

const execFileAsync = promisify(execFile);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidPort(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= 65_535
  );
}

function canonicalBase64(value: string): Buffer {
  if (
    !value ||
    value.length > 64_000 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw new Error('Token-budget GUI input encoding is invalid');
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) {
    throw new Error('Token-budget GUI input encoding is not canonical');
  }
  return decoded;
}

function loadInput(): LauncherInput {
  const encoded = process.env.BLADE_TOKEN_BUDGET_WEB_INPUT;
  if (!encoded) throw new Error('Token-budget GUI input is missing');
  let serialized: string;
  let parsed: unknown;
  try {
    serialized = canonicalBase64(encoded).toString('utf8');
    parsed = JSON.parse(serialized);
  } catch (error) {
    if (error instanceof Error && error.message.includes('Token-budget')) throw error;
    throw new Error('Token-budget GUI input is invalid');
  }
  const keys = [
    'home',
    'model',
    'port',
    'proxyBaseURL',
    'root',
    'storageRoot',
    'workspace',
  ];
  if (
    JSON.stringify(parsed) !== serialized ||
    !isRecord(parsed) ||
    Object.keys(parsed).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(parsed, key)) ||
    typeof parsed.root !== 'string' ||
    typeof parsed.workspace !== 'string' ||
    typeof parsed.home !== 'string' ||
    typeof parsed.storageRoot !== 'string' ||
    typeof parsed.model !== 'string' ||
    typeof parsed.proxyBaseURL !== 'string' ||
    !isValidPort(parsed.port) ||
    !path.isAbsolute(parsed.root) ||
    !path.isAbsolute(parsed.workspace) ||
    !path.isAbsolute(parsed.home) ||
    !path.isAbsolute(parsed.storageRoot)
  ) {
    throw new Error('Token-budget GUI input shape is invalid');
  }
  const proxy = new URL(parsed.proxyBaseURL);
  if (
    proxy.protocol !== 'http:' ||
    !['127.0.0.1', '::1', 'localhost'].includes(proxy.hostname) ||
    proxy.username ||
    proxy.password ||
    proxy.search ||
    proxy.hash
  ) {
    throw new Error('Token-budget GUI proxy must be a clean loopback HTTP URL');
  }
  return {
    root: path.resolve(parsed.root),
    workspace: path.resolve(parsed.workspace),
    home: path.resolve(parsed.home),
    storageRoot: path.resolve(parsed.storageRoot),
    port: parsed.port,
    model: parsed.model,
    proxyBaseURL: proxy.href.replace(/\/$/, ''),
  };
}

async function ensureGitFixture(workspace: string): Promise<void> {
  try {
    await access(path.join(workspace, '.git'));
    return;
  } catch {
    // The isolated qualification workspace has not been initialized yet.
  }
  await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: workspace });
  await execFileAsync('git', ['config', 'user.email', 'blade@example.test'], {
    cwd: workspace,
  });
  await execFileAsync('git', ['config', 'user.name', 'Blade Test'], {
    cwd: workspace,
  });
  await execFileAsync('git', ['add', '.'], { cwd: workspace });
  await execFileAsync('git', ['commit', '-qm', 'fixture'], { cwd: workspace });
}

async function main(): Promise<void> {
  const input = loadInput();
  delete process.env.BLADE_TOKEN_BUDGET_WEB_INPUT;
  const projectedEnvironment = materializeRealApiEnvironment(process.env);
  for (const [name, value] of Object.entries(projectedEnvironment)) {
    if (value !== undefined) process.env[name] = value;
  }
  process.env.REAL_API_TEST = '1';
  process.env.HOME = input.home;
  process.env.BLADE_STORAGE_ROOT = input.storageRoot;
  process.env.BLADE_AUTO_MEMORY = '0';
  process.env.BLADE_TELEMETRY_DISABLED = '1';

  const selected = resolveRequiredDeepSeekQualificationModels(process.env).find(
    (candidate) => candidate.model === input.model
  );
  if (!selected) throw new Error('Token-budget GUI model is unavailable');
  const config = buildRealApiRuntimeConfig({
    ...selected,
    baseURL: input.proxyBaseURL,
  });
  await Promise.all([
    mkdir(path.join(input.home, '.blade'), { recursive: true }),
    mkdir(input.workspace, { recursive: true }),
    mkdir(input.storageRoot, { recursive: true }),
  ]);
  await writeFile(
    path.join(input.home, '.blade', 'config.json'),
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
    )}\n`,
    { mode: 0o600 }
  );
  await ensureGitFixture(input.workspace);

  const bladeEntry = path.resolve(import.meta.dirname, '../../dist/blade.js');
  const child = spawn(
    process.execPath,
    [bladeEntry, 'serve', '--hostname', '127.0.0.1', '--port', String(input.port)],
    {
      cwd: input.workspace,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  process.stdout.write(`${JSON.stringify({ ready: true, port: input.port })}\n`);

  const stop = (): void => {
    child.kill('SIGTERM');
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code && code !== 0) {
        reject(new Error('Token-budget Blade server exited unsuccessfully'));
        return;
      }
      if (signal && signal !== 'SIGTERM') {
        reject(new Error('Token-budget Blade server exited from an unexpected signal'));
        return;
      }
      resolve();
    });
  });
}

if (import.meta.main) {
  await main();
}
