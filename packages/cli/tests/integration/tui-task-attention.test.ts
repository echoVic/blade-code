import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.unmock('node:child_process');

import { PermissionMode } from '../../src/config/types.js';
import { PersistentStore } from '../../src/context/storage/PersistentStore.js';
import { resetProjectionDbCache } from '../../src/context/storage/sqlite/projection.js';
import { SessionService } from '../../src/services/SessionService.js';
import {
  captureProcessIdentity,
  type ProcessIdentity,
  processIdentityMatches,
} from '../../src/utils/process/ProcessIdentity.js';
import { runTuiTaskAttentionPtyDriver } from '../support/tuiTaskAttentionPtyDriver.js';

const roots: string[] = [];
const originalStorageRoot = process.env.BLADE_STORAGE_ROOT;
const cliEntry = path.resolve(import.meta.dirname, '../../dist/blade.js');

afterEach(async () => {
  resetProjectionDbCache();
  if (originalStorageRoot === undefined) delete process.env.BLADE_STORAGE_ROOT;
  else process.env.BLADE_STORAGE_ROOT = originalStorageRoot;
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe.skipIf(process.platform === 'win32')(
  'TUI durable task attention raw PTY lifecycle',
  () => {
    const requireProductionCli = () => access(cliEntry);

    it('marks a missed terminal transition NEW until the exact Session opens', async () => {
      await requireProductionCli();
      const root = await mkdtemp(path.join(os.tmpdir(), 'blade-tui-attention-pty-'));
      roots.push(root);
      const workspace = path.join(root, 'workspace');
      const storageRoot = path.join(root, 'storage');
      const home = path.join(root, 'home');
      const sessionId = `attention-${Date.now()}`;
      const title = 'Deterministic attention task';
      const terminalContent = `ATTENTION_TERMINAL_${Date.now()}`;
      await Promise.all([
        mkdir(workspace, { recursive: true }),
        mkdir(storageRoot, { recursive: true }),
        mkdir(path.join(home, '.blade'), { recursive: true }),
      ]);
      await writeFile(
        path.join(home, '.blade', 'config.json'),
        `${JSON.stringify(
          {
            currentModelId: 'attention-fixture',
            models: [
              {
                id: 'attention-fixture',
                displayName: 'Attention Fixture',
                provider: 'deepseek',
                model: 'deepseek-v4-flash',
                overrides: { maxRetries: 0 },
              },
            ],
            permissionMode: PermissionMode.YOLO,
            hooks: { enabled: false },
            disableAllHooks: true,
            mcpServers: {},
          },
          null,
          2
        )}\n`,
        { mode: 0o600 }
      );

      process.env.BLADE_STORAGE_ROOT = storageRoot;
      resetProjectionDbCache();
      await SessionService.createSessionMetadata(sessionId, workspace, {
        title,
        taskStatus: 'running',
        selectedModelId: 'attention-fixture',
        permissionMode: PermissionMode.YOLO,
      });

      const evidence = await runTuiTaskAttentionPtyDriver({
        workspace,
        storageRoot,
        home,
        sessionId,
        title,
        terminalContent,
        completeTask: async () => {
          const store = new PersistentStore(workspace);
          const userMessageId = await store.saveMessage(
            sessionId,
            'user',
            'Return the terminal attention marker.'
          );
          await store.saveMessage(
            sessionId,
            'assistant',
            terminalContent,
            userMessageId
          );
          await SessionService.updateSessionMetadata(sessionId, workspace, {
            taskStatus: 'completed',
            taskCompletedAt: new Date().toISOString(),
          });
        },
      });

      expect(evidence).toMatchObject({
        baselinePersisted: true,
        firstMarkerAbsent: true,
        newMarkerSeen: true,
        exactSessionSelected: true,
        terminalContentSeen: true,
        markerCleared: true,
        faults: [],
        leakedSecrets: [],
      });
      expect(evidence.output.length).toBeLessThanOrEqual(12_000);
    }, 120_000);

    it('terminates its runner promptly when task completion fails', async () => {
      await requireProductionCli();
      const root = await mkdtemp(path.join(os.tmpdir(), 'blade-tui-attention-fail-'));
      roots.push(root);
      const workspace = path.join(root, 'workspace');
      const storageRoot = path.join(root, 'storage');
      const home = path.join(root, 'home');
      const sessionId = `attention-failure-${Date.now()}`;
      await Promise.all([
        mkdir(workspace, { recursive: true }),
        mkdir(storageRoot, { recursive: true }),
        mkdir(path.join(home, '.blade'), { recursive: true }),
      ]);
      await writeFile(
        path.join(home, '.blade', 'config.json'),
        `${JSON.stringify({
          currentModelId: 'attention-fixture',
          models: [
            {
              id: 'attention-fixture',
              displayName: 'Attention Fixture',
              provider: 'deepseek',
              model: 'deepseek-v4-flash',
            },
          ],
          permissionMode: PermissionMode.YOLO,
          hooks: { enabled: false },
          disableAllHooks: true,
          mcpServers: {},
        })}\n`,
        { mode: 0o600 }
      );
      process.env.BLADE_STORAGE_ROOT = storageRoot;
      resetProjectionDbCache();
      await SessionService.createSessionMetadata(sessionId, workspace, {
        title: 'Failing completion fixture',
        taskStatus: 'running',
      });
      const startedAt = Date.now();

      await expect(
        runTuiTaskAttentionPtyDriver({
          workspace,
          storageRoot,
          home,
          sessionId,
          title: 'Failing completion fixture',
          terminalContent: 'never-rendered',
          completeTask: async () => {
            throw new Error('fixture completion rejected');
          },
        })
      ).rejects.toThrow('fixture completion rejected');
      expect(Date.now() - startedAt).toBeLessThan(15_000);
    }, 30_000);

    it('bounds a task completion callback that never settles', async () => {
      await requireProductionCli();
      const root = await mkdtemp(path.join(os.tmpdir(), 'blade-tui-attention-hang-'));
      roots.push(root);
      const workspace = path.join(root, 'workspace');
      const storageRoot = path.join(root, 'storage');
      const home = path.join(root, 'home');
      const sessionId = `attention-hang-${Date.now()}`;
      await Promise.all([
        mkdir(workspace, { recursive: true }),
        mkdir(storageRoot, { recursive: true }),
        mkdir(path.join(home, '.blade'), { recursive: true }),
      ]);
      await writeFile(
        path.join(home, '.blade', 'config.json'),
        `${JSON.stringify({
          currentModelId: 'attention-fixture',
          models: [
            {
              id: 'attention-fixture',
              displayName: 'Attention Fixture',
              provider: 'deepseek',
              model: 'deepseek-v4-flash',
            },
          ],
          permissionMode: PermissionMode.YOLO,
          hooks: { enabled: false },
          disableAllHooks: true,
          mcpServers: {},
        })}\n`,
        { mode: 0o600 }
      );
      process.env.BLADE_STORAGE_ROOT = storageRoot;
      resetProjectionDbCache();
      await SessionService.createSessionMetadata(sessionId, workspace, {
        title: 'Never settling completion fixture',
        taskStatus: 'running',
      });
      const startedAt = Date.now();
      let runnerPid: number | undefined;
      let runnerIdentity: ProcessIdentity | undefined;

      await expect(
        runTuiTaskAttentionPtyDriver({
          workspace,
          storageRoot,
          home,
          sessionId,
          title: 'Never settling completion fixture',
          terminalContent: 'never-rendered',
          completionTimeoutMs: 1_000,
          timeoutMs: 15_000,
          onRunnerSpawn: (pid) => {
            runnerPid = pid;
            runnerIdentity = captureProcessIdentity(pid);
          },
          completeTask: () => new Promise<void>(() => undefined),
        })
      ).rejects.toThrow('completion callback exceeded its deadline');
      expect(Date.now() - startedAt).toBeLessThan(10_000);
      expect(runnerPid).toEqual(expect.any(Number));
      expect(
        runnerPid && runnerIdentity
          ? processIdentityMatches(runnerPid, runnerIdentity)
          : true
      ).toBe(false);
    }, 30_000);

    it('cleans up the runner tree when the outer runner deadline expires', async () => {
      const root = await mkdtemp(
        path.join(os.tmpdir(), 'blade-tui-attention-timeout-')
      );
      roots.push(root);
      const workspace = path.join(root, 'workspace');
      const storageRoot = path.join(root, 'storage');
      const home = path.join(root, 'home');
      const sessionId = `attention-timeout-${Date.now()}`;
      await Promise.all([
        mkdir(workspace, { recursive: true }),
        mkdir(storageRoot, { recursive: true }),
        mkdir(path.join(home, '.blade'), { recursive: true }),
      ]);
      await writeFile(
        path.join(home, '.blade', 'config.json'),
        `${JSON.stringify({
          currentModelId: 'attention-fixture',
          models: [
            {
              id: 'attention-fixture',
              displayName: 'Attention Fixture',
              provider: 'deepseek',
              model: 'deepseek-v4-flash',
            },
          ],
          permissionMode: PermissionMode.YOLO,
          hooks: { enabled: false },
          disableAllHooks: true,
          mcpServers: {},
        })}\n`,
        { mode: 0o600 }
      );
      process.env.BLADE_STORAGE_ROOT = storageRoot;
      resetProjectionDbCache();
      await SessionService.createSessionMetadata(sessionId, workspace, {
        title: 'Outer deadline fixture',
        taskStatus: 'running',
      });
      const startedAt = Date.now();
      let runnerPid: number | undefined;
      let runnerIdentity: ProcessIdentity | undefined;

      await expect(
        runTuiTaskAttentionPtyDriver({
          workspace,
          storageRoot,
          home,
          sessionId,
          title: 'Outer deadline fixture',
          terminalContent: 'never-rendered',
          completionTimeoutMs: 30_000,
          timeoutMs: 1_000,
          onRunnerSpawn: (pid) => {
            runnerPid = pid;
            runnerIdentity = captureProcessIdentity(pid);
          },
          completeTask: () => new Promise<void>(() => undefined),
        })
      ).rejects.toThrow('runner exceeded its deadline');
      expect(Date.now() - startedAt).toBeLessThan(10_000);
      expect(runnerPid).toEqual(expect.any(Number));
      expect(
        runnerPid && runnerIdentity
          ? processIdentityMatches(runnerPid, runnerIdentity)
          : true
      ).toBe(false);
    }, 30_000);
  }
);
