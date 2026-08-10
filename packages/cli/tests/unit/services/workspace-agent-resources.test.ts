import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/skills/SkillInstaller.js', () => ({
  getSkillInstaller: () => ({
    ensureDefaultSkillsInstalled: vi.fn(async () => undefined),
  }),
}));

import {
  resetWorkspaceAgentResources,
  resolveWorkspaceAgentResources,
  snapshotWorkspaceAgentResources,
} from '../../../src/agent/resources/WorkspaceAgentResources.js';
import { ConfigManager } from '../../../src/config/ConfigManager.js';
import { ConfigService } from '../../../src/config/ConfigService.js';
import { setWorkspacePluginEnabled } from '../../../src/plugins/PluginLifecycle.js';
import { WorkspaceTrustService } from '../../../src/security/WorkspaceTrustService.js';
import { getBuiltinTools } from '../../../src/tools/builtin/index.js';

async function writeFixture(root: string, relativePath: string, content: string) {
  const filePath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf8');
}

async function createWorkspace(root: string, marker: 'a' | 'b') {
  await writeFixture(
    root,
    'BLADE.md',
    `Use workspace ${marker.toUpperCase()} rules.\n`
  );
  await writeFixture(
    root,
    '.claude/rules/typescript.md',
    `---
paths: src/**/*.ts
---
Use workspace ${marker.toUpperCase()} TypeScript rules.
`
  );
  await writeFixture(
    root,
    `.blade/agents/native-${marker}.md`,
    `---
name: native-${marker}
description: Native ${marker.toUpperCase()} agent
---
Use only workspace ${marker.toUpperCase()} resources.
`
  );
  await writeFixture(
    root,
    `.blade/commands/native-${marker}.md`,
    `---
description: Native ${marker.toUpperCase()} command
---
Run native ${marker.toUpperCase()} command.
`
  );
  await writeFixture(
    root,
    `.blade/skills/native-${marker}/SKILL.md`,
    `---
name: native-${marker}
description: Native ${marker.toUpperCase()} skill
user-invocable: true
---
Use native ${marker.toUpperCase()} skill.
`
  );
  await writeFixture(
    root,
    `.blade/output-styles/native-${marker}.md`,
    `---
name: Native ${marker.toUpperCase()} Style
description: Native ${marker.toUpperCase()} communication style
---
Use project ${marker.toUpperCase()} communication conventions.
`
  );

  const pluginRoot = `.blade/plugins/plugin-${marker}`;
  await writeFixture(
    root,
    `${pluginRoot}/.blade-plugin/plugin.json`,
    `${JSON.stringify(
      {
        name: `plugin-${marker}`,
        description: `Workspace ${marker.toUpperCase()} plugin`,
        version: '1.0.0',
      },
      null,
      2
    )}\n`
  );
  await writeFixture(
    root,
    `${pluginRoot}/commands/review.md`,
    `---
description: Plugin ${marker.toUpperCase()} review
---
Run plugin ${marker.toUpperCase()} review.
`
  );
  await writeFixture(
    root,
    `${pluginRoot}/agents/worker.md`,
    `---
name: worker
description: Plugin ${marker.toUpperCase()} worker
---
Work only for project ${marker.toUpperCase()}.
`
  );
  await writeFixture(
    root,
    `${pluginRoot}/skills/inspect/SKILL.md`,
    `---
name: inspect
description: Plugin ${marker.toUpperCase()} inspection
---
Inspect only project ${marker.toUpperCase()}.
`
  );
  await writeFixture(
    root,
    `${pluginRoot}/output-styles/review.md`,
    `---
name: Plugin ${marker.toUpperCase()} Review
description: Plugin ${marker.toUpperCase()} review communication
---
Use plugin ${marker.toUpperCase()} review communication.
`
  );
}

