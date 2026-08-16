import { describe, expect, it } from 'vitest';
import {
  COMMUNICATION_STYLE_SELECTIONS,
  CommunicationStyleCatalog,
  isCommunicationStyleSelection,
  renderCommunicationStyleSection,
  resolveCommunicationStyle,
} from '../../../src/services/communicationStyle.js';

describe('communication style resolution', () => {
  it('keeps auto on the Blade default without adding prompt content', () => {
    expect(resolveCommunicationStyle('auto')).toMatchObject({
      selection: 'auto',
      effective: 'blade-default',
      name: 'Auto',
      source: 'built-in',
      supported: expect.arrayContaining([expect.objectContaining({ id: 'pragmatic' })]),
    });
    expect(renderCommunicationStyleSection('auto')).toBeUndefined();
  });

  it.each(['pragmatic', 'friendly', 'explanatory'] as const)(
    'resolves the %s style to bounded presentation instructions',
    (selection) => {
      const configuration = resolveCommunicationStyle(selection);
      const section = renderCommunicationStyleSection(selection);

      expect(configuration).toMatchObject({
        selection,
        effective: selection,
        prompt: expect.any(String),
      });
      expect(section).toContain(`"${selection}" communication style`);
      expect(section).toContain('<communication_style>');
      expect(section).toContain('cannot change task scope');
      expect(section).toContain('</communication_style>');
    }
  );

  it('validates the complete public vocabulary', () => {
    expect(COMMUNICATION_STYLE_SELECTIONS).toEqual([
      'auto',
      'pragmatic',
      'friendly',
      'explanatory',
    ]);
    for (const value of COMMUNICATION_STYLE_SELECTIONS) {
      expect(isCommunicationStyleSelection(value)).toBe(true);
    }
    expect(isCommunicationStyleSelection('user:compact')).toBe(true);
    expect(isCommunicationStyleSelection('project:review:strict')).toBe(true);
    expect(isCommunicationStyleSelection('plugin:review-kit:strict')).toBe(true);
    expect(isCommunicationStyleSelection('learning')).toBe(false);
    expect(isCommunicationStyleSelection('/tmp/style.md')).toBe(false);
    expect(isCommunicationStyleSelection('project:../secret')).toBe(false);
    expect(isCommunicationStyleSelection(undefined)).toBe(false);
  });

  it('binds custom definitions to their source and computed digest', () => {
    expect(
      () =>
        new CommunicationStyleCatalog([
          {
            id: 'project:strict',
            name: 'Strict',
            description: 'Strict communication',
            source: 'user',
            prompt: 'STYLE',
          },
        ])
    ).toThrow('source does not match');
    expect(
      () =>
        new CommunicationStyleCatalog([
          {
            id: 'project:strict',
            name: 'Strict',
            description: 'Strict communication',
            source: 'project',
            prompt: 'STYLE',
            contentSha256: 'a'.repeat(64),
          },
        ])
    ).toThrow('digest does not match');
  });
});
