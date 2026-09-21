import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('runtime dependency boundary', () => {
  it('declares pathe because production modules import it directly', async () => {
    const packageJson = JSON.parse(
      await readFile(path.resolve('package.json'), 'utf8')
    ) as {
      dependencies?: Record<string, string>;
    };

    expect(packageJson.dependencies?.pathe).toBe('^2.0.3');
  });
});
