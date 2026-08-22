import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  invalidateWorkspaceIdentityCache,
  MAX_CACHED_WORKSPACE_IDENTITIES,
  resetWorkspaceIdentityCache,
  resolveWorkspaceIdentity,
} from '../../../src/security/WorkspaceIdentity.js';

const roots: string[] = [];

afterEach(async () => {
  resetWorkspaceIdentityCache();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe('WorkspaceIdentity cache', () => {
  it('evicts the least recently used canonical workspace', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'blade-workspace-identity-'));
    roots.push(root);

    const projects = Array.from(
      { length: MAX_CACHED_WORKSPACE_IDENTITIES + 1 },
      (_, index) => path.join(root, `project-${index}`)
    );
    await Promise.all(projects.map((project) => mkdir(project)));

    const cached = [];
    for (const project of projects.slice(0, MAX_CACHED_WORKSPACE_IDENTITIES)) {
      cached.push(await resolveWorkspaceIdentity(project));
    }
    expect(await resolveWorkspaceIdentity(projects[0])).toBe(cached[0]);

    await resolveWorkspaceIdentity(projects[MAX_CACHED_WORKSPACE_IDENTITIES]);

    expect(await resolveWorkspaceIdentity(projects[0])).toBe(cached[0]);
    expect(await resolveWorkspaceIdentity(projects[1])).not.toBe(cached[1]);
  });

  it('shares and invalidates one canonical entry across path aliases', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'blade-workspace-alias-'));
    roots.push(root);
    const project = path.join(root, 'project');
    const alias = path.join(root, 'project-alias');
    await mkdir(project);
    await symlink(project, alias, 'dir');

    const canonicalIdentity = await resolveWorkspaceIdentity(project);
    expect(await resolveWorkspaceIdentity(alias)).toBe(canonicalIdentity);

    await invalidateWorkspaceIdentityCache(alias);

    const reloaded = await resolveWorkspaceIdentity(project);
    expect(reloaded).not.toBe(canonicalIdentity);
    expect(reloaded).toEqual(canonicalIdentity);
  });

  it('rejects relative invalidation paths before filesystem access', async () => {
    await expect(invalidateWorkspaceIdentityCache('relative')).rejects.toThrow(
      'Workspace path must be absolute'
    );
  });
});
