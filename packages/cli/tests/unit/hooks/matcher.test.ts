import { describe, expect, it } from 'vitest';
import { Matcher } from '../../../src/hooks/Matcher.js';

describe('Hook Matcher multi-file tools', () => {
  const matcher = new Matcher();
  const context = {
    toolName: 'ApplyPatch',
    filePath: 'docs/readme.md',
    filePaths: ['docs/readme.md', 'src/app.ts'],
  };

  it('matches path configuration against any affected file', () => {
    expect(matcher.matches({ paths: 'src/**' }, context)).toBe(true);
    expect(matcher.matches({ paths: 'tests/**' }, context)).toBe(false);
  });

  it('matches tool parameter patterns against any affected file', () => {
    expect(matcher.matches({ tools: 'ApplyPatch(src/**)' }, context)).toBe(true);
    expect(matcher.matches({ tools: 'ApplyPatch(tests/**)' }, context)).toBe(false);
  });

  it('fails closed when a path matcher has no path context', () => {
    expect(
      matcher.matches(
        { paths: '**/*.ts' },
        {
          toolName: 'ApplyPatch',
        }
      )
    ).toBe(false);
  });
});
