import { execFile, spawn } from 'node:child_process';
import { appendFile, mkdir, realpath, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { promisify } from 'node:util';
import { materializeRealApiEnvironment } from '../../scripts/real-api-credentials.js';
import {
  buildRealApiRuntimeConfig,
  resolveForkQualificationModels,
} from '../integration/real-api/testConfig.js';

const [root, rawPort = '4336'] = process.argv.slice(2);
if (!root || !path.isAbsolute(root) || !/^\d+$/.test(rawPort)) {
  throw new Error('Usage: bun launch-reasoning-effort-gui.ts <absolute-root> [port]');
}

const port = Number(rawPort);
const execFileAsync = promisify(execFile);
const home = path.join(root, 'home');
const workspace = path.join(root, 'project');
const storage = path.join(root, 'storage');
const requestEvidence = path.join(root, 'provider-requests.jsonl');
const responseEvidence = path.join(root, 'provider-responses.jsonl');
const projectedEnvironment = materializeRealApiEnvironment(process.env);
for (const [name, value] of Object.entries(projectedEnvironment)) {
  if (value !== undefined) process.env[name] = value;
}
process.env.REAL_API_TEST = '1';
process.env.HOME = home;
process.env.BLADE_STORAGE_ROOT = storage;

const model = resolveForkQualificationModels(process.env).find(
  (candidate) => candidate.id === 'gpt'
);
if (!model?.baseURL) {
  throw new Error('GPT qualification channel is unavailable');
}

const upstream = new URL(model.baseURL);
const proxy = createServer(async (request, response) => {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const body = Buffer.concat(chunks);
    if (body.length > 0) {
      await appendFile(requestEvidence, `${body.toString('utf8')}\n`, {
        mode: 0o600,
      });
    }
    const incoming = new URL(request.url ?? '/', 'http://blade-proxy.invalid');
    const target = new URL(upstream.toString());
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
    const responseBody = Buffer.from(await upstreamResponse.arrayBuffer());
    await appendFile(
      responseEvidence,
      `${JSON.stringify({
        status: upstreamResponse.status,
        contentType: upstreamResponse.headers.get('content-type'),
        bytes: responseBody.length,
        errorBody:
          upstreamResponse.status >= 400
            ? responseBody.toString('utf8').slice(0, 2_048)
            : undefined,
      })}\n`,
      { mode: 0o600 }
    );
    response.statusCode = upstreamResponse.status;
    upstreamResponse.headers.forEach((value, name) => {
      if (
        ![
          'connection',
          'content-encoding',
          'content-length',
          'keep-alive',
          'transfer-encoding',
        ].includes(name.toLowerCase())
      ) {
        response.setHeader(name, value);
      }
    });
    response.end(responseBody);
  } catch (error) {
    const cause =
      error instanceof Error && 'cause' in error && error.cause instanceof Error
        ? error.cause
        : undefined;
    process.stderr.write(
      `${JSON.stringify({
        proxyError: error instanceof Error ? error.message : String(error),
        cause: cause?.message,
      })}\n`
    );
    response.statusCode = 502;
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify({
        error: { message: 'Qualification proxy forwarding failed' },
      })
    );
  }
});
await new Promise<void>((resolve, reject) => {
  proxy.once('error', reject);
  proxy.listen(0, '127.0.0.1', () => {
    proxy.off('error', reject);
    resolve();
  });
});
const proxyAddress = proxy.address();
if (!proxyAddress || typeof proxyAddress === 'string') {
  throw new Error('Reasoning GUI proxy has no TCP address');
}

const config = buildRealApiRuntimeConfig(model);
const provider = config.models[0]?.provider;
if (!provider || !config.modelProviders[provider]) {
  throw new Error('GPT qualification provider projection is unavailable');
}
config.modelProviders[provider] = {
  ...config.modelProviders[provider],
  baseUrl: `http://127.0.0.1:${proxyAddress.port}/v1`,
};

await mkdir(path.join(home, '.blade'), { recursive: true });
await mkdir(workspace, { recursive: true });
await writeFile(
  path.join(home, '.blade', 'config.json'),
  `${JSON.stringify(
    {
      currentModelId: config.currentModelId,
      models: config.models,
      modelProviders: config.modelProviders,
      hooks: { enabled: false },
      disableAllHooks: true,
      mcpServers: {},
    },
    null,
    2
  )}\n`
);
await Promise.all([
  mkdir(path.join(workspace, '.blade', 'output-styles'), { recursive: true }),
  mkdir(path.join(workspace, '.claude', 'rules'), { recursive: true }),
  mkdir(path.join(workspace, 'src'), { recursive: true }),
  mkdir(path.join(workspace, 'test'), { recursive: true }),
  mkdir(path.join(workspace, '.blade', 'plugins', 'gui-style', '.blade-plugin'), {
    recursive: true,
  }),
  mkdir(path.join(workspace, '.blade', 'plugins', 'gui-style', 'output-styles'), {
    recursive: true,
  }),
]);
await Promise.all([
  writeFile(
    path.join(workspace, 'BLADE.md'),
    `# GUI project instructions

Read requested source files and obey any path-specific rule loaded for them.
Do not infer a path-specific marker before reading the target file.
`
  ),
  writeFile(
    path.join(workspace, '.claude', 'rules', 'source.md'),
    `---
paths: src/**/*.ts
---
After reading a matching source file for GUI qualification, reply exactly GUI_CONTEXTUAL_RULE_OK.
GUI_CONTEXTUAL_SOURCE_RULE_MARKER
`
  ),
  writeFile(
    path.join(workspace, '.claude', 'rules', 'test-only.md'),
    `---
paths: test/**/*.ts
---
GUI_NON_MATCHING_TEST_RULE_MARKER
`
  ),
  writeFile(
    path.join(workspace, 'src', 'target.ts'),
    `export const target = 'read-me';
`
  ),
  writeFile(
    path.join(workspace, '.blade', 'output-styles', 'gui-project.md'),
    `---
name: GUI Project
description: Production GUI project style
---
Keep all safety, permission, and completion rules unchanged.
When the user requests a GUI qualification marker, return only that marker.
GUI_PROJECT_STYLE_MARKER
`
  ),
  writeFile(
    path.join(
      workspace,
      '.blade',
      'plugins',
      'gui-style',
      '.blade-plugin',
      'plugin.json'
    ),
    `${JSON.stringify({
      name: 'gui-style',
      version: '1.0.0',
      description: 'Production GUI output style qualification',
    })}\n`
  ),
  writeFile(
    path.join(
      workspace,
      '.blade',
      'plugins',
      'gui-style',
      'output-styles',
      'gui-plugin.md'
    ),
    `---
name: GUI Plugin
description: Production GUI plugin style
---
Keep all safety, permission, and completion rules unchanged.
When the user requests a GUI qualification marker, return only that marker.
GUI_PLUGIN_STYLE_MARKER
`
  ),
]);
await writeFile(path.join(workspace, 'README.md'), '# Reasoning effort GUI\n');
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
    requestEvidence,
    responseEvidence,
    port,
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
} finally {
  await new Promise<void>((resolve) => proxy.close(() => resolve()));
}
