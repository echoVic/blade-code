import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const [workspace, label] = process.argv.slice(2);
if (!workspace || !/^[a-z]$/.test(label ?? '')) {
  throw new Error(
    'Usage: node create-workspace-model-resource-fixture.mjs <workspace> <label>'
  );
}

async function write(relativePath, content) {
  const filePath = path.join(workspace, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf8');
}

const upper = label.toUpperCase();
const modelId = `gui-model-${label}`;
const providerId = `gui-channel-${label}`;

await write(
  'package.json',
  `${JSON.stringify(
    {
      name: `blade-web-model-${label}`,
      private: true,
      version: '1.0.0',
    },
    null,
    2
  )}\n`
);
await write(
  '.blade/config.json',
  `${JSON.stringify(
    {
      currentModelId: modelId,
      modelProviders: {
        [providerId]: {
          name: `GUI Channel ${upper}`,
          baseUrl: `https://${label}.example.test/v1`,
          wireApi: 'openai-completions',
        },
      },
      models: [
        {
          id: modelId,
          displayName: `GUI Model ${upper}`,
          provider: providerId,
          model: 'gpt-4.1',
        },
      ],
    },
    null,
    2
  )}\n`
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

process.stdout.write(
  `${JSON.stringify({
    workspace: path.resolve(workspace),
    modelId,
    providerId,
  })}\n`
);
