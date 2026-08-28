import { readFileSync } from 'node:fs';
import path from 'node:path';
import fg from 'fast-glob';
import { describe, expect, it } from 'vitest';

describe('terminal input router source gate', () => {
  it('keeps the native Ink input subscription inside one router module', () => {
    const sourceRoot = path.resolve(import.meta.dirname, '../../../../src/ui');
    const files = fg.sync('**/*.{ts,tsx}', { cwd: sourceRoot, absolute: true });
    const nativeInputOwners = files
      .filter((file) => {
        const source = readFileSync(file, 'utf8');
        return /import\s*\{[^}]*\buseInput(?:\s+as\s+\w+)?\b[^}]*\}\s*from\s*['"]ink['"]/.test(
          source
        );
      })
      .map((file) => path.relative(sourceRoot, file));

    expect(nativeInputOwners).toEqual(['input/TerminalInputRouter.tsx']);
  });
});
