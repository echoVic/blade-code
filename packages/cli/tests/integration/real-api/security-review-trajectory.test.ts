import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resetWorkspaceAgentResources } from '../../../src/agent/resources/WorkspaceAgentResources.js';
import { SessionRuntime } from '../../../src/agent/runtime/SessionRuntime.js';
import { setCwdState } from '../../../src/bootstrap/state.js';
import { ConfigManager } from '../../../src/config/ConfigManager.js';
import { PermissionMode } from '../../../src/config/types.js';
import { resetWorkspaceIdentityCache } from '../../../src/security/WorkspaceIdentity.js';
import { WorkspaceTrustService } from '../../../src/security/WorkspaceTrustService.js';
import {
  CodeReviewService,
  renderCodeReview,
} from '../../../src/services/CodeReviewService.js';
import { SkillRegistry } from '../../../src/skills/SkillRegistry.js';
import securityReviewCommand from '../../../src/slash-commands/securityReview.js';
import { getState } from '../../../src/store/vanilla.js';
import { getCwd } from '../../../src/utils/cwd.js';
import {
  buildRealApiRuntimeConfig,
  isRealApiTestEnabled,
  resolveRequiredDeepSeekQualificationModels,
} from './testConfig.js';

const describeReal = isRealApiTestEnabled() ? describe : describe.skip;

describeReal('native security review (real API)', () => {
  it('finds a changed authorization bypass without modifying the workspace', async () => {
    const [model] = resolveRequiredDeepSeekQualificationModels();
    const root = await mkdtemp(path.join(os.tmpdir(), 'blade-real-security-review-'));
    const workspace = path.join(root, 'workspace');
    const previousCwd = getCwd();
    const previousConfig = getState().config.config;
    const previousStorage = process.env.BLADE_STORAGE_ROOT;
    let runtime: SessionRuntime | undefined;
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: workspace, encoding: 'utf8' }).trim();
    try {
      await mkdir(path.join(workspace, '.blade'), { recursive: true });
      await writeFile(
        path.join(workspace, 'account.mjs'),
        [
          '// req.auth.userId is set by the server session middleware.',
          '// req.params.id is the client-controlled /accounts/:id route parameter.',
          'export function account(req, accounts) {',
          "  if (req.auth.userId !== req.params.id) throw new Error('Forbidden');",
          '  return accounts[req.params.id];',
          '}',
          '',
        ].join('\n')
      );
      git('init', '-q');
      git('config', 'user.email', 'qualification@example.com');
      git('config', 'user.name', 'Qualification');
      git('add', 'account.mjs');
      git('commit', '-qm', 'baseline authorization');
      const changed = [
        '// req.auth.userId is set by the server session middleware.',
        '// req.params.id is the client-controlled /accounts/:id route parameter.',
        'export function account(req, accounts) {',
        '  return accounts[req.params.id];',
        '}',
        '',
      ].join('\n');
      await writeFile(path.join(workspace, 'account.mjs'), changed);
      process.env.BLADE_STORAGE_ROOT = path.join(root, 'storage');
      setCwdState(workspace);
      ConfigManager.resetInstance();
      WorkspaceTrustService.resetInstance();
      resetWorkspaceIdentityCache();
      resetWorkspaceAgentResources();
      SkillRegistry.resetInstance();
      const config = {
        ...buildRealApiRuntimeConfig(model),
        permissionMode: PermissionMode.DEFAULT,
        hooks: { enabled: false },
        disableAllHooks: true,
        mcpServers: {},
      };
      await writeFile(
        path.join(workspace, '.blade', 'config.json'),
        JSON.stringify({ models: config.models, currentModelId: config.currentModelId })
      );
      SkillRegistry.getInstance({
        cwd: workspace,
        userSkillsDir: path.join(root, 'user-skills'),
        claudeUserSkillsDir: path.join(root, 'claude-skills'),
      });
      await WorkspaceTrustService.getInstance().trust(workspace);
      getState().config.actions.setConfig(config);
      runtime = await SessionRuntime.create({
        sessionId: `security-review-${Date.now()}`,
        workspaceRoot: workspace,
      });
      const owningRuntime = runtime;
      const result = await securityReviewCommand.handler([], {
        cwd: workspace,
        sessionId: runtime.sessionId,
        acp: { sendMessage: () => undefined },
        codeReview: {
          run: async (request, signal) => {
            const run = await CodeReviewService.start({
              sessionId: owningRuntime.sessionId,
              projectPath: workspace,
              runtime: owningRuntime,
              request,
              signal,
            });
            const completion = await run.completion;
            const review = (
              await CodeReviewService.list(workspace, owningRuntime.sessionId)
            ).find((entry) => entry.start.reviewId === run.reviewId);
            if (!review) throw new Error('Review was not persisted');
            return {
              reviewId: run.reviewId,
              status: completion.status,
              findings: completion.findings.length,
              content: renderCodeReview(review.start, completion),
            };
          },
        },
      });
      expect(result.success).toBe(true);
      const [review] = await CodeReviewService.list(workspace, runtime.sessionId);
      expect(review?.start.mode).toBe('security');
      expect(review?.completion?.findings.length).toBeGreaterThan(0);
      expect(review?.completion?.findings[0]?.codeLocation.path).toBe('account.mjs');
      expect(result.content).toContain('## Security Review');
      console.log(
        `[security-review] ${JSON.stringify({
          model: model.model,
          mode: review?.start.mode,
          findings: review?.completion?.findings.length,
          status: review?.completion?.status,
        })}`
      );
      expect(await readFile(path.join(workspace, 'account.mjs'), 'utf8')).toBe(changed);
    } finally {
      await runtime?.dispose();
      resetWorkspaceAgentResources();
      SkillRegistry.resetInstance();
      WorkspaceTrustService.resetInstance();
      resetWorkspaceIdentityCache();
      ConfigManager.resetInstance();
      setCwdState(previousCwd);
      if (previousConfig) getState().config.actions.setConfig(previousConfig);
      if (previousStorage === undefined) delete process.env.BLADE_STORAGE_ROOT;
      else process.env.BLADE_STORAGE_ROOT = previousStorage;
      await rm(root, { recursive: true, force: true });
    }
  }, 180_000);
});
