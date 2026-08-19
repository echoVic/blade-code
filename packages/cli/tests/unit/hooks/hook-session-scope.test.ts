import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_HOOK_CONFIG } from '../../../src/hooks/HookConfig.js';
import {
  HookManager,
  MAX_RESIDENT_HOOK_PROJECT_CONFIGS,
} from '../../../src/hooks/HookManager.js';

describe('HookManager session scope', () => {
  afterEach(() => {
    HookManager.resetInstance();
  });

  it('shares state across project and worktree aliases without affecting peers', async () => {
    const manager = HookManager.getInstance();
    const projectDir = '/workspace/project';
    const worktreeDir = '/workspace/worktrees/session-1';
    const config = { ...DEFAULT_HOOK_CONFIG, enabled: true };

    manager.loadConfig(config, projectDir);
    manager.bindSessionConfig('session-1', [projectDir, worktreeDir], config);
    manager.bindSessionConfig('session-2', [projectDir], config);

    manager.disableSession('session-1', projectDir);

    expect(manager.isSessionEnabled('session-1', projectDir)).toBe(false);
    expect(manager.isSessionEnabled('session-1', worktreeDir)).toBe(false);
    expect(manager.isSessionEnabled('session-2', projectDir)).toBe(true);

    manager.enableSession('session-1', worktreeDir);

    expect(manager.isSessionEnabled('session-1', projectDir)).toBe(true);
    expect(manager.isSessionEnabled('session-1', worktreeDir)).toBe(true);

    manager.disableSession('session-1', projectDir);
    await manager.unbindSessionModelResources('session-1', [projectDir, worktreeDir]);
    expect(manager.isSessionPaused('session-1', projectDir)).toBe(false);
  });

  it('preserves a pre-initialization pause when runtime aliases are bound', () => {
    const manager = HookManager.getInstance();
    const projectDir = '/workspace/project';
    const worktreeDir = '/workspace/worktrees/session-1';
    const config = { ...DEFAULT_HOOK_CONFIG, enabled: true };

    manager.disableSession('session-1', worktreeDir);
    manager.bindSessionConfig('session-1', [projectDir, worktreeDir], config);

    expect(manager.isSessionPaused('session-1', projectDir)).toBe(true);
    expect(manager.isSessionEnabled('session-1', projectDir)).toBe(false);
    expect(manager.isSessionEnabled('session-1', worktreeDir)).toBe(false);
  });

  it('bounds project configs while preserving an active Session snapshot', async () => {
    const manager = HookManager.getInstance();
    const projectDir = '/workspace/project-0';
    const config = { ...DEFAULT_HOOK_CONFIG, enabled: true };
    manager.loadConfig(config, projectDir);
    manager.bindSessionConfig('session-1', [projectDir], config);

    for (let index = 1; index <= MAX_RESIDENT_HOOK_PROJECT_CONFIGS; index++) {
      manager.loadConfig(config, `/workspace/project-${index}`);
    }

    expect(manager.getResidencyStats()).toEqual({
      projectCapacity: MAX_RESIDENT_HOOK_PROJECT_CONFIGS,
      projectConfigs: MAX_RESIDENT_HOOK_PROJECT_CONFIGS,
      sessionConfigs: 1,
      sessionAliases: 1,
    });
    expect(manager.getConfig(projectDir).enabled).toBe(false);
    expect(manager.isSessionEnabled('session-1', projectDir)).toBe(true);

    await manager.unbindSessionModelResources('session-1', [projectDir]);
    expect(manager.getResidencyStats()).toMatchObject({
      sessionConfigs: 0,
      sessionAliases: 0,
    });
  });

  it('snapshots dynamic worktrees and removes every alias by Session ID', async () => {
    const manager = HookManager.getInstance();
    const projectDir = '/workspace/project';
    const worktreeDir = '/workspace/worktrees/transient';
    const config = { ...DEFAULT_HOOK_CONFIG, enabled: true };
    manager.loadConfig(config, projectDir);
    manager.bindSessionConfig('session-1', [projectDir], config);
    manager.inheritProjectConfig(projectDir, worktreeDir, 'session-1');

    for (let index = 0; index < MAX_RESIDENT_HOOK_PROJECT_CONFIGS; index++) {
      manager.loadConfig(config, `/workspace/noise-${index}`);
    }

    expect(manager.getConfig(worktreeDir).enabled).toBe(false);
    expect(manager.isSessionEnabled('session-1', worktreeDir)).toBe(true);
    manager.disableSession('session-1', projectDir);
    expect(manager.isSessionPaused('session-1', worktreeDir)).toBe(true);

    await manager.unbindSessionModelResources('session-1', [projectDir]);
    expect(manager.getResidencyStats()).toMatchObject({
      sessionConfigs: 0,
      sessionAliases: 0,
    });
    expect(manager.isSessionPaused('session-1', worktreeDir)).toBe(false);
  });

  it('returns the singleton to a clean reusable state', () => {
    const manager = HookManager.getInstance();
    manager.loadConfig({ ...DEFAULT_HOOK_CONFIG, enabled: true });
    manager.loadConfig({ ...DEFAULT_HOOK_CONFIG, enabled: true }, '/workspace/project');
    manager.disable();

    manager.cleanup();
    expect(manager.getResidencyStats()).toEqual({
      projectCapacity: MAX_RESIDENT_HOOK_PROJECT_CONFIGS,
      projectConfigs: 0,
      sessionConfigs: 0,
      sessionAliases: 0,
    });
    expect(manager.getConfig().enabled).toBe(false);

    manager.loadConfig({ ...DEFAULT_HOOK_CONFIG, enabled: true });
    expect(manager.isEnabled()).toBe(true);
  });
});
