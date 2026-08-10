import { execFile, spawn } from 'node:child_process';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { materializeRealApiEnvironment } from '../../scripts/real-api-credentials.js';
import { PermissionMode } from '../../src/config/types.js';
import {
  buildRealApiRuntimeConfig,
  resolveForkQualificationModels,
} from '../integration/real-api/testConfig.js';

const execFileAsync = promisify(execFile);
const [root, rawPort = '4326'] = process.argv.slice(2);
if (!root || !path.isAbsolute(root) || !/^\d+$/.test(rawPort)) {
  throw new Error(
    'Usage: bun launch-independent-verification-gui.ts <absolute-root> [port]'
  );
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

async function write(relativeRoot: string, relativePath: string, content: string) {
  const filePath = path.join(relativeRoot, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf8');
}

await write(
  home,
  '.blade/config.json',
  `${JSON.stringify(
    {
      currentModelId: config.currentModelId,
      models: config.models,
      modelProviders: config.modelProviders,
      permissionMode: PermissionMode.YOLO,
    },
    null,
    2
  )}\n`
);
await write(
  workspace,
  'package.json',
  `${JSON.stringify(
    {
      name: 'blade-independent-verification-gui',
      private: true,
      type: 'module',
      scripts: { test: 'node --test' },
    },
    null,
    2
  )}\n`
);
for (const name of ['alpha', 'beta', 'gamma']) {
  await write(workspace, `src/${name}.js`, `export const ${name} = false;\n`);
}
await write(
  workspace,
  'test/values.test.js',
  [
    "import assert from 'node:assert/strict';",
    "import test from 'node:test';",
    "import { alpha } from '../src/alpha.js';",
    "import { beta } from '../src/beta.js';",
    "import { gamma } from '../src/gamma.js';",
    '',
    "test('all values are enabled', () => {",
    '  assert.equal(alpha, true);',
    '  assert.equal(beta, true);',
    '  assert.equal(gamma, true);',
    '});',
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
    prompt: [
      'Read src/alpha.js, src/beta.js, and src/gamma.js.',
      'Then call ApplyPatch exactly once to change each exported value from',
      'false to true. Do not modify package.json or the test.',
      'After ApplyPatch succeeds, return exactly WEB_INDEPENDENT_VERIFY_OK.',
    ].join(' '),
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
