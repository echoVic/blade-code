import { afterEach, describe, expect, it } from 'vitest';
import { SubagentRegistry } from '../../../src/agent/subagents/SubagentRegistry.js';
import type { PluginCommand } from '../../../src/plugins/types.js';
import { CustomCommandRegistry } from '../../../src/slash-commands/custom/CustomCommandRegistry.js';
import { createSlashCommandTool } from '../../../src/tools/builtin/system/slashCommand.js';
import { createTaskTool } from '../../../src/tools/builtin/task/task.js';
import type { ExecutionContext } from '../../../src/tools/types/index.js';

const pluginCommand = (pluginName: string, commandName: string): PluginCommand => ({
  pluginName,
  originalName: commandName,
  namespacedName: `${pluginName}:${commandName}`,
  config: { description: `${pluginName} command` },
  content: `Run ${pluginName}`,
  path: `/plugins/${pluginName}/${commandName}.md`,
});

describe('workspace-bound agent tools', () => {
  afterEach(() => {
    SubagentRegistry.resetInstances();
    CustomCommandRegistry.resetInstance();
  });

  it('binds each Task tool description to one workspace subagent snapshot', () => {
    const first = new SubagentRegistry('/workspace/a');
    const second = new SubagentRegistry('/workspace/b');
    first.register({ name: 'agent-a', description: 'Agent A only' });
    second.register({ name: 'agent-b', description: 'Agent B only' });

    const firstDescription = String(createTaskTool(first).description.long);
    const secondDescription = String(createTaskTool(second).description.long);

    expect(firstDescription).toContain('agent-a');
    expect(firstDescription).not.toContain('agent-b');
    expect(secondDescription).toContain('agent-b');
    expect(secondDescription).not.toContain('agent-a');
  });

  it('binds plugin slash commands to the exact workspace registry', () => {
    const first = CustomCommandRegistry.getInstance('/workspace/a');
    const second = CustomCommandRegistry.getInstance('/workspace/b');
    first.registerPluginCommand(pluginCommand('plugin-a', 'review'));
    second.registerPluginCommand(pluginCommand('plugin-b', 'deploy'));
    Object.assign(first as object, { initialized: true });
    Object.assign(second as object, { initialized: true });

    const firstDescription = String(createSlashCommandTool(first).description.long);
    const secondDescription = String(createSlashCommandTool(second).description.long);

    expect(firstDescription).toContain('/plugin-a:review');
    expect(firstDescription).not.toContain('/plugin-b:deploy');
    expect(secondDescription).toContain('/plugin-b:deploy');
    expect(secondDescription).not.toContain('/plugin-a:review');
  });

  it('executes a plugin command only through its owning workspace tool', async () => {
    const first = CustomCommandRegistry.getInstance('/workspace/a');
    const second = CustomCommandRegistry.getInstance('/workspace/b');
    first.registerPluginCommand(pluginCommand('plugin-a', 'review'));
    Object.assign(first as object, { initialized: true });
    Object.assign(second as object, { initialized: true });
    const context = {
      workspaceRoot: '/workspace/a',
    } as ExecutionContext;

    const accepted = await createSlashCommandTool(first).execute(
      { command: 'plugin-a:review' },
      undefined,
      context
    );
    const rejected = await createSlashCommandTool(second).execute(
      { command: 'plugin-a:review' },
      undefined,
      { ...context, workspaceRoot: '/workspace/b' }
    );

    expect(accepted.success).toBe(true);
    expect(String(accepted.llmContent)).toContain('Run plugin-a');
    expect(accepted.metadata).toMatchObject({ pluginName: 'plugin-a' });
    expect(rejected.success).toBe(false);
  });
});
