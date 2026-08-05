import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('nanoid', () => ({
  nanoid: vi.fn(() => '_unsafeid01'),
}));

describe('SessionRoutes generated session IDs', () => {
  let previousStorageRoot: string | undefined;
  let fixtureRoot: string;
  let storageRoot: string;
  let workspace: string;

  beforeEach(async () => {
    previousStorageRoot = process.env.BLADE_STORAGE_ROOT;
    fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'blade-session-id-'));
    storageRoot = path.join(fixtureRoot, 'storage');
    workspace = path.join(fixtureRoot, 'workspace');
    await Promise.all([
      mkdir(storageRoot, { recursive: true }),
      mkdir(workspace, { recursive: true }),
    ]);
    process.env.BLADE_STORAGE_ROOT = storageRoot;
  });

  afterEach(async () => {
    if (previousStorageRoot === undefined) {
      delete process.env.BLADE_STORAGE_ROOT;
    } else {
      process.env.BLADE_STORAGE_ROOT = previousStorageRoot;
    }
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  it('prefixes a generated Nano ID whose first character is a separator', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');

    const response = await SessionRoutes().request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectPath: workspace, title: 'Generated ID' }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      sessionId: 'web-_unsafeid01',
      projectPath: workspace,
      title: 'Generated ID',
    });
  });
});
