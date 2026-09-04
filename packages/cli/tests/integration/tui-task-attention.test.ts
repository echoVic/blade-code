import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.unmock('node:child_process');

import { PermissionMode } from '../../src/config/types.js';
import { PersistentStore } from '../../src/context/storage/PersistentStore.js';
import { resetProjectionDbCache } from '../../src/context/storage/sqlite/projection.js';
import { SessionService } from '../../src/services/SessionService.js';
import { runTuiTaskAttentionPtyDriver } from '../support/tuiTaskAttentionPtyDriver.js';

const roots: string[] = [];
const originalStorageRoot = process.env.BLADE_STORAGE_ROOT;
const cliEntry = path.resolve(import.meta.dirname, '../../dist/blade.js');
let productionCliReady: Promise<void> | undefined;

function ensureProductionCli(): Promise<void> {
  productionCliReady ??= buildProductionCliWhenMissing();
  return productionCliReady;
}

async function buildProductionCliWhenMissing(): Promise<void> {
  try {
    await access(cliEntry);
    return;
  } catch {
    // A clean checkout has no ignored dist; build once before the serial PTY cases.
  }
  const { spawn } = await import('node:child_process');
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['scripts/run-bun.js', 'run', 'scripts/build.ts'],
      {
        cwd: path.resolve(import.meta.dirname, '../..'),
        stdio: ['ignore', 'ignore', 'pipe'],
      }
    );
    let stderr = '';
    let deadlineExceeded = false;
    const timeout = setTimeout(() => {
      deadlineExceeded = true;
      child.kill('SIGKILL');
    }, 120_000);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-4_000);
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve();
        return;
      }
      const result = deadlineExceeded ? 'timed out' : `failed (${code ?? signal})`;
      reject(new Error(`Production CLI build ${result}: ${stderr}`));
    });
  });
  await access(cliEntry);
}

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
    it('marks a missed terminal transition NEW until the exact Session opens', async () => {
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
      await ensureProductionCli();
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
      await ensureProductionCli();
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
  }
);
