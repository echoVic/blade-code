import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const configPath = path.resolve(__dirname, '../../../release.config.js');
const workflowsPath = path.resolve(__dirname, '../../../../../.github/workflows');
const publishWorkflowPath = path.join(workflowsPath, 'publish.yml');

interface WorkflowStep {
  name?: string;
  run?: string;
}

interface PublishWorkflow {
  jobs?: {
    publish?: {
      steps?: WorkflowStep[];
    };
  };
}

async function loadReleaseConfig(cacheKey: string) {
  return (await import(`${pathToFileURL(configPath).href}?${cacheKey}`)).default as {
    publish: { npm: boolean; git: boolean };
    notifications: { discord: { webhookUrl?: string } };
  };
}

describe('release ownership contract', () => {
  it('publishes npm only from the tag workflow', async () => {
    const releaseConfig = await loadReleaseConfig('publish-owner');
    const workflowFiles = fs
      .readdirSync(workflowsPath)
      .filter((file) => /\.ya?ml$/.test(file));
    const npmPublishers = workflowFiles.filter((file) =>
      fs.readFileSync(path.join(workflowsPath, file), 'utf8').includes('npm publish')
    );
    const publishWorkflow = fs.readFileSync(publishWorkflowPath, 'utf8');

    expect(releaseConfig.publish.npm).toBe(false);
    expect(releaseConfig.publish.git).toBe(true);
    expect(npmPublishers).toEqual(['publish.yml']);
    expect(publishWorkflow).toContain("- 'v*.*.*'");
    expect(publishWorkflow).toContain('oven-sh/setup-bun@v2');
    expect(publishWorkflow).toContain('bun-version: 1.3.11');
    expect(publishWorkflow).toContain('bun install --frozen-lockfile');
    expect(publishWorkflow).toContain('workflow_dispatch:');
    expect(publishWorkflow).toContain('tag_version="${RELEASE_TAG#v}"');
    expect(publishWorkflow).toContain('npm view "${package_name}@${package_version}"');
    expect(publishWorkflow).toContain('npm publish --access public');
    expect(publishWorkflow).toContain('gh release view "$RELEASE_TAG"');
    expect(publishWorkflow).toContain('gh release create "$RELEASE_TAG"');
    expect(publishWorkflow).not.toContain('actions/create-release');
  });

  it('keeps every publish workflow shell block syntactically valid', () => {
    const workflow = parse(
      fs.readFileSync(publishWorkflowPath, 'utf8')
    ) as PublishWorkflow;
    const scriptSteps =
      workflow.jobs?.publish?.steps?.filter(
        (step): step is WorkflowStep & { run: string } => typeof step.run === 'string'
      ) ?? [];

    expect(scriptSteps.length).toBeGreaterThan(0);
    for (const step of scriptSteps) {
      const result = spawnSync('bash', ['-n'], {
        input: step.run,
        encoding: 'utf8',
      });
      expect(result.status, `${step.name ?? 'unnamed step'}: ${result.stderr}`).toBe(0);
    }
  });

  it('loads notification credentials only from the environment', async () => {
    const previousWebhook = process.env.DISCORD_WEBHOOK_URL;
    process.env.DISCORD_WEBHOOK_URL = 'https://example.invalid/test-webhook';

    try {
      const releaseConfig = await loadReleaseConfig('notification-env');
      const configSource = fs.readFileSync(configPath, 'utf8');

      expect(releaseConfig.notifications.discord.webhookUrl).toBe(
        'https://example.invalid/test-webhook'
      );
      expect(/https:\/\/discord\.com\/api\/webhooks\//.test(configSource)).toBe(false);
    } finally {
      if (previousWebhook === undefined) {
        delete process.env.DISCORD_WEBHOOK_URL;
      } else {
        process.env.DISCORD_WEBHOOK_URL = previousWebhook;
      }
    }
  });
});
