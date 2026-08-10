import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
import { parseSessionJSONL } from '../../../src/context/storage/JSONLStore.js';
import { getSessionFilePath } from '../../../src/context/storage/pathUtils.js';
import { resetWorkspaceIdentityCache } from '../../../src/security/WorkspaceIdentity.js';
import { WorkspaceTrustService } from '../../../src/security/WorkspaceTrustService.js';
import {
  SessionArchivedError,
  SessionService,
} from '../../../src/services/SessionService.js';
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

describeReal('Session archive lifecycle trajectory (real API)', () => {
  const originalStorageRoot = process.env.BLADE_STORAGE_ROOT;

  afterEach(() => {
    if (originalStorageRoot === undefined) delete process.env.BLADE_STORAGE_ROOT;
    else process.env.BLADE_STORAGE_ROOT = originalStorageRoot;
  });

  it('blocks a real GPT session while archived and resumes its durable context after restore', async () => {
    if (!gpt) throw new Error('GPT qualification model is unavailable');
    const root = await mkdtemp(path.join(os.tmpdir(), 'blade-real-archive-'));
    const workspace = path.join(root, 'workspace');
    const home = path.join(root, 'home');
    const storageRoot = path.join(root, 'storage');
    await mkdir(path.join(workspace, '.blade'), { recursive: true });
    await mkdir(path.join(home, '.blade'), { recursive: true });

    const originalCwd = getCwd();
    const originalConfig = getState().config.config;
    const homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(home);
    const sessionId = `real-archive-${Date.now()}`;
    const phaseOne = `ARCHIVE_PHASE_ONE_${Date.now()}`;
    const phaseTwo = `ARCHIVE_PHASE_TWO_${Date.now()}`;
    let runtime: SessionRuntime | undefined;
    let agent: Agent | undefined;

    const releaseOwner = async (): Promise<void> => {
      try {
        await agent?.destroy();
      } finally {
        agent = undefined;
        await runtime?.dispose();
        runtime = undefined;
      }
    };

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
        toolWhitelist: [],
        maxTurns: 4,
      });
      const firstContext: ChatContext = {
        messages: [],
        userId: 'real-session-archive-qualification',
        sessionId,
        workspaceRoot: workspace,
        permissionMode: PermissionMode.YOLO,
      };
      const first = await drainLoop(
        agent.chatStream(
          `Reply with exactly ${phaseOne} and no other text. Do not call tools.`,
          firstContext,
          { stream: true }
        )
      );
      expect(first.success).toBe(true);
      expect(first.finalMessage?.trim()).toBe(phaseOne);
      await releaseOwner();

      const archived = await SessionService.archiveSession(sessionId, workspace);
      expect(archived).toMatchObject({
        sessionId,
        archivedBySessionId: sessionId,
        archivedAt: expect.any(String),
      });
      expect(
        (await SessionService.listSessions({ cwd: workspace })).map(
          (session) => session.sessionId
        )
      ).not.toContain(sessionId);
      expect(
        (
          await SessionService.listSessions({
            cwd: workspace,
            archived: true,
          })
        ).map((session) => session.sessionId)
      ).toContain(sessionId);
      await expect(
        SessionRuntime.create({
          sessionId,
          workspaceRoot: workspace,
          mcpServers: {},
          agents: [],
        })
      ).rejects.toBeInstanceOf(SessionArchivedError);
      await expect(
        SessionService.updateSessionMetadata(sessionId, workspace, {
          title: 'must-not-write-while-archived',
        })
      ).rejects.toBeInstanceOf(SessionArchivedError);

      const restored = await SessionService.unarchiveSession(sessionId, workspace);
      expect(restored.archivedAt).toBeUndefined();
      const history = await SessionService.loadSession(sessionId, workspace);
      expect(JSON.stringify(history)).toContain(phaseOne);

      runtime = await SessionRuntime.create({
        sessionId,
        workspaceRoot: workspace,
        mcpServers: {},
        agents: [],
      });
      agent = await Agent.createWithRuntime(runtime, {
        sessionId,
        permissionMode: PermissionMode.YOLO,
        toolWhitelist: [],
        maxTurns: 4,
      });
      const secondContext: ChatContext = {
        messages: history,
        userId: 'real-session-archive-qualification',
        sessionId,
        workspaceRoot: workspace,
        permissionMode: PermissionMode.YOLO,
      };
      const second = await drainLoop(
        agent.chatStream(
          [
            `The previous assistant response was ${phaseOne}.`,
            `Reply with exactly ${phaseTwo} and no other text.`,
            'Do not call tools.',
          ].join(' '),
          secondContext,
          { stream: true }
        )
      );
      expect(second.success).toBe(true);
      expect(second.finalMessage?.trim()).toBe(phaseTwo);
      await releaseOwner();

      const transcript = await readFile(
        getSessionFilePath(workspace, sessionId),
        'utf8'
      );
      const events = parseSessionJSONL(transcript, 'archive-qualification');
      const archiveTransitions = events
        .filter((event) => event.type === 'session_updated')
        .flatMap((event) =>
          Object.hasOwn(event.data, 'archivedAt') ? [event.data.archivedAt] : []
        );
      expect(archiveTransitions).toEqual([expect.any(String), null]);
      expect(transcript).toContain(phaseOne);
      expect(transcript).toContain(phaseTwo);
      expect(transcript).not.toContain('must-not-write-while-archived');
      assertNoSecrets({ first, second, firstContext, secondContext, transcript }, [
        gpt.apiKey,
      ]);
    } finally {
      await releaseOwner().catch(() => undefined);
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
