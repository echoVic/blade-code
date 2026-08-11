import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { materializeRealApiEnvironment } from '../../scripts/real-api-credentials.js';
import {
  buildRealApiRuntimeConfig,
  resolveForkQualificationModels,
} from '../integration/real-api/testConfig.js';

const execFileAsync = promisify(execFile);
const [root, rawPort = '4341'] = process.argv.slice(2);
if (!root || !path.isAbsolute(root) || !/^\d+$/.test(rawPort)) {
  throw new Error('Usage: bun launch-code-review-gui.ts <absolute-root> [port]');
}

const port = Number(rawPort);
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
const config = buildRealApiRuntimeConfig(model);

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
      permissionMode: 'default',
      hooks: { enabled: false },
      disableAllHooks: true,
      mcpServers: {},
    },
    null,
    2
  )}\n`
);

const target = path.join(workspace, 'authorization.ts');
await writeFile(
  target,
  [
    'export interface User {',
    '  id: string;',
    '  isAdmin: boolean;',
    '}',
    '',
    'export function isAuthorized(user: User, resourceOwnerId: string) {',
    '  if (user.isAdmin) return true;',
    '  return user.id === resourceOwnerId;',
    '}',
    '',
  ].join('\n')
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
await writeFile(
  target,
  [
    'export interface User {',
    '  id: string;',
    '  isAdmin: boolean;',
    '}',
    '',
    'export function isAuthorized(user: User, resourceOwnerId: string) {',
    '  if (user.isAdmin) return true;',
    '  return (user.id = resourceOwnerId);',
    '}',
    '',
  ].join('\n')
);

const canonicalWorkspace = await realpath(workspace);
const beforeContent = await readFile(target, 'utf8');
const beforeStatus = (
  await execFileAsync('git', ['status', '--porcelain=v1'], {
    cwd: canonicalWorkspace,
    encoding: 'utf8',
  })
).stdout.trim();

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
    target,
    beforeContent,
    beforeStatus,
    port,
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
      return;
    }
    if (signal && signal !== 'SIGTERM') {
      reject(new Error(`Blade server exited from signal ${signal}`));
      return;
    }
    resolve();
  });
});
