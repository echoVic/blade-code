import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const [workspace, label, marker] = process.argv.slice(2);
if (!workspace || !/^[a-z]$/.test(label ?? '') || !marker) {
  throw new Error(
    'Usage: node create-workspace-agent-resource-fixture.mjs <workspace> <label> <marker>'
  );
}

async function write(relativePath, content) {
  const filePath = path.join(workspace, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf8');
}

const pluginName = `plugin-${label}`;
const pluginRoot = `.blade/plugins/${pluginName}`;

await write(
  'package.json',
  `${JSON.stringify(
    {
      name: `blade-web-resource-${label}`,
      private: true,
      version: '1.0.0',
    },
    null,
    2
  )}\n`
);
await write(
  `${pluginRoot}/.blade-plugin/plugin.json`,
  `${JSON.stringify(
    {
      name: pluginName,
      description: `Web qualification plugin ${label.toUpperCase()}`,
      version: '1.0.0',
    },
    null,
    2
  )}\n`
);
await write(
  `${pluginRoot}/commands/reveal.md`,
  `---
description: Reveal the external ${label.toUpperCase()} marker
---
The external workspace marker is exactly ${marker}.
Return that marker verbatim and do not mention any other workspace.
`
);
await write(
  `${pluginRoot}/agents/worker.md`,
  `---
name: worker
description: Workspace ${label.toUpperCase()} worker
---
Operate only on workspace ${label.toUpperCase()} resources.
`
);
await write(
  `${pluginRoot}/skills/inspect/SKILL.md`,
  `---
name: inspect
description: Inspect only workspace ${label.toUpperCase()}
---
Inspect resources owned by workspace ${label.toUpperCase()}.
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

process.stdout.write(
  `${JSON.stringify({ workspace: path.resolve(workspace), pluginName, marker })}\n`
);
