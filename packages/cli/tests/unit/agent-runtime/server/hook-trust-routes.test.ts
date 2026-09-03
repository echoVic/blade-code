import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAcpRemotePathProfile } from '../../../../src/acp/AcpRemotePath.js';
import { deriveAcpRemoteHostStateRoot } from '../../../../src/acp/AcpRemoteWorkspace.js';
import { ConfigManager } from '../../../../src/config/ConfigManager.js';
import { HookManager } from '../../../../src/hooks/HookManager.js';
import { HookTrustService } from '../../../../src/hooks/HookTrustService.js';
import { BladeServerError } from '../../../../src/server/error.js';
import { HookRoutes } from '../../../../src/server/routes/hooks.js';

vi.unmock('node:child_process');

describe('Hook trust routes', () => {
  let root = '';
  let project = '';
  let previousStorageRoot: string | undefined;
  let app: Hono;

  const writeHook = async (command: string) => {
    const bladeDir = path.join(project, '.blade');
    await mkdir(bladeDir, { recursive: true });
    await writeFile(
      path.join(bladeDir, 'settings.json'),
      `${JSON.stringify(
        {
          hooks: {
            enabled: true,
            PreToolUse: [
              {
                name: 'route-hook',
                matcher: { tools: 'Bash' },
                hooks: [{ type: 'command', command }],
              },
            ],
          },
        },
        null,
        2
      )}\n`
    );
  };

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'blade-hook-routes-'));
    project = path.join(root, 'project');
    await mkdir(project, { recursive: true });
    await writeHook('printf first');
    previousStorageRoot = process.env.BLADE_STORAGE_ROOT;
    process.env.BLADE_STORAGE_ROOT = path.join(root, 'storage');
    ConfigManager.resetInstance();
    HookManager.resetInstance();
    HookTrustService.resetInstance();
    app = new Hono();
    app.onError((error, context) => {
      if (error instanceof BladeServerError) {
        return context.json(error.toObject(), error.statusCode as 409);
      }
      return context.json({ error: { message: error.message } }, 500);
    });
    app.route('/hooks', HookRoutes());
  });

  afterEach(async () => {
    ConfigManager.resetInstance();
    HookManager.resetInstance();
    HookTrustService.resetInstance();
    if (previousStorageRoot === undefined) {
      delete process.env.BLADE_STORAGE_ROOT;
    } else {
      process.env.BLADE_STORAGE_ROOT = previousStorageRoot;
    }
    await rm(root, { recursive: true, force: true });
  });

  it('reviews, trusts, invalidates, and revokes an exact digest', async () => {
    const query = `/hooks/trust?projectPath=${encodeURIComponent(project)}`;
    const initialResponse = await app.request(query);
    const initial = await initialResponse.json();
    expect(initialResponse.status).toBe(200);
    expect(initial).toMatchObject({
      state: 'untrusted',
      configuredHooks: 1,
      currentDigest: expect.stringMatching(/^sha256:/),
      definitions: expect.arrayContaining([
        expect.objectContaining({
          event: 'PreToolUse',
          type: 'command',
          target: 'printf first',
        }),
      ]),
    });

    const trustedResponse = await app.request('/hooks/trust', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectPath: project,
        action: 'trust',
        expectedDigest: initial.currentDigest,
      }),
    });
    expect(await trustedResponse.json()).toMatchObject({ state: 'trusted' });

    await writeHook('printf changed');
    const modified = await (await app.request(query)).json();
    expect(modified).toMatchObject({
      state: 'modified',
      definitions: expect.arrayContaining([
        expect.objectContaining({ target: 'printf changed' }),
      ]),
    });

    const revoked = await app.request('/hooks/trust', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectPath: project,
        action: 'revoke',
      }),
    });
    expect(await revoked.json()).toMatchObject({ state: 'untrusted' });
  });

  it('rejects a stale reviewed digest', async () => {
    const initial = await (
      await app.request(`/hooks/trust?projectPath=${encodeURIComponent(project)}`)
    ).json();
    await writeHook('printf replaced');

    const response = await app.request('/hooks/trust', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectPath: project,
        action: 'trust',
        expectedDigest: initial.currentDigest,
      }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { message: expect.stringContaining('changed after review') },
    });
    expect(await HookManager.getInstance().getTrustStatus(project)).toMatchObject({
      state: 'untrusted',
    });
  });

  it('toggles hook execution for one session without changing project config', async () => {
    const sessionId = 'web-session-1';
    const query =
      `/hooks/session?projectPath=${encodeURIComponent(project)}` +
      `&sessionId=${sessionId}`;
    const initial = await app.request(query);
    expect(initial.status).toBe(200);
    await expect(initial.json()).resolves.toMatchObject({
      sessionId,
      projectPath: project,
      enabled: true,
      paused: false,
      configEnabled: true,
    });

    const disabled = await app.request('/hooks/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectPath: project,
        sessionId,
        enabled: false,
      }),
    });
    await expect(disabled.json()).resolves.toMatchObject({
      enabled: false,
      paused: true,
      configEnabled: true,
    });
    expect(HookManager.getInstance().getConfig(project).enabled).toBe(true);

    const otherSession = await app.request(
      `/hooks/session?projectPath=${encodeURIComponent(project)}` +
        '&sessionId=web-session-2'
    );
    await expect(otherSession.json()).resolves.toMatchObject({
      enabled: true,
      paused: false,
    });
  });

  it('rejects invalid session identities before mutating hook state', async () => {
    const getResponse = await app.request(
      `/hooks/session?projectPath=${encodeURIComponent(project)}&sessionId=..`
    );
    expect(getResponse.status).toBe(400);
    await expect(getResponse.json()).resolves.toMatchObject({
      error: { message: expect.stringContaining('Invalid session ID') },
    });

    const postResponse = await app.request('/hooks/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectPath: project,
        sessionId: '../escape',
        enabled: false,
      }),
    });
    expect(postResponse.status).toBe(400);
    expect(HookManager.getInstance().isSessionPaused('../escape', project)).toBe(false);
  });

  it('rejects a protected remote state root before loading hook resources', async () => {
    const descriptor = createAcpRemotePathProfile('/remote/hooks');
    const protectedRoot = deriveAcpRemoteHostStateRoot(
      descriptor.workspace.collisionIdentity
    );
    const load = vi.spyOn(ConfigManager.getInstance(), 'loadWorkspaceHooks');

    const response = await app.request(
      `/hooks/trust?projectPath=${encodeURIComponent(protectedRoot)}`
    );

    expect(response.status).toBe(400);
    expect(load).not.toHaveBeenCalled();
  });
});
