import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('release ownership contract', () => {
  it('publishes npm only from the tag workflow', async () => {
    const configPath = path.resolve(__dirname, '../../../release.config.js');
    const { default: releaseConfig } = (await import(
      pathToFileURL(configPath).href
    )) as {
      default: { publish: { npm: boolean; git: boolean } };
    };
    const publishWorkflow = fs.readFileSync(
      path.resolve(__dirname, '../../../../../.github/workflows/publish.yml'),
      'utf8'
    );

    expect(releaseConfig.publish.npm).toBe(false);
    expect(releaseConfig.publish.git).toBe(true);
    expect(publishWorkflow).toContain("- 'v*.*.*'");
    expect(publishWorkflow).toContain('npm publish --access public');
  });

  it('does not ship notification credentials in source', () => {
    const configSource = fs.readFileSync(
      path.resolve(__dirname, '../../../release.config.js'),
      'utf8'
    );

    expect(/https:\/\/discord\.com\/api\/webhooks\//.test(configSource)).toBe(false);
  });
});
