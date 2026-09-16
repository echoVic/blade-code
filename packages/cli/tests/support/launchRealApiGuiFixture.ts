import { execFile, spawn } from 'node:child_process';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { materializeRealApiEnvironment } from '../../scripts/real-api-credentials.js';
import {
  buildRealApiRuntimeConfig,
  resolveForkQualificationModels,
} from '../integration/real-api/testConfig.js';

const execFileAsync = promisify(execFile);

type RuntimeConfig = ReturnType<typeof buildRealApiRuntimeConfig>;

export interface RealApiGuiFixtureContext {
  root: string;
  home: string;
  workspace: string;
  storage: string;
  port: number;
  runtimeConfig: RuntimeConfig;
}

interface RealApiGuiFixtureOptions {
  scriptName: string;
  defaultPort: number;
  readme: string;
  workspaceName?: string;
  configure(context: RealApiGuiFixtureContext): {
    config: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  };
}

export async function launchRealApiGuiFixture(
  options: RealApiGuiFixtureOptions
): Promise<void> {
  const [root, rawPort = String(options.defaultPort)] = process.argv.slice(2);
  if (!root || !path.isAbsolute(root) || !/^\d+$/.test(rawPort)) {
    throw new Error(`Usage: bun ${options.scriptName} <absolute-root> [port]`);
  }

  const home = path.join(root, 'home');
  const workspace = path.join(root, options.workspaceName ?? 'project');
  const storage = path.join(root, 'storage');
  const port = Number(rawPort);
  for (const [name, value] of Object.entries(
    materializeRealApiEnvironment(process.env)
  )) {
    if (value !== undefined) process.env[name] = value;
  }
  process.env.REAL_API_TEST = '1';
  process.env.HOME = home;
  process.env.BLADE_STORAGE_ROOT = storage;

  const model = resolveForkQualificationModels(process.env).find(
    (candidate) =>
      candidate.id === 'deepseek' && candidate.model === 'deepseek-v4-flash'
  );
  if (!model) throw new Error('DeepSeek Flash qualification model is unavailable');
  const runtimeConfig = buildRealApiRuntimeConfig(model);
  const context = { root, home, workspace, storage, port, runtimeConfig };
  const fixture = options.configure(context);

  await Promise.all([
    mkdir(path.join(home, '.blade'), { recursive: true }),
    mkdir(workspace, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      path.join(home, '.blade', 'config.json'),
      `${JSON.stringify(
        {
          currentModelId: runtimeConfig.currentModelId,
          models: runtimeConfig.models,
          modelProviders: runtimeConfig.modelProviders,
          ...fixture.config,
        },
        null,
        2
      )}\n`
    ),
    writeFile(path.join(workspace, 'README.md'), options.readme),
  ]);
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
  const child = spawn(process.execPath, [bladeEntry, 'serve', '--port', String(port)], {
    cwd: canonicalWorkspace,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  process.stdout.write(
    `${JSON.stringify({
      home,
      workspace: canonicalWorkspace,
      storage,
      port,
      ...fixture.metadata,
    })}\n`
  );

  const stop = () => child.kill('SIGTERM');
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code && code !== 0) {
        reject(new Error(`Blade server exited with code ${code}`));
      } else if (signal && signal !== 'SIGTERM') {
        reject(new Error(`Blade server exited from signal ${signal}`));
      } else {
        resolve();
      }
    });
  });
}
