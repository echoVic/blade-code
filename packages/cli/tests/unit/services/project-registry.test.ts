import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectRegistry } from '../../../src/services/ProjectRegistry.js';

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'blade-project-registry-'));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe('ProjectRegistry', () => {
  it('binds, lists, deduplicates, and unbinds canonical project paths', async () => {
    const root = await temporaryRoot();
    const current = path.join(root, 'current');
    const other = path.join(root, 'other');
    const registryPath = path.join(root, 'storage', 'bound-projects.json');
    await Promise.all([
      mkdir(current, { recursive: true }),
      mkdir(other, { recursive: true }),
    ]);
    const registry = new ProjectRegistry(registryPath);
    const canonicalCurrent = await realpath(current);
    const canonicalOther = await realpath(other);

    const bound = await registry.bind(other, current);
    await registry.bind(other, current);
    expect(bound).toMatchObject({
      path: canonicalOther,
      name: 'other',
      available: true,
      isCurrent: false,
    });

    const projects = await registry.list(current);
    expect(projects).toHaveLength(2);
    expect(projects[0]).toMatchObject({
      path: canonicalCurrent,
      isCurrent: true,
    });
    expect(projects[1]).toMatchObject({
      path: canonicalOther,
      isCurrent: false,
    });

    expect(await registry.unbind(other)).toBe(true);
    expect(await registry.unbind(other)).toBe(false);
    expect(await registry.list(current)).toHaveLength(1);
    expect(JSON.parse(await readFile(registryPath, 'utf8'))).toMatchObject({
      version: 1,
      projects: [],
    });
  });

  it('rejects relative, missing, and non-directory project paths', async () => {
    const root = await temporaryRoot();
    const current = path.join(root, 'current');
    const file = path.join(root, 'file.txt');
    await mkdir(current);
    await writeFile(file, 'not a directory');
    const registry = new ProjectRegistry(path.join(root, 'registry.json'));

    await expect(registry.bind('relative', current)).rejects.toThrow(
      'must be absolute'
    );
    await expect(registry.bind(path.join(root, 'missing'), current)).rejects.toThrow();
    await expect(registry.bind(file, current)).rejects.toThrow('must be a directory');
  });

  it('fails open when the registry file is malformed', async () => {
    const root = await temporaryRoot();
    const current = path.join(root, 'current');
    const registryPath = path.join(root, 'registry.json');
    await mkdir(current);
    await writeFile(registryPath, '{invalid json');

    const projects = await new ProjectRegistry(registryPath).list(current);
    const canonicalCurrent = await realpath(current);
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({
      path: canonicalCurrent,
      isCurrent: true,
    });
  });
});
