import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAcpRemotePathProfile } from '../../../../src/acp/AcpRemotePath.js';
import { deriveAcpRemoteHostStateRoot } from '../../../../src/acp/AcpRemoteWorkspace.js';
import { resetWorkspaceIdentityCache } from '../../../../src/security/WorkspaceIdentity.js';
import { WorkspaceTrustService } from '../../../../src/security/WorkspaceTrustService.js';
import { BladeServerError } from '../../../../src/server/error.js';
import { WorkspaceTrustRoutes } from '../../../../src/server/routes/workspaceTrust.js';

vi.mock('../../../../src/security/reloadWorkspaceTrust.js', () => ({
  reloadWorkspaceTrustConfiguration: vi.fn(async () => undefined),
}));

describe('Workspace trust routes', () => {
  let root = '';
  let project = '';
  let storeDir = '';
  let app: Hono;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'blade-workspace-route-'));
    project = path.join(root, 'project');
    storeDir = path.join(root, 'trust');
    await mkdir(path.join(project, '.blade'), { recursive: true });
    await writeFile(
      path.join(project, '.blade', 'config.json'),
      JSON.stringify({
        mcpServers: {
          project: {
            type: 'stdio',
            command: 'node',
            args: ['server.js'],
          },
        },
      })
    );
    WorkspaceTrustService.resetInstance();
    resetWorkspaceIdentityCache();
    const service = new WorkspaceTrustService(storeDir);
    vi.spyOn(WorkspaceTrustService, 'getInstance').mockReturnValue(service);
    app = new Hono();
    app.onError((error, context) => {
      if (error instanceof BladeServerError) {
        return context.json(error.toObject(), error.statusCode as 400 | 500);
      }
      return context.json({ error: { message: error.message } }, 500);
    });
    app.route('/workspace-trust', WorkspaceTrustRoutes());
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    WorkspaceTrustService.resetInstance();
    resetWorkspaceIdentityCache();
    await rm(root, { recursive: true, force: true });
  });

  it('reviews, trusts, and revokes the exact project', async () => {
    const endpoint = `/workspace-trust?projectPath=${encodeURIComponent(project)}`;
    const initial = await (await app.request(endpoint)).json();
    expect(initial).toMatchObject({
      state: 'untrusted',
      sources: [
        expect.objectContaining({
          path: '.blade/config.json',
          effects: [
            expect.objectContaining({
              kind: 'mcp',
              target: 'node server.js',
            }),
          ],
        }),
      ],
    });

    const trusted = await app.request('/workspace-trust', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectPath: project, action: 'trust' }),
    });
    expect(await trusted.json()).toMatchObject({
      state: 'trusted',
      reloadRequired: true,
    });

    const revoked = await app.request('/workspace-trust', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectPath: project, action: 'revoke' }),
    });
    expect(await revoked.json()).toMatchObject({
      state: 'untrusted',
      decision: 'untrusted',
      reloadRequired: true,
    });
  });

  it('rejects relative project paths before filesystem access', async () => {
    const response = await app.request('/workspace-trust?projectPath=relative');
    expect(response.status).toBe(400);
  });

  it('rejects a protected remote state root before reading trust state', async () => {
    vi.stubEnv('BLADE_STORAGE_ROOT', path.join(root, 'storage'));
    const descriptor = createAcpRemotePathProfile('/remote/trust');
    const protectedRoot = deriveAcpRemoteHostStateRoot(
      descriptor.workspace.collisionIdentity
    );
    const status = vi.spyOn(WorkspaceTrustService.getInstance(), 'getStatus');

    const response = await app.request(
      `/workspace-trust?projectPath=${encodeURIComponent(protectedRoot)}`
    );

    expect(response.status).toBe(400);
    expect(status).not.toHaveBeenCalled();
  });
});
