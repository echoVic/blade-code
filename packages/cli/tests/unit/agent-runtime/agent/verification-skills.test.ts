import { describe, expect, it } from 'vitest';
import { projectVerificationSkillGuidance } from '../../../../src/agent/subagents/verificationSkills.js';
import type { SkillMetadata } from '../../../../src/skills/types.js';

function skill(
  name: string,
  source: SkillMetadata['source'] = 'project',
  path = `/workspace/.blade/skills/${name}/SKILL.md`
): SkillMetadata {
  return { name, source, path, basePath: '', description: 'fixture' };
}

describe('verification skill snapshot guidance', () => {
  const registry = {
    getModelInvocableSkills: () => [
      skill('verify-types'),
      skill('verify-tests'),
      skill('ordinary'),
      skill('verify-global', 'user'),
    ],
  };

  it.each(['verification', 'goal-verification'])(
    'gives %s only the project verification paths, in stable order',
    (type) => {
      const result = projectVerificationSkillGuidance(type, registry);
      expect(result).toContain('verify-tests');
      expect(result).toContain('verify-types');
      expect(result.indexOf('verify-tests')).toBeLessThan(
        result.indexOf('verify-types')
      );
      expect(result).not.toContain('ordinary');
      expect(result).not.toContain('verify-global');
      expect(result).toContain('never permission grants');
    }
  );

  it('does not alter ordinary agents or review scope', () => {
    expect(projectVerificationSkillGuidance('general-purpose', registry)).toBe('');
    expect(projectVerificationSkillGuidance('review', registry)).toBe('');
  });

  it('does not discover skills outside the supplied Session snapshot', () => {
    expect(projectVerificationSkillGuidance('verification', undefined)).toContain(
      'No project verification skills'
    );
  });
});