describe('workspace agent resource resolution', () => {
  let tempRoot: string;
  let workspaceA: string;
  let workspaceB: string;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'blade-agent-resources-'));
    workspaceA = path.join(tempRoot, 'project-a');
    workspaceB = path.join(tempRoot, 'project-b');
    await Promise.all([
      createWorkspace(workspaceA, 'a'),
      createWorkspace(workspaceB, 'b'),
    ]);
    WorkspaceTrustService.resetInstance();
    ConfigManager.resetInstance();
    ConfigService.resetInstance();
    resetWorkspaceAgentResources();
    await Promise.all([
      WorkspaceTrustService.getInstance().trust(workspaceA),
      WorkspaceTrustService.getInstance().trust(workspaceB),
    ]);
  });

  afterEach(async () => {
    resetWorkspaceAgentResources();
    ConfigManager.resetInstance();
    ConfigService.resetInstance();
    WorkspaceTrustService.resetInstance();
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it('loads real project and plugin resources without cross-workspace leakage', async () => {
    const [baseA, baseB] = await Promise.all([
      resolveWorkspaceAgentResources(workspaceA),
      resolveWorkspaceAgentResources(workspaceB),
    ]);
    const sessionA = snapshotWorkspaceAgentResources(baseA);
    const sessionB = snapshotWorkspaceAgentResources(baseB);

    expect(sessionA.subagents.getSubagent('native-a')).toBeDefined();
    expect(sessionA.subagents.getSubagent('plugin-a:worker')).toBeDefined();
    expect(sessionA.subagents.getSubagent('native-b')).toBeUndefined();
    expect(sessionA.subagents.getSubagent('plugin-b:worker')).toBeUndefined();
    expect(sessionA.skills.has('native-a')).toBe(true);
    expect(sessionA.skills.has('plugin-a:inspect')).toBe(true);
    expect(sessionA.skills.has('native-b')).toBe(false);
    expect(sessionA.commands.hasCommand('native-a')).toBe(true);
    expect(sessionA.commands.findPluginCommand('plugin-a:review')).toBeDefined();
    expect(sessionA.commands.hasCommand('native-b')).toBe(false);
    expect(sessionA.projectRules.staticRules(workspaceA).content).toContain(
      'workspace A rules'
    );
    expect(
      sessionA.projectRules.contextualRules(
        workspaceA,
        [path.join(workspaceA, 'src', 'index.ts')],
        new Set(
          sessionA.projectRules
            .staticRules(workspaceA)
            .references.map((item) => item.id)
        )
      ).content
    ).toContain('workspace A TypeScript rules');
    expect(
      sessionA.projectRules.list().some((rule) => rule.relativePath.includes('b'))
    ).toBe(false);
    expect(sessionA.communicationStyles.resolve('project:native-a').prompt).toContain(
      'project A'
    );
    expect(
      sessionA.communicationStyles.resolve('plugin:plugin-a:review').prompt
    ).toContain('plugin A');
    expect(() => sessionA.communicationStyles.resolve('project:native-b')).toThrow(
      'unavailable'
    );

    expect(sessionB.subagents.getSubagent('native-b')).toBeDefined();
    expect(sessionB.subagents.getSubagent('plugin-b:worker')).toBeDefined();
    expect(sessionB.subagents.getSubagent('native-a')).toBeUndefined();
    expect(sessionB.skills.has('plugin-a:inspect')).toBe(false);
    expect(sessionB.commands.findPluginCommand('plugin-a:review')).toBeUndefined();
    expect(sessionB.projectRules.staticRules(workspaceB).content).toContain(
      'workspace B rules'
    );
    expect(sessionB.communicationStyles.resolve('project:native-b').prompt).toContain(
      'project B'
    );
    expect(() =>
      sessionB.communicationStyles.resolve('plugin:plugin-a:review')
    ).toThrow('unavailable');
  });

  it('keeps model-visible tools immutable after the workspace registry changes', async () => {
    const base = await resolveWorkspaceAgentResources(workspaceA);
    const session = snapshotWorkspaceAgentResources(base);
    const tools = await getBuiltinTools({
      sessionId: 'session-a',
      workspaceRoot: workspaceA,
      resourceRoot: workspaceA,
      agentResources: session,
    });

    base.subagents.clearPluginAgents();
    base.skills.clearPluginSkills();
    base.commands.clearPluginCommands();

    const task = tools.find((tool) => tool.name === 'Task');
    const skill = tools.find((tool) => tool.name === 'Skill');
    const slash = tools.find((tool) => tool.name === 'SlashCommand');
    expect(String(task?.description.long)).toContain('plugin-a:worker');
    expect(skill?.getFunctionDeclaration().description).toContain('plugin-a:inspect');
    expect(String(slash?.description.long)).toContain('/plugin-a:review');

    const accepted = await slash?.execute({ command: 'plugin-a:review' }, undefined, {
      workspaceRoot: workspaceA,
    });
    expect(accepted?.success).toBe(true);
    expect(String(accepted?.llmContent)).toContain('Run plugin A review');
  });

  it('persists plugin state for future snapshots without mutating live sessions', async () => {
    await writeFixture(
      workspaceA,
      '.blade/settings.local.json',
      `${JSON.stringify({ enabledPlugins: { 'plugin-a': false } }, null, 2)}\n`
    );
    const disabledResources = await resolveWorkspaceAgentResources(workspaceA);
    const disabledSession = snapshotWorkspaceAgentResources(disabledResources);

    expect(disabledResources.plugins.get('plugin-a')?.status).toBe('inactive');
    expect(
      disabledSession.commands.findPluginCommand('plugin-a:review')
    ).toBeUndefined();
    expect(disabledSession.skills.has('plugin-a:inspect')).toBe(false);
    expect(() =>
      disabledSession.communicationStyles.resolve('plugin:plugin-a:review')
    ).toThrow('unavailable');

    const change = await setWorkspacePluginEnabled(
      workspaceA,
      'plugin-a',
      true,
      'local'
    );
    const enabledSession = snapshotWorkspaceAgentResources(disabledResources);
    expect(change.effectiveEnabled).toBe(true);
    expect(enabledSession.commands.findPluginCommand('plugin-a:review')).toBeDefined();
    expect(
      enabledSession.communicationStyles.resolve('plugin:plugin-a:review').prompt
    ).toContain('plugin A');
    expect(
      disabledSession.commands.findPluginCommand('plugin-a:review')
    ).toBeUndefined();
    expect(() =>
      disabledSession.communicationStyles.resolve('plugin:plugin-a:review')
    ).toThrow('unavailable');
    expect(
      JSON.parse(
        await fs.readFile(
          path.join(workspaceA, '.blade', 'settings.local.json'),
          'utf8'
        )
      )
    ).toMatchObject({ enabledPlugins: { 'plugin-a': true } });

    resetWorkspaceAgentResources();
    const reloaded = await resolveWorkspaceAgentResources(workspaceA);
    expect(reloaded.plugins.get('plugin-a')?.status).toBe('active');
    expect(reloaded.commands.findPluginCommand('plugin-a:review')).toBeDefined();
  });
});
