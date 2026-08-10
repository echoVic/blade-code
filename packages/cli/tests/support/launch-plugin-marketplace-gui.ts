import { execFile, spawn } from 'node:child_process';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { materializeRealApiEnvironment } from '../../scripts/real-api-credentials.js';
import { PermissionMode } from '../../src/config/types.js';
import { WorkspaceTrustService } from '../../src/security/WorkspaceTrustService.js';
import {
  buildRealApiRuntimeConfig,
  resolveForkQualificationModels,
} from '../integration/real-api/testConfig.js';

const execFileAsync = promisify(execFile);
const [root, rawPort = '4317'] = process.argv.slice(2);
if (!root || !path.isAbsolute(root) || !/^\d+$/.test(rawPort)) {
  throw new Error('Usage: bun launch-plugin-marketplace-gui.ts <absolute-root> [port]');
}

const port = Number(rawPort);
const home = path.join(root, 'home');
const workspace = path.join(root, 'project');
const marketplace = path.join(workspace, 'marketplace');
const storage = path.join(root, 'storage');
const marker = `GUI_MARKETPLACE_${Date.now()}`;
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
  `${JSON.stringify({
    name: 'blade-plugin-marketplace-gui',
    version: '1.0.0',
    private: true,
  })}\n`
);
await write(
  marketplace,
  '.blade-plugin/marketplace.json',
  `${JSON.stringify(
    {
      name: 'gui-market',
      description: 'Production GUI qualification Marketplace',
      plugins: [
        {
          name: 'gui-managed-plugin',
          description: 'Managed GUI qualification plugin',
          version: '1.0.0',
          source: './plugins/gui-managed-plugin',
        },
        {
          name: 'gui-plugin-dependency',
          description: 'Managed GUI plugin dependency',
          version: '1.0.0',
          source: './plugins/gui-plugin-dependency',
        },
      ],
    },
    null,
    2
  )}\n`
);
await write(
  marketplace,
  'plugins/gui-managed-plugin/.blade-plugin/plugin.json',
  `${JSON.stringify({
    name: 'gui-managed-plugin',
    description: 'Managed GUI qualification plugin',
    version: '1.0.0',
    dependencies: {
      'gui-plugin-dependency': '^1.0.0',
    },
  })}\n`
);
await write(
  marketplace,
  'plugins/gui-plugin-dependency/.blade-plugin/plugin.json',
  `${JSON.stringify({
    name: 'gui-plugin-dependency',
    description: 'Managed GUI plugin dependency',
    version: '1.0.0',
  })}\n`
);
await write(
  marketplace,
  'plugins/gui-managed-plugin/commands/reveal.md',
  `---
description: Return the production GUI Marketplace marker
---
Return exactly ${marker}.
`
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
WorkspaceTrustService.resetInstance();
await WorkspaceTrustService.getInstance().trust(canonicalWorkspace);

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
    marketplace: await realpath(marketplace),
    storage,
    marker,
    port,
  })}\n`
);

const stop = () => {
  child.kill('SIGTERM');
};
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
