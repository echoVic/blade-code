import { describe, expect, it } from 'vitest';
import { SkillRegistry } from '../../../src/skills/SkillRegistry.js';

describe('SkillRegistry prompt metadata', () => {
  it('renders model-invocable skills in a cache-stable order', () => {
    const registry = new SkillRegistry({ cwd: '/workspace' });
    registry.registerPluginSkill({
      originalName: 'zeta',
      namespacedName: 'plugin:zeta',
      pluginName: 'plugin',
      path: '/workspace/plugin/zeta',
      metadata: {
        name: 'plugin:zeta',
        description: 'Zeta capability',
        path: '/workspace/plugin/zeta/SKILL.md',
        basePath: '/workspace/plugin/zeta',
        source: 'project',
      },
    });
    registry.registerPluginSkill({
      originalName: 'alpha',
      namespacedName: 'plugin:alpha',
      pluginName: 'plugin',
      path: '/workspace/plugin/alpha',
      metadata: {
        name: 'plugin:alpha',
        description: 'Alpha capability',
        path: '/workspace/plugin/alpha/SKILL.md',
        basePath: '/workspace/plugin/alpha',
        source: 'project',
      },
    });

    expect(registry.generateAvailableSkillsList()).toBe(
      '- plugin:alpha: Alpha capability\n- plugin:zeta: Zeta capability'
    );
  });
});
