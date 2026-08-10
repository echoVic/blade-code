import { spawn } from 'node:child_process';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PermissionMode } from '../../../src/config/types.js';
import { DEFAULT_HOOK_CONFIG } from '../../../src/hooks/HookConfig.js';
import { HookExecutor } from '../../../src/hooks/HookExecutor.js';
import { HookTrustService } from '../../../src/hooks/HookTrustService.js';
import { SecureProcessExecutor } from '../../../src/hooks/SecureProcessExecutor.js';
import { HookEvent, HookType } from '../../../src/hooks/types/HookTypes.js';

describe('Session-scoped hook environment', () => {
  beforeAll(async () => {
    const childProcess =
      await vi.importActual<typeof import('node:child_process')>('node:child_process');
    vi.mocked(spawn).mockImplementation(childProcess.spawn);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('passes explicit Session values without copying arbitrary process secrets', async () => {
    vi.stubEnv('HOST_ONLY_SECRET', 'must-not-cross');
    const executor = new SecureProcessExecutor();
    const result = await executor.execute(
      `node -e 'process.stdout.write(JSON.stringify([process.env.SESSION_ONLY, process.env.HOST_ONLY_SECRET ?? "missing"]))'`,
      {
        hook_event_name: HookEvent.SessionStart,
        hook_execution_id: 'hook-env-test',
        timestamp: new Date(0).toISOString(),
        project_dir: process.cwd(),
        session_id: 'session-env-test',
        permission_mode: PermissionMode.DEFAULT,
        is_resume: false,
      },
      {
        projectDir: process.cwd(),
        sessionId: 'session-env-test',
        permissionMode: PermissionMode.DEFAULT,
        config: { ...DEFAULT_HOOK_CONFIG, enabled: true },
        environment: {
          SESSION_ONLY: 'session-value',
        },
      },
      5_000
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(['session-value', 'missing']);
  });

  it('adds attributable plugin roots only to the owning Hook process', async () => {
    const trust = vi
      .spyOn(HookTrustService.getInstance(), 'getStatus')
      .mockResolvedValue({ state: 'trusted' } as never);
    const executor = new HookExecutor();
    const result = await executor.executeUserPromptSubmitHooks(
      [
        {
          type: HookType.Command,
          command:
            `node -e 'process.stdout.write(JSON.stringify([` +
            'process.env.BLADE_PLUGIN_NAME, process.env.BLADE_PLUGIN_ROOT, ' +
            `process.env.CLAUDE_PLUGIN_ROOT, process.env.SESSION_ONLY]))'`,
          source: {
            kind: 'plugin',
            pluginName: 'plugin-env',
            pluginSource: 'project',
            pluginRoot: '/workspace/plugin-env',
          },
        },
      ],
      {
        hook_event_name: HookEvent.UserPromptSubmit,
        hook_execution_id: 'plugin-hook-env',
        timestamp: new Date(0).toISOString(),
        project_dir: process.cwd(),
        session_id: 'plugin-hook-env',
        permission_mode: PermissionMode.DEFAULT,
        user_prompt: 'probe',
        has_images: false,
        image_count: 0,
      },
      {
        projectDir: process.cwd(),
        sessionId: 'plugin-hook-env',
        permissionMode: PermissionMode.DEFAULT,
        config: { ...DEFAULT_HOOK_CONFIG, enabled: true },
        environment: { SESSION_ONLY: 'session-value' },
      }
    );

    expect(JSON.parse(result.contextInjection ?? '[]')).toEqual([
      'plugin-env',
      '/workspace/plugin-env',
      '/workspace/plugin-env',
      'session-value',
    ]);
    trust.mockRestore();
  });
});
