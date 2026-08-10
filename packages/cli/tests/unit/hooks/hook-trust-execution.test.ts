import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PermissionMode } from '../../../src/config/types.js';
import { HookManager } from '../../../src/hooks/HookManager.js';
import { HookTrustService } from '../../../src/hooks/HookTrustService.js';
import {
  DecisionBehavior,
  HookEvent,
  HookType,
} from '../../../src/hooks/types/HookTypes.js';

vi.unmock('node:child_process');

function markerCommand(marker: string): string {
  const script = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`;
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
}

describe('configured hook trust enforcement', () => {
  let root = '';
  let project = '';
  let previousStorageRoot: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'blade-hook-execution-'));
    project = path.join(root, 'project');
    await mkdir(project, { recursive: true });
    previousStorageRoot = process.env.BLADE_STORAGE_ROOT;
    process.env.BLADE_STORAGE_ROOT = path.join(root, 'storage');
    HookManager.resetInstance();
    HookTrustService.resetInstance();
  });

  afterEach(async () => {
    HookManager.resetInstance();
    HookTrustService.resetInstance();
    if (previousStorageRoot === undefined) {
      delete process.env.BLADE_STORAGE_ROOT;
    } else {
      process.env.BLADE_STORAGE_ROOT = previousStorageRoot;
    }
    await rm(root, { recursive: true, force: true });
  });

  it('skips untrusted commands, runs trusted commands, and revokes on change', async () => {
    const marker = path.join(root, 'trusted-marker');
    const changedMarker = path.join(root, 'changed-marker');
    const manager = HookManager.getInstance();
    manager.loadConfig(
      {
        enabled: true,
        PreToolUse: [
          {
            matcher: { tools: 'Bash' },
            hooks: [{ type: HookType.Command, command: markerCommand(marker) }],
          },
        ],
      },
      project
    );
    const context = {
      projectDir: project,
      sessionId: 'trust-session',
      permissionMode: PermissionMode.YOLO,
    };

    await manager.executePreToolHooks('Bash', 'untrusted', {}, context);
    await expect(access(marker)).rejects.toThrow();
    expect((await manager.getTrustStatus(project)).state).toBe('untrusted');

    await manager.trustProject(project);
    await manager.executePreToolHooks('Bash', 'trusted', {}, context);
    await expect(access(marker)).resolves.toBeUndefined();

    manager.loadConfig(
      {
        enabled: true,
        PreToolUse: [
          {
            matcher: { tools: 'Bash' },
            hooks: [
              {
                type: HookType.Command,
                command: markerCommand(changedMarker),
              },
            ],
          },
        ],
      },
      project
    );
    expect((await manager.getTrustStatus(project)).state).toBe('modified');
    await manager.executePreToolHooks('Bash', 'modified', {}, context);
    await expect(access(changedMarker)).rejects.toThrow();
  });

  it('allows application Function hooks without project trust', async () => {
    const manager = HookManager.getInstance();
    manager.loadConfig({ enabled: true }, project);
    const handler = vi.fn(async () => ({
      decision: { behavior: DecisionBehavior.Block },
      systemMessage: 'blocked by application policy',
    }));
    const off = manager.registerFunction(
      HookEvent.PreToolUse,
      { tools: 'Edit' },
      handler,
      { projectDir: project }
    );

    const result = await manager.executePreToolHooks(
      'Edit',
      'function-hook',
      {},
      {
        projectDir: project,
        sessionId: 'function-session',
        permissionMode: PermissionMode.DEFAULT,
      }
    );

    expect(handler).toHaveBeenCalledOnce();
    expect(result.decision).toBe('deny');
    off();
  });

  it('keeps managed Function hooks active across isolated project configs', async () => {
    const secondProject = path.join(root, 'second-project');
    await mkdir(secondProject, { recursive: true });
    const manager = HookManager.getInstance();
    manager.loadConfig({ enabled: true }, project);
    manager.loadConfig({ enabled: true }, secondProject);
    const handler = vi.fn(async () => undefined);
    const off = manager.registerFunction(
      HookEvent.PreToolUse,
      { tools: 'Read' },
      handler
    );

    for (const [index, projectDir] of [project, secondProject].entries()) {
      await manager.executePreToolHooks(
        'Read',
        `managed-${index}`,
        {},
        {
          projectDir,
          sessionId: `managed-${index}`,
          permissionMode: PermissionMode.DEFAULT,
        }
      );
    }

    expect(handler).toHaveBeenCalledTimes(2);
    off();
  });

  it('does not inherit hooks from the most recently loaded project', async () => {
    const unknownProject = path.join(root, 'unknown-project');
    await mkdir(unknownProject, { recursive: true });
    const manager = HookManager.getInstance();
    manager.loadConfig({ enabled: true }, project);

    expect(manager.isEnabled(project)).toBe(true);
    expect(manager.isEnabled(unknownProject)).toBe(false);
    expect(manager.getConfig(unknownProject).enabled).toBe(false);
  });
});
