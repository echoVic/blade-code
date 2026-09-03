import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAcpRemotePathProfile } from '../../../../src/acp/AcpRemotePath.js';
import { deriveAcpRemoteHostStateRoot } from '../../../../src/acp/AcpRemoteWorkspace.js';
import { BladeServerError } from '../../../../src/server/error.js';
import {
  isLocalDirectoryPickerOrigin,
  ProjectRoutes,
} from '../../../../src/server/routes/projects.js';
import { projectRegistry } from '../../../../src/services/ProjectRegistry.js';

describe('ProjectRoutes folder picker', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('accepts local browser and desktop origins only', () => {
    expect(isLocalDirectoryPickerOrigin('http://localhost:5174')).toBe(true);
    expect(isLocalDirectoryPickerOrigin('http://127.0.0.1:4097')).toBe(true);
    expect(isLocalDirectoryPickerOrigin('http://[::1]:4097')).toBe(true);
    expect(isLocalDirectoryPickerOrigin('tauri://localhost')).toBe(true);
    expect(isLocalDirectoryPickerOrigin('https://blade.example.com')).toBe(false);
    expect(isLocalDirectoryPickerOrigin(undefined)).toBe(false);
    expect(isLocalDirectoryPickerOrigin('not a URL')).toBe(false);
  });

  it('returns a selected folder without binding it inside the picker route', async () => {
    const pickDirectory = vi.fn(async () => ({
      cancelled: false as const,
      path: '/tmp/project',
    }));
    const app = ProjectRoutes({ pickDirectory });

    const response = await app.request('/pick', {
      method: 'POST',
      headers: { Origin: 'http://localhost:5174' },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      cancelled: false,
      path: '/tmp/project',
    });
    expect(pickDirectory).toHaveBeenCalledOnce();
  });

  it('does not invoke the native picker for a remote origin', async () => {
    const pickDirectory = vi.fn(async () => ({ cancelled: true as const }));
    const app = ProjectRoutes({ pickDirectory });
    app.onError((error, context) => {
      const status =
        'statusCode' in error && typeof error.statusCode === 'number'
          ? error.statusCode
          : 500;
      return context.json({ error: error.message }, status as 403 | 500);
    });

    const response = await app.request('/pick', {
      method: 'POST',
      headers: { Origin: 'https://blade.example.com' },
    });

    expect(response.status).toBe(403);
    expect(pickDirectory).not.toHaveBeenCalled();
  });

  it('rejects a protected remote state root before binding it as a project', async () => {
    const storageRoot = path.join(os.tmpdir(), 'blade-project-route-storage');
    vi.stubEnv('BLADE_STORAGE_ROOT', storageRoot);
    const descriptor = createAcpRemotePathProfile('/remote/project-binding');
    const protectedRoot = deriveAcpRemoteHostStateRoot(
      descriptor.workspace.collisionIdentity
    );
    const bind = vi.spyOn(projectRegistry, 'bind').mockResolvedValue({
      path: protectedRoot,
      name: 'remote',
      available: true,
      isCurrent: false,
      boundAt: '2026-09-02T00:00:00.000Z',
    });
    const app = ProjectRoutes();
    app.onError((error, context) =>
      error instanceof BladeServerError
        ? context.json(error.toObject(), error.statusCode as 400)
        : context.json({ error: String(error) }, 500)
    );

    const response = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: protectedRoot }),
    });

    expect(response.status).toBe(400);
    expect(bind).not.toHaveBeenCalled();
  });

  it('rejects a protected remote state root before unbinding a project', async () => {
    const storageRoot = path.join(os.tmpdir(), 'blade-project-route-storage');
    vi.stubEnv('BLADE_STORAGE_ROOT', storageRoot);
    const descriptor = createAcpRemotePathProfile('/remote/project-unbinding');
    const protectedRoot = deriveAcpRemoteHostStateRoot(
      descriptor.workspace.collisionIdentity
    );
    const unbind = vi.spyOn(projectRegistry, 'unbind').mockResolvedValue(true);
    const app = ProjectRoutes();
    app.onError((error, context) =>
      error instanceof BladeServerError
        ? context.json(error.toObject(), error.statusCode as 400)
        : context.json({ error: String(error) }, 500)
    );

    const response = await app.request(`/?path=${encodeURIComponent(protectedRoot)}`, {
      method: 'DELETE',
    });

    expect(response.status).toBe(400);
    expect(unbind).not.toHaveBeenCalled();
  });
});
