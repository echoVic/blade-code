import { afterEach, describe, expect, it } from 'vitest';
import { SubagentRegistry } from '../../../src/agent/subagents/SubagentRegistry.js';
import { HookManager } from '../../../src/hooks/HookManager.js';
import { listExternalHookDefinitions } from '../../../src/hooks/HookTrustService.js';
import { HookEvent, HookType } from '../../../src/hooks/types/HookTypes.js';
import {
  clearAllPluginResources,
  integrateAllPlugins,
} from '../../../src/plugins/PluginIntegrator.js';
import { PluginRegistry } from '../../../src/plugins/PluginRegistry.js';
import type { LoadedPlugin, PluginCommand } from '../../../src/plugins/types.js';
import { getSkillRegistry, SkillRegistry } from '../../../src/skills/SkillRegistry.js';
import { CustomCommandRegistry } from '../../../src/slash-commands/custom/CustomCommandRegistry.js';

describe('workspace-scoped registries', () => {
  afterEach(() => {
    clearAllPluginResources('/workspace/a');
    clearAllPluginResources('/workspace/b');
    clearAllPluginResources('/workspace/hooks');
    HookManager.resetInstance();
    SkillRegistry.resetInstance();
    CustomCommandRegistry.resetInstance();
    SubagentRegistry.resetInstances();
    PluginRegistry.resetInstance();
  });

  it('keeps skill registries isolated by workspace', () => {
    const first = getSkillRegistry({ cwd: '/workspace/a' });
    const same = getSkillRegistry({ cwd: '/workspace/a/.' });
    const second = getSkillRegistry({ cwd: '/workspace/b' });

    expect(same).toBe(first);
    expect(second).not.toBe(first);
  });

  it('reuses the first workspace skill configuration for later cwd-only lookups', () => {
    const configured = getSkillRegistry({
      cwd: '/workspace/a',
      userSkillsDir: '/isolated/user-skills',
      projectSkillsDir: '/workspace/a/.blade/skills',
      claudeUserSkillsDir: '/isolated/claude-skills',
      claudeProjectSkillsDir: '/workspace/a/.claude/skills',
    });

    expect(getSkillRegistry({ cwd: '/workspace/a' })).toBe(configured);
  });

  it('keeps custom command registries isolated by workspace', () => {
    const first = CustomCommandRegistry.getInstance('/workspace/a');
    const same = CustomCommandRegistry.getInstance('/workspace/a/.');
    const second = CustomCommandRegistry.getInstance('/workspace/b');

    expect(same).toBe(first);
    expect(second).not.toBe(first);
  });

  it('keeps subagent and plugin registries isolated by workspace', () => {
    const agentsA = SubagentRegistry.getInstance('/workspace/a');
    const agentsB = SubagentRegistry.getInstance('/workspace/b');
    agentsA.register({ name: 'only-a', description: 'Workspace A agent' });

    expect(agentsA.getSubagent('only-a')).toBeDefined();
    expect(agentsB.getSubagent('only-a')).toBeUndefined();
    expect(PluginRegistry.getInstance('/workspace/a')).not.toBe(
      PluginRegistry.getInstance('/workspace/b')
    );
  });

  it('does not leak plugin commands between workspace command registries', () => {
    const first = CustomCommandRegistry.getInstance('/workspace/a');
    const second = CustomCommandRegistry.getInstance('/workspace/b');
    const pluginCommand = {
      pluginName: 'workspace-a-plugin',
      originalName: 'review',
      namespacedName: 'workspace-a-plugin:review',
      config: { description: 'Review workspace A' },
      content: 'Review workspace A only',
      path: '/workspace/a/.blade/plugins/review.md',
    } satisfies PluginCommand;

    first.registerPluginCommand(pluginCommand);

    expect(first.findPluginCommand('review')).toBe(pluginCommand);
    expect(second.findPluginCommand('review')).toBeUndefined();
  });

  it('integrates plugin resources into only their owning workspace', async () => {
    const createPlugin = (name: string): LoadedPlugin => ({
      manifest: { name, description: `${name} plugin`, version: '1.0.0' },
      basePath: `/workspace/${name}`,
      source: 'project',
      manifestSource: 'blade',
      commands: [
        {
          pluginName: name,
          originalName: 'review',
          namespacedName: `${name}:review`,
          config: { description: `${name} review` },
          content: `Run ${name} review`,
          path: `/workspace/${name}/commands/review.md`,
        },
      ],
      skills: [
        {
          pluginName: name,
          originalName: 'inspect',
          namespacedName: `${name}:inspect`,
          path: `/workspace/${name}/skills/inspect`,
          metadata: {
            name: `${name}:inspect`,
            description: `${name} inspect`,
            path: `/workspace/${name}/skills/inspect/SKILL.md`,
            basePath: `/workspace/${name}/skills/inspect`,
            source: 'project',
          },
        },
      ],
      agents: [
        {
          pluginName: name,
          originalName: 'worker',
          namespacedName: `${name}:worker`,
          path: `/workspace/${name}/agents/worker.md`,
          config: { name: 'worker', description: `${name} worker` },
        },
      ],
      status: 'active',
      loadedAt: new Date(0),
    });
    const registryA = PluginRegistry.getInstance('/workspace/a');
    const registryB = PluginRegistry.getInstance('/workspace/b');
    (registryA as unknown as { plugins: Map<string, LoadedPlugin> }).plugins.set(
      'plugin-a',
      createPlugin('plugin-a')
    );
    (registryB as unknown as { plugins: Map<string, LoadedPlugin> }).plugins.set(
      'plugin-b',
      createPlugin('plugin-b')
    );

    await integrateAllPlugins('/workspace/a');
    await integrateAllPlugins('/workspace/b');

    expect(
      CustomCommandRegistry.getInstance('/workspace/a').findPluginCommand(
        'plugin-a:review'
      )
    ).toBeDefined();
    expect(
      CustomCommandRegistry.getInstance('/workspace/a').findPluginCommand(
        'plugin-b:review'
      )
    ).toBeUndefined();
    expect(getSkillRegistry({ cwd: '/workspace/a' }).has('plugin-a:inspect')).toBe(
      true
    );
    expect(getSkillRegistry({ cwd: '/workspace/a' }).has('plugin-b:inspect')).toBe(
      false
    );
    expect(
      SubagentRegistry.getInstance('/workspace/a').getSubagent('plugin-a:worker')
    ).toBeDefined();
    expect(
      SubagentRegistry.getInstance('/workspace/a').getSubagent('plugin-b:worker')
    ).toBeUndefined();
  });

  it('atomically attributes plugin hooks and keeps live Session snapshots', async () => {
    const workspace = '/workspace/hooks';
    const manager = HookManager.getInstance();
    manager.loadConfig({ enabled: false, PostToolUse: [] }, workspace);
    const registry = PluginRegistry.getInstance(workspace);
    const createHookPlugin = (name: string): LoadedPlugin => ({
      manifest: { name, description: `${name} plugin`, version: '1.0.0' },
      basePath: `${workspace}/${name}`,
      source: 'project',
      manifestSource: 'blade',
      commands: [],
      skills: [],
      agents: [],
      hooks: {
        PostToolUse: [
          {
            name: 'audit',
            hooks: [
              {
                type: HookType.Command,
                command: 'echo "$BLADE_PLUGIN_ROOT"',
              },
            ],
          },
        ],
      },
      status: 'active',
      loadedAt: new Date(0),
    });
    const plugins = (registry as unknown as { plugins: Map<string, LoadedPlugin> })
      .plugins;
    plugins.set('plugin-alpha', createHookPlugin('plugin-alpha'));
    plugins.set('plugin-beta', createHookPlugin('plugin-beta'));

    await integrateAllPlugins(workspace);
    const integrated = manager.getConfig(workspace);
    expect(integrated.enabled).toBe(true);
    expect(integrated[HookEvent.PostToolUse]).toHaveLength(2);
    expect(
      listExternalHookDefinitions(integrated).map((definition) => ({
        pluginName: definition.pluginName,
        pluginSource: definition.pluginSource,
      }))
    ).toEqual([
      { pluginName: 'plugin-alpha', pluginSource: 'project' },
      { pluginName: 'plugin-beta', pluginSource: 'project' },
    ]);
    expect(integrated[HookEvent.PostToolUse]?.[0]?.hooks[0]?.source).toMatchObject({
      pluginName: 'plugin-alpha',
      pluginRoot: `${workspace}/plugin-alpha`,
    });

    manager.bindSessionConfig('live-session', [workspace], integrated);
    registry.disable('plugin-alpha');
    clearAllPluginResources(workspace);
    await integrateAllPlugins(workspace);
    expect(manager.getConfig(workspace)[HookEvent.PostToolUse]).toHaveLength(1);
    const sessionConfigs = (
      manager as unknown as { sessionConfigs: Map<string, { PostToolUse?: unknown[] }> }
    ).sessionConfigs;
    expect(sessionConfigs.get(`live-session\0${workspace}`)?.PostToolUse).toHaveLength(
      2
    );
  });
});
