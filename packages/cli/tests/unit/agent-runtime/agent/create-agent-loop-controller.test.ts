import { describe, expect, it, vi } from 'vitest';

import { createAgentLoopController } from '../../../../src/agent/createAgentLoopController.js';

describe('createAgentLoopController', () => {
  it('bundles loop bridge callbacks and delegates skill operations', async () => {
    const applyToolRestrictions = vi.fn((tools) => tools.slice(0, 1));
    const activateSkillContext = vi.fn();
    const switchModelIfNeeded = vi.fn().mockResolvedValue(undefined);
    const setTodos = vi.fn();
    const log = vi.fn();
    const error = vi.fn();

    const controller = createAgentLoopController({
      skillContextController: {
        applyToolRestrictions,
        activateSkillContext,
      },
      switchModelIfNeeded,
      setTodos,
      log,
      error,
    });

    expect(controller.applySkillToolRestrictions([{ name: 'Read' }, { name: 'Edit' }] as any)).toEqual([
      { name: 'Read' },
    ]);
    expect(applyToolRestrictions).toHaveBeenCalledWith([{ name: 'Read' }, { name: 'Edit' }]);

    controller.activateSkillContext({ skillName: 'brainstorming' });
    expect(activateSkillContext).toHaveBeenCalledWith({ skillName: 'brainstorming' });

    await controller.switchModelIfNeeded('gpt-5.4');
    expect(switchModelIfNeeded).toHaveBeenCalledWith('gpt-5.4');

    controller.setTodos([{ id: '1', content: 'do it' }] as any);
    controller.log('hello');
    controller.error('boom');

    expect(setTodos).toHaveBeenCalledWith([{ id: '1', content: 'do it' }]);
    expect(log).toHaveBeenCalledWith('hello');
    expect(error).toHaveBeenCalledWith('boom');
  });
});
