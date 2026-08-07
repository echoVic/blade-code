import { afterEach, describe, expect, it } from 'vitest';
import { SkillRegistry, getSkillRegistry } from '../../../src/skills/SkillRegistry.js';
import { CustomCommandRegistry } from '../../../src/slash-commands/custom/CustomCommandRegistry.js';

describe('workspace-scoped registries', () => {
  afterEach(() => {
    SkillRegistry.resetInstance();
    CustomCommandRegistry.resetInstance();
  });

  it('keeps skill registries isolated by workspace', () => {
    const first = getSkillRegistry({ cwd: '/workspace/a' });
    const same = getSkillRegistry({ cwd: '/workspace/a/.' });
    const second = getSkillRegistry({ cwd: '/workspace/b' });

    expect(same).toBe(first);
    expect(second).not.toBe(first);
  });

  it('keeps custom command registries isolated by workspace', () => {
    const first = CustomCommandRegistry.getInstance('/workspace/a');
    const same = CustomCommandRegistry.getInstance('/workspace/a/.');
    const second = CustomCommandRegistry.getInstance('/workspace/b');

    expect(same).toBe(first);
    expect(second).not.toBe(first);
  });
});
