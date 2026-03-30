import { describe, expect, it, vi } from 'vitest';

import { createAgentSkillContextController } from '../../../../src/agent/agentSkillContextController.js';

describe('createAgentSkillContextController', () => {
  it('activates skill context, filters tools, and clears the active skill', () => {
    const debug = vi.fn();
    const controller = createAgentSkillContextController({ debug });
    const tools = [
      { name: 'Read' },
      { name: 'Bash' },
      { name: 'Edit' },
    ] as any;

    expect(controller.applyToolRestrictions(tools)).toBe(tools);

    controller.activateSkillContext({
      skillName: 'brainstorming',
      allowedTools: ['Read', 'Bash(git:*)'],
      basePath: '/tmp/skills',
    });

    expect(controller.applyToolRestrictions(tools)).toEqual([
      { name: 'Read' },
      { name: 'Bash' },
    ]);
    expect(debug).toHaveBeenCalledWith(
      '🎯 Skill "brainstorming" activated with allowed tools: Read, Bash(git:*)'
    );
    expect(debug).toHaveBeenCalledWith(
      '🔒 Applying Skill tool restrictions: Read, Bash(git:*)'
    );
    expect(debug).toHaveBeenCalledWith('🔒 Filtered tools: Read, Bash (2/3)');

    controller.clearSkillContext();

    expect(debug).toHaveBeenCalledWith('🎯 Skill "brainstorming" deactivated');
    expect(controller.applyToolRestrictions(tools)).toBe(tools);
  });

  it('ignores metadata without a skill name', () => {
    const debug = vi.fn();
    const controller = createAgentSkillContextController({ debug });
    const tools = [{ name: 'Read' }] as any;

    controller.activateSkillContext({ allowedTools: ['Read'] });

    expect(controller.applyToolRestrictions(tools)).toBe(tools);
    expect(debug).not.toHaveBeenCalled();
  });
});
