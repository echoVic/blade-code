import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_HOOK_CONFIG } from '../../../src/hooks/HookConfig.js';
import { HookManager } from '../../../src/hooks/HookManager.js';

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
});
