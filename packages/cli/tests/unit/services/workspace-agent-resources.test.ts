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
  getWorkspaceAgentResourceCacheStats,
  MAX_ACTIVE_WORKSPACE_AGENT_RESOURCES,
  MAX_RESIDENT_WORKSPACE_AGENT_RESOURCES,
  resetWorkspaceAgentResources,
  resolveWorkspaceAgentResources,
  snapshotWorkspaceAgentResources,
  WorkspaceAgentResourceCapacityError,
  type WorkspaceAgentResources,
  withWorkspaceAgentResources,
} from '../../../src/agent/resources/WorkspaceAgentResources.js';
import { SubagentRegistry } from '../../../src/agent/subagents/SubagentRegistry.js';
import { ConfigManager } from '../../../src/config/ConfigManager.js';
import { ConfigService } from '../../../src/config/ConfigService.js';
import { setWorkspacePluginEnabled } from '../../../src/plugins/PluginLifecycle.js';
import { PluginRegistry } from '../../../src/plugins/PluginRegistry.js';
import { WorkspaceTrustService } from '../../../src/security/WorkspaceTrustService.js';
import { SkillRegistry } from '../../../src/skills/SkillRegistry.js';
import { CustomCommandRegistry } from '../../../src/slash-commands/custom/CustomCommandRegistry.js';
import { getBuiltinTools } from '../../../src/tools/builtin/index.js';

async function writeFixture(root: string, relativePath: string, content: string) {
  const filePath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf8');
}

async function flushScheduledResourceReleases(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
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

  it('bounds idle workspace registries by LRU without invalidating Session snapshots', async () => {
    const roots = Array.from(
      { length: MAX_RESIDENT_WORKSPACE_AGENT_RESOURCES + 1 },
      (_, index) => path.join(tempRoot, `churn-${index}`)
    );
    await Promise.all(roots.map((root) => fs.mkdir(root, { recursive: true })));

    const resources: WorkspaceAgentResources[] = [];
    for (const root of roots.slice(0, MAX_RESIDENT_WORKSPACE_AGENT_RESOURCES)) {
      resources.push(await resolveWorkspaceAgentResources(root));
    }
    await flushScheduledResourceReleases();

    const evicted = resources[1];
    evicted.subagents.applyOverrides([
      {
        name: 'snapshot-only',
        description: 'Retained only by the immutable Session snapshot',
      },
    ]);
    const session = snapshotWorkspaceAgentResources(evicted);

    expect(await resolveWorkspaceAgentResources(roots[0])).toBe(resources[0]);
    await resolveWorkspaceAgentResources(roots.at(-1)!);
    await flushScheduledResourceReleases();

    expect(getWorkspaceAgentResourceCacheStats()).toEqual({
      capacity: MAX_RESIDENT_WORKSPACE_AGENT_RESOURCES,
      activeCapacity: MAX_ACTIVE_WORKSPACE_AGENT_RESOURCES,
      entries: MAX_RESIDENT_WORKSPACE_AGENT_RESOURCES,
      initialized: MAX_RESIDENT_WORKSPACE_AGENT_RESOURCES,
      inFlight: 0,
      activeUsers: 0,
    });

    const reloaded = await resolveWorkspaceAgentResources(roots[1]);
    expect(reloaded).not.toBe(evicted);
    expect(reloaded.subagents).not.toBe(evicted.subagents);
    expect(reloaded.skills).not.toBe(evicted.skills);
    expect(reloaded.commands).not.toBe(evicted.commands);
    expect(reloaded.plugins).not.toBe(evicted.plugins);
    expect(reloaded.subagents.getSubagent('snapshot-only')).toBeUndefined();
    expect(session.subagents.getSubagent('snapshot-only')).toBeDefined();

    await flushScheduledResourceReleases();
    expect(getWorkspaceAgentResourceCacheStats().entries).toBe(
      MAX_RESIDENT_WORKSPACE_AGENT_RESOURCES
    );
  });

  it('protects active workspace entries and converges after concurrent churn', async () => {
    const count = MAX_ACTIVE_WORKSPACE_AGENT_RESOURCES;
    const roots = Array.from({ length: count }, (_, index) =>
      path.join(tempRoot, `active-churn-${index}`)
    );
    const overflowRoot = path.join(tempRoot, 'active-churn-overflow');
    await Promise.all(
      [...roots, overflowRoot].map((root) => fs.mkdir(root, { recursive: true }))
    );

    let entered = 0;
    let notifyEntered: (() => void) | undefined;
    const allEntered = new Promise<void>((resolve) => {
      notifyEntered = resolve;
    });
    let releaseAll: (() => void) | undefined;
    const release = new Promise<void>((resolve) => {
      releaseAll = resolve;
    });
    const operations = roots.map((root) =>
      withWorkspaceAgentResources(root, async () => {
        entered++;
        if (entered === count) notifyEntered?.();
        await release;
      })
    );

    await allEntered;
    expect(getWorkspaceAgentResourceCacheStats()).toMatchObject({
      capacity: MAX_RESIDENT_WORKSPACE_AGENT_RESOURCES,
      activeCapacity: MAX_ACTIVE_WORKSPACE_AGENT_RESOURCES,
      entries: count,
      initialized: count,
      inFlight: 0,
      activeUsers: count,
    });
    await expect(resolveWorkspaceAgentResources(overflowRoot)).rejects.toBeInstanceOf(
      WorkspaceAgentResourceCapacityError
    );
    expect(getWorkspaceAgentResourceCacheStats().entries).toBe(count);

    releaseAll?.();
    await Promise.all(operations);
    expect(getWorkspaceAgentResourceCacheStats()).toEqual({
      capacity: MAX_RESIDENT_WORKSPACE_AGENT_RESOURCES,
      activeCapacity: MAX_ACTIVE_WORKSPACE_AGENT_RESOURCES,
      entries: MAX_RESIDENT_WORKSPACE_AGENT_RESOURCES,
      initialized: MAX_RESIDENT_WORKSPACE_AGENT_RESOURCES,
      inFlight: 0,
      activeUsers: 0,
    });
  });

  it('releases every partial registry generation after initialization fails', async () => {
    const workspace = path.join(tempRoot, 'failed-initialization');
    await fs.mkdir(workspace, { recursive: true });
    const agents = SubagentRegistry.getInstance(workspace);
    const skills = SkillRegistry.getInstance({ cwd: workspace });
    const commands = CustomCommandRegistry.getInstance(workspace);
    const plugins = PluginRegistry.getInstance(workspace);
    const initialize = vi
      .spyOn(PluginRegistry.prototype, 'initialize')
      .mockRejectedValueOnce(new Error('injected plugin initialization failure'));

    try {
      await expect(resolveWorkspaceAgentResources(workspace)).rejects.toThrow(
        'injected plugin initialization failure'
      );
    } finally {
      initialize.mockRestore();
    }

    expect(getWorkspaceAgentResourceCacheStats().entries).toBe(0);
    expect(SubagentRegistry.getInstance(workspace)).not.toBe(agents);
    expect(SkillRegistry.getInstance({ cwd: workspace })).not.toBe(skills);
    expect(CustomCommandRegistry.getInstance(workspace)).not.toBe(commands);
    expect(PluginRegistry.getInstance(workspace)).not.toBe(plugins);
  });
});
