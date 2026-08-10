import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Agent } from '../../../src/agent/Agent.js';
import { drainLoop } from '../../../src/agent/loop/index.js';
import { SessionRuntime } from '../../../src/agent/runtime/SessionRuntime.js';
import type { ChatContext } from '../../../src/agent/types.js';
import { setCwdState } from '../../../src/bootstrap/state.js';
import { ConfigManager } from '../../../src/config/ConfigManager.js';
import { PermissionMode } from '../../../src/config/types.js';
import { resetWorkspaceIdentityCache } from '../../../src/security/WorkspaceIdentity.js';
import { WorkspaceTrustService } from '../../../src/security/WorkspaceTrustService.js';
import { SessionService } from '../../../src/services/SessionService.js';
import exportCommand from '../../../src/slash-commands/export.js';
import { getState } from '../../../src/store/vanilla.js';
import { getCwd } from '../../../src/utils/cwd.js';
import { assertNoSecrets } from './sessionForkTrajectoryHarness.js';
import {
  buildRealApiRuntimeConfig,
  isRealApiTestEnabled,
  resolveForkQualificationModels,
} from './testConfig.js';

const gpt = isRealApiTestEnabled()
  ? resolveForkQualificationModels(process.env).find((model) => model.id === 'gpt')
  : undefined;
const describeReal = gpt ? describe.sequential : describe.skip;

describeReal('Portable session Markdown export trajectory (real API)', () => {
  const originalStorageRoot = process.env.BLADE_STORAGE_ROOT;

  afterEach(() => {
    if (originalStorageRoot === undefined) delete process.env.BLADE_STORAGE_ROOT;
    else process.env.BLADE_STORAGE_ROOT = originalStorageRoot;
  });

  it('exports a real GPT tool trajectory without portable secrets or host paths', async () => {
    if (!gpt) throw new Error('GPT qualification model is unavailable');
    const root = await mkdtemp(path.join(os.tmpdir(), 'blade-real-export-'));
    const workspace = path.join(root, 'workspace');
    const home = path.join(root, 'home');
    const storageRoot = path.join(root, 'storage');
    const source = path.join(workspace, 'evidence.txt');
    const output = path.join(workspace, 'portable-conversation.md');
    const marker = `EXPORT_VISIBLE_MARKER_${Date.now()}`;
    const fixtureSecret = 'sk-EXPORT_SECRET_1234567890';
    const fixtureHostPath = '/Users/export-owner/private/evidence.txt';
    await mkdir(path.join(workspace, '.blade'), { recursive: true });
    await mkdir(path.join(home, '.blade'), { recursive: true });
    await writeFile(
      source,
      `${marker}\n${fixtureSecret}\n${fixtureHostPath}\n`,
      'utf8'
    );

    const originalCwd = getCwd();
    const originalConfig = getState().config.config;
    const homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(home);
    const sessionId = `real-export-${Date.now()}`;
    let runtime: SessionRuntime | undefined;
    let agent: Agent | undefined;

    try {
      process.env.BLADE_STORAGE_ROOT = storageRoot;
      setCwdState(workspace);
      ConfigManager.resetInstance();
      WorkspaceTrustService.resetInstance();
      resetWorkspaceIdentityCache();
      await writeFile(
        path.join(home, '.blade', 'config.json'),
        `${JSON.stringify(buildRealApiRuntimeConfig(gpt), null, 2)}\n`
      );
      await writeFile(
        path.join(workspace, '.blade', 'config.json'),
        `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`
      );
      await WorkspaceTrustService.getInstance().trust(workspace);
      const config = await ConfigManager.getInstance().initialize();
      getState().config.actions.setConfig(config);

      runtime = await SessionRuntime.create({
        sessionId,
        workspaceRoot: workspace,
        mcpServers: {},
        agents: [],
      });
      agent = await Agent.createWithRuntime(runtime, {
        sessionId,
        permissionMode: PermissionMode.YOLO,
        toolWhitelist: ['Read'],
        maxTurns: 6,
      });
      const context: ChatContext = {
        messages: [],
        userId: 'real-session-export-qualification',
        sessionId,
        workspaceRoot: workspace,
        permissionMode: PermissionMode.YOLO,
      };
      const result = await drainLoop(
        agent.chatStream(
          [
            'Use the Read tool exactly once to read all three lines of the workspace file evidence.txt.',
            'You must inspect line 1 through line 3: confirm line 1 starts with EXPORT_VISIBLE_MARKER_, line 2 resembles an API key, and line 3 is an absolute host path.',
            'Do not repeat any file content or call another tool.',
            'After Read succeeds, reply exactly SESSION_EXPORT_REAL_OK.',
          ].join(' '),
          context,
          { stream: true }
        )
      );
      expect(result.success).toBe(true);
      expect(result.finalMessage?.trim()).toBe('SESSION_EXPORT_REAL_OK');
      await agent.destroy();
      agent = undefined;
      await runtime.dispose();
      runtime = undefined;

      const exported = await SessionService.exportSessionMarkdown(sessionId, workspace);
      expect(exported.markdown).toContain('## User');
      expect(exported.markdown).toContain('## Activity: Read call');
      expect(exported.markdown).toContain('## Activity: Read result');
      expect(exported.markdown).toContain('## Assistant');
      expect(exported.markdown).toContain(marker);
      expect(exported.markdown).toContain('[redacted-key]');
      expect(exported.markdown).toContain('[host-path]');
      expect(exported.markdown).not.toContain(fixtureSecret);
      expect(exported.markdown).not.toContain(fixtureHostPath);
      expect(exported.markdown).not.toContain(workspace);
      expect(exported.markdown).not.toContain(gpt.apiKey);
      const body = exported.markdown.split('\n---\n\n')[1];
      expect(body).toBeDefined();
      expect(createHash('sha256').update(body!).digest('hex')).toBe(
        exported.contentSha256
      );

      const tui = await exportCommand.handler([output], {
        cwd: workspace,
        workspaceRoot: workspace,
        sessionId,
        surface: 'tui',
      });
      expect(tui).toMatchObject({
        success: true,
        data: {
          action: 'session_exported',
          contentSha256: exported.contentSha256,
        },
      });
      const written = await readFile(output, 'utf8');
      expect(written).toBe(exported.markdown);
      if (process.platform !== 'win32') {
        expect((await stat(output)).mode & 0o777).toBe(0o600);
      }
      await expect(
        exportCommand.handler([output], {
          cwd: workspace,
          workspaceRoot: workspace,
          sessionId,
          surface: 'tui',
        })
      ).resolves.toMatchObject({
        success: false,
        error: expect.stringContaining('already exists'),
      });
      expect(await readFile(output, 'utf8')).toBe(written);

      const acp = await exportCommand.handler([], {
        cwd: workspace,
        workspaceRoot: workspace,
        sessionId,
        surface: 'acp',
      });
      expect(acp).toMatchObject({
        success: true,
        content: exported.markdown,
        data: {
          filename: exported.filename,
          contentSha256: exported.contentSha256,
        },
      });
      assertNoSecrets({ result, exported, tui, acp }, [gpt.apiKey]);
    } finally {
      await agent?.destroy().catch(() => undefined);
      await runtime?.dispose().catch(() => undefined);
      homedirSpy.mockRestore();
      setCwdState(originalCwd);
      ConfigManager.resetInstance();
      WorkspaceTrustService.resetInstance();
      resetWorkspaceIdentityCache();
      if (originalConfig) getState().config.actions.setConfig(originalConfig);
      await rm(root, { recursive: true, force: true });
    }
  }, 180_000);
});
