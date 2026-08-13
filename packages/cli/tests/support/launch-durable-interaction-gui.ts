import { execFile, spawn } from 'node:child_process';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { materializeRealApiEnvironment } from '../../scripts/real-api-credentials.js';
import { PersistentStore } from '../../src/context/storage/PersistentStore.js';
import { SessionInteractionService } from '../../src/services/SessionInteractionService.js';
import { SessionService } from '../../src/services/SessionService.js';
import {
  buildRealApiRuntimeConfig,
  resolveForkQualificationModels,
} from '../integration/real-api/testConfig.js';

const [root, rawPort = '4340'] = process.argv.slice(2);
if (!root || !path.isAbsolute(root) || !/^\d+$/.test(rawPort)) {
  throw new Error(
    'Usage: bun launch-durable-interaction-gui.ts <absolute-root> [port]'
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
await writeFile(path.join(workspace, 'README.md'), '# Durable interaction GUI\n');
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
const sessionId = `interaction-gui-${Date.now()}`;
const target = path.join(canonicalWorkspace, 'gui-selected-channel.txt');
await SessionService.createSessionMetadata(sessionId, canonicalWorkspace, {
  title: 'Pending Channel Decision',
  taskStatus: 'completed',
  selectedModelId: config.currentModelId,
  permissionMode: 'yolo',
});
const store = new PersistentStore(canonicalWorkspace);
await store.saveMessage(
  sessionId,
  'user',
  [
    'A Channel question will be recovered in the production Web UI.',
    `After the recovered answer, call Write exactly once with file_path=${JSON.stringify(
      target
    )}.`,
    'Set content to the selected label followed by exactly one newline.',
    'That Write is the only allowed tool call. Never call AskUserQuestion again.',
    'Do not emit assistant text or end the turn before Write succeeds.',
    'After Write succeeds, reply exactly GUI_INTERACTION_RECOVERED.',
  ].join(' ')
);
const toolCallId = await store.saveToolUse(sessionId, 'AskUserQuestion', {
  questions: [
    {
      header: 'Channel',
      question: 'Which release channel should Blade write?',
      multiSelect: false,
      options: [
        { label: 'Stable', description: 'Use the stable release channel' },
        { label: 'Canary', description: 'Use the early canary release channel' },
      ],
    },
  ],
});
const request = await SessionInteractionService.request(
  {
    sessionId,
    projectPath: canonicalWorkspace,
    toolCallId,
    toolName: 'AskUserQuestion',
  },
  {
    type: 'askUserQuestion',
    message: 'Choose a release channel',
    questions: [
      {
        header: 'Channel',
        question: 'Which release channel should Blade write?',
        multiSelect: false,
        options: [
          { label: 'Stable', description: 'Use the stable release channel' },
          { label: 'Canary', description: 'Use the early canary release channel' },
        ],
      },
    ],
  }
);

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
    sessionId,
    requestId: request.requestId,
    target,
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
