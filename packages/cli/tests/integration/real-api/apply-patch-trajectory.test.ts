import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Agent } from '../../../src/agent/Agent.js';
import { drainLoop, type LoopEvent } from '../../../src/agent/loop/index.js';
import { SessionRuntime } from '../../../src/agent/runtime/SessionRuntime.js';
import type { ChatContext } from '../../../src/agent/types.js';
import { setCwdState } from '../../../src/bootstrap/state.js';
import { ConfigManager } from '../../../src/config/ConfigManager.js';
import { PermissionMode } from '../../../src/config/types.js';
import { resetWorkspaceIdentityCache } from '../../../src/security/WorkspaceIdentity.js';
import { WorkspaceTrustService } from '../../../src/security/WorkspaceTrustService.js';
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

describeReal('ApplyPatch trajectory (real API)', () => {
  const originalStorageRoot = process.env.BLADE_STORAGE_ROOT;

  afterEach(() => {
    if (originalStorageRoot === undefined) delete process.env.BLADE_STORAGE_ROOT;
    else process.env.BLADE_STORAGE_ROOT = originalStorageRoot;
  });

  it('reads existing files and commits one atomic multi-file patch', async () => {
    if (!gpt) throw new Error('GPT qualification model is unavailable');
    const root = await mkdtemp(path.join(os.tmpdir(), 'blade-real-apply-patch-'));
    const workspace = path.join(root, 'workspace');
    const home = path.join(root, 'home');
    const first = path.join(workspace, 'first.ts');
    const second = path.join(workspace, 'second.ts');
    const added = path.join(workspace, 'added.ts');
    await mkdir(path.join(home, '.blade'), { recursive: true });
    await mkdir(workspace, { recursive: true });
    const canonicalWorkspace = await realpath(workspace);
    const canonicalFirst = path.join(canonicalWorkspace, 'first.ts');
    const canonicalSecond = path.join(canonicalWorkspace, 'second.ts');
    const canonicalAdded = path.join(canonicalWorkspace, 'added.ts');
    await writeFile(first, 'export const first = false;\n');
    await writeFile(second, 'export const second = false;\n');

    const originalCwd = getCwd();
    const originalConfig = getState().config.config;
    const homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(home);
    let runtime: SessionRuntime | undefined;
    let agent: Agent | undefined;
    try {
      process.env.BLADE_STORAGE_ROOT = path.join(root, 'storage');
      setCwdState(workspace);
      ConfigManager.resetInstance();
      WorkspaceTrustService.resetInstance();
      resetWorkspaceIdentityCache();
      await writeFile(
        path.join(home, '.blade', 'config.json'),
        `${JSON.stringify(buildRealApiRuntimeConfig(gpt), null, 2)}\n`
      );
      const config = await ConfigManager.getInstance().initialize();
      getState().config.actions.setConfig(config);

      const sessionId = `real-apply-patch-${Date.now()}`;
      runtime = await SessionRuntime.create({ sessionId, workspaceRoot: workspace });
      agent = await Agent.createWithRuntime(runtime, {
        sessionId,
        toolWhitelist: ['Read', 'ApplyPatch'],
        permissionMode: PermissionMode.YOLO,
        maxTurns: 8,
      });
      const context: ChatContext = {
        messages: [],
        userId: 'real-apply-patch-qualification',
        sessionId,
        workspaceRoot: workspace,
        permissionMode: PermissionMode.YOLO,
      };
      const events: LoopEvent[] = [];
      const result = await drainLoop(
        agent.chatStream(
          [
            `Read ${first} and ${second}.`,
            'Then call ApplyPatch exactly once. Do not call Edit, Write, or Bash.',
            'The patch must update first.ts and second.ts from false to true,',
            'and add added.ts containing exactly: export const added = true;',
            'After the successful ApplyPatch result, reply exactly APPLY_PATCH_REAL_OK.',
          ].join(' '),
          context,
          { stream: true }
        ),
        (event) => {
          events.push(event);
        }
      );
      expect(result.success).toBe(true);
      expect(result.finalMessage).toContain('APPLY_PATCH_REAL_OK');
      const toolResults = events.filter(
        (event): event is Extract<LoopEvent, { kind: 'tool_result' }> =>
          event.kind === 'tool_result' && 'function' in event.toolCall
      );
      const names = toolResults.map((event) => event.toolCall.function.name);
      expect(names.filter((name) => name === 'Read').length).toBeGreaterThanOrEqual(2);
      expect(names.filter((name) => name === 'ApplyPatch')).toHaveLength(1);
      expect(names).not.toContain('Edit');
      expect(names).not.toContain('Write');
      expect(names).not.toContain('Bash');
      const patchResult = toolResults.find(
        (event) => event.toolCall.function.name === 'ApplyPatch'
      )?.result;
      expect(patchResult).toMatchObject({
        success: true,
        metadata: {
          kind: 'patch',
          snapshot_created: true,
          changes: expect.arrayContaining([
            expect.objectContaining({ path: canonicalFirst, kind: 'update' }),
            expect.objectContaining({ path: canonicalSecond, kind: 'update' }),
            expect.objectContaining({ path: canonicalAdded, kind: 'add' }),
          ]),
        },
      });
      await expect(readFile(first, 'utf8')).resolves.toBe(
        'export const first = true;\n'
      );
      await expect(readFile(second, 'utf8')).resolves.toBe(
        'export const second = true;\n'
      );
      await expect(readFile(added, 'utf8')).resolves.toBe(
        'export const added = true;\n'
      );
      expect((await readdir(workspace, { recursive: true })).join('\n')).not.toContain(
        '.blade-patch-'
      );
      assertNoSecrets({ result, events }, [gpt.apiKey]);
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
