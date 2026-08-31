import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAcpRemotePathProfile } from '../../../../src/acp/AcpRemotePath.js';
import {
  __getAcpRemoteStateGateCountForTesting,
  createAcpRemoteWorkspaceDescriptor,
  deriveAcpRemoteHostStateRoot,
  ensureAcpRemoteHostStateRoot,
  listValidatedAcpRemoteStateScopes,
  parseAcpRemoteWorkspaceDescriptor,
  withValidatedAcpRemoteStateScope,
} from '../../../../src/acp/AcpRemoteWorkspace.js';

describe('AcpRemoteWorkspace', () => {
  let storageRoot: string;
  let previousStorageRoot: string | undefined;

  beforeEach(async () => {
    previousStorageRoot = process.env.BLADE_STORAGE_ROOT;
    storageRoot = await mkdtemp(
      path.join(os.tmpdir(), 'blade-acp-remote-workspace-test-')
    );
    process.env.BLADE_STORAGE_ROOT = storageRoot;
  });

  afterEach(async () => {
    if (previousStorageRoot === undefined) {
      delete process.env.BLADE_STORAGE_ROOT;
    } else {
      process.env.BLADE_STORAGE_ROOT = previousStorageRoot;
    }
    await rm(storageRoot, { recursive: true, force: true });
  });

  it('creates and reparses a strict descriptor from the remote path profile', () => {
    const profile = createAcpRemotePathProfile('C:\\Repo\\ΟΣ.ts');

    const descriptor = createAcpRemoteWorkspaceDescriptor(profile);
    expect(descriptor).toEqual({
      version: 1,
      kind: 'acp-remote',
      style: 'win32',
      wirePath: 'C:\\Repo\\ΟΣ.ts',
      exactIdentity: profile.workspace.exactIdentity,
      collisionIdentity: profile.workspace.collisionIdentity,
    });

    expect(parseAcpRemoteWorkspaceDescriptor(descriptor)).toEqual(descriptor);
  });

  it('fails closed for corrupt or transplanted descriptors without exposing raw paths', () => {
    const descriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('C:\\Repo\\ΟΣ.ts')
    );

    const corruptCases: unknown[] = [
      null,
      { ...descriptor, version: 2 },
      { ...descriptor, kind: 'local' },
      { ...descriptor, style: 'posix' },
      { ...descriptor, exactIdentity: descriptor.collisionIdentity },
      {
        ...descriptor,
        collisionIdentity:
          'acp-remote-collision-path:0000000000000000000000000000000000000000000000000000000000000000',
      },
      {
        ...descriptor,
        wirePath: 'C:\\Other\\Leak.ts',
      },
    ];

    for (const value of corruptCases) {
      expect(() => parseAcpRemoteWorkspaceDescriptor(value)).toThrowError(
        /remote workspace/i
      );
      try {
        parseAcpRemoteWorkspaceDescriptor(value);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        expect(message).not.toContain('C:\\Repo\\ΟΣ.ts');
        expect(message).not.toContain('Leak.ts');
      }
    }
  });

  it('derives a fixed opaque host state root from collision identity only', () => {
    const repo = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('C:\\Repo')
    );
    const repoDifferentExact = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('c:\\repo')
    );
    const other = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('C:\\Other')
    );

    const repoRoot = deriveAcpRemoteHostStateRoot(repo.collisionIdentity);
    const sameBucketRoot = deriveAcpRemoteHostStateRoot(
      repoDifferentExact.collisionIdentity
    );
    const otherRoot = deriveAcpRemoteHostStateRoot(other.collisionIdentity);

    expect(repoRoot).toMatch(
      new RegExp(
        `^${storageRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/acp-remote-workspaces/[a-f0-9]{64}$`
      )
    );
    expect(repoRoot).toBe(sameBucketRoot);
    expect(repoRoot).not.toBe(otherRoot);
    expect(repoRoot).not.toContain('Repo');
    expect(repoRoot).not.toContain('repo');
    expect(repoRoot).not.toContain('\\');

    for (const invalidIdentity of [
      'acp-remote-collision-path:',
      'acp-remote-collision-path:not-hex',
      'acp-remote-collision-path:abc',
      `acp-remote-collision-path:${'g'.repeat(64)}`,
      `acp-remote-collision-path:${'a'.repeat(63)}`,
      `acp-remote-collision-path:${'a'.repeat(65)}`,
      `acp-remote-collision-path:${'A'.repeat(64)}`,
    ]) {
      expect(() =>
        deriveAcpRemoteHostStateRoot(
          invalidIdentity as `acp-remote-collision-path:${string}`
        )
      ).toThrow(/remote workspace/i);
    }
  });

  it('creates and validates a private non-symlink host state scope', async () => {
    const descriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('C:\\Repo')
    );
    const root = deriveAcpRemoteHostStateRoot(descriptor.collisionIdentity);

    await ensureAcpRemoteHostStateRoot(root);

    const namespaceStat = await lstat(path.dirname(root));
    const leafStat = await lstat(root);
    expect(namespaceStat.isSymbolicLink()).toBe(false);
    expect(leafStat.isSymbolicLink()).toBe(false);
    expect(leafStat.isDirectory()).toBe(true);

    if (process.platform !== 'win32') {
      expect(namespaceStat.mode & 0o777).toBe(0o700);
      expect(leafStat.mode & 0o777).toBe(0o700);
    }

    const marker = await withValidatedAcpRemoteStateScope(root, async (scope) => {
      expect(String(scope)).toBe(root);
      return 'ok';
    });
    expect(marker).toBe('ok');
  });

  it('rejects paths outside the protected namespace or using alias components', async () => {
    const descriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('C:\\Repo')
    );
    const root = deriveAcpRemoteHostStateRoot(descriptor.collisionIdentity);

    await expect(
      ensureAcpRemoteHostStateRoot(path.join(storageRoot, 'projects', 'oops'))
    ).rejects.toThrow(/remote workspace/i);
    await expect(
      withValidatedAcpRemoteStateScope(
        path.join(path.dirname(root), '..', path.basename(root)),
        async () => 'bad'
      )
    ).rejects.toThrow(/remote workspace/i);
    await expect(
      withValidatedAcpRemoteStateScope(`${root}${path.sep}child`, async () => 'bad')
    ).rejects.toThrow(/remote workspace/i);
  });

  it('rejects roots that are not already in canonical lexical form', async () => {
    const descriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('C:\\Repo')
    );
    const root = deriveAcpRemoteHostStateRoot(descriptor.collisionIdentity);
    await ensureAcpRemoteHostStateRoot(root);

    const parent = path.dirname(root);
    const digest = path.basename(root);

    await expect(
      withValidatedAcpRemoteStateScope(
        `${parent}/ignored/../${digest}`,
        async () => 'bad'
      )
    ).rejects.toThrow(/remote workspace/i);
    await expect(
      withValidatedAcpRemoteStateScope(`${parent}//${digest}`, async () => 'bad')
    ).rejects.toThrow(/remote workspace/i);
    await expect(
      withValidatedAcpRemoteStateScope(`${root}/`, async () => 'bad')
    ).rejects.toThrow(/remote workspace/i);
  });

  it('rejects symlinked namespace and symlinked leaf directories', async () => {
    const descriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('C:\\Repo')
    );
    const root = deriveAcpRemoteHostStateRoot(descriptor.collisionIdentity);
    const namespace = path.dirname(root);
    const digest = path.basename(root);

    await rm(namespace, { recursive: true, force: true });
    const targetNamespace = await mkdtemp(
      path.join(os.tmpdir(), 'blade-acp-remote-workspace-target-')
    );
    await symlink(targetNamespace, namespace);
    await expect(ensureAcpRemoteHostStateRoot(root)).rejects.toThrow(
      /remote workspace/i
    );
    await rm(namespace, { force: true });

    await mkdir(namespace, { recursive: true, mode: 0o700 });
    const targetLeaf = await mkdtemp(
      path.join(os.tmpdir(), 'blade-acp-remote-workspace-leaf-')
    );
    await symlink(targetLeaf, path.join(namespace, digest));
    await expect(
      withValidatedAcpRemoteStateScope(root, async () => 'bad')
    ).rejects.toThrow(/remote workspace/i);
    expect(await readlink(path.join(namespace, digest))).toBe(targetLeaf);
    await rm(path.join(namespace, digest), { force: true });
    await rm(targetNamespace, { recursive: true, force: true });
    await rm(targetLeaf, { recursive: true, force: true });
  });

  it('rejects wrong leaf mode after creation on POSIX hosts', async () => {
    if (process.platform === 'win32') {
      return;
    }

    const descriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('C:\\Repo')
    );
    const root = deriveAcpRemoteHostStateRoot(descriptor.collisionIdentity);
    await ensureAcpRemoteHostStateRoot(root);
    await chmod(root, 0o755);

    await expect(
      withValidatedAcpRemoteStateScope(root, async () => 'bad')
    ).rejects.toThrow(/remote workspace/i);
  });

  it('rejects a symlinked configured storage root before creating the namespace', async () => {
    const redirectedRoot = await mkdtemp(
      path.join(os.tmpdir(), 'blade-acp-remote-storage-target-')
    );
    const symlinkedStorageRoot = path.join(
      os.tmpdir(),
      `blade-acp-storage-link-${Date.now()}`
    );
    await symlink(redirectedRoot, symlinkedStorageRoot);
    process.env.BLADE_STORAGE_ROOT = symlinkedStorageRoot;

    const descriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('C:\\Repo')
    );
    const root = deriveAcpRemoteHostStateRoot(descriptor.collisionIdentity);

    await expect(ensureAcpRemoteHostStateRoot(root)).rejects.toThrow(
      /remote workspace/i
    );
    await expect(
      lstat(path.join(symlinkedStorageRoot, 'acp-remote-workspaces'))
    ).rejects.toThrow();
    await rm(symlinkedStorageRoot, { force: true });
    await rm(redirectedRoot, { recursive: true, force: true });
  });

  it('rejects a world-readable configured storage root on POSIX hosts', async () => {
    if (process.platform === 'win32') {
      return;
    }

    await chmod(storageRoot, 0o755);
    const descriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('C:\\Repo')
    );
    const root = deriveAcpRemoteHostStateRoot(descriptor.collisionIdentity);

    await expect(ensureAcpRemoteHostStateRoot(root)).rejects.toThrow(
      /remote workspace/i
    );
  });

  it('lists validated remote scopes only after validating the storage root and namespace', async () => {
    expect(await listValidatedAcpRemoteStateScopes()).toEqual([]);

    const remoteA = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('C:\\Repo')
    );
    const remoteB = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('D:\\Other')
    );
    const remoteRootA = deriveAcpRemoteHostStateRoot(remoteA.collisionIdentity);
    const remoteRootB = deriveAcpRemoteHostStateRoot(remoteB.collisionIdentity);
    await ensureAcpRemoteHostStateRoot(remoteRootA);
    await ensureAcpRemoteHostStateRoot(remoteRootB);

    const remoteNamespace = path.join(storageRoot, 'acp-remote-workspaces');
    await mkdir(path.join(remoteNamespace, 'not-a-digest'), { recursive: true });
    await mkdir(
      path.join(
        remoteNamespace,
        'abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcg'
      ),
      { recursive: true }
    );

    await expect(listValidatedAcpRemoteStateScopes()).resolves.toEqual(
      [remoteRootA, remoteRootB].sort()
    );
  });

  it('keeps using an explicit storage root when the environment storage root drifts later', async () => {
    const remote = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('C:\\Repo')
    );
    const remoteRoot = deriveAcpRemoteHostStateRoot(remote.collisionIdentity);
    await ensureAcpRemoteHostStateRoot(remoteRoot);

    const driftedStorageRoot = await mkdtemp(
      path.join(os.tmpdir(), 'blade-acp-remote-workspace-drift-')
    );
    process.env.BLADE_STORAGE_ROOT = driftedStorageRoot;

    await expect(listValidatedAcpRemoteStateScopes(storageRoot)).resolves.toEqual([
      remoteRoot,
    ]);
    await expect(listValidatedAcpRemoteStateScopes()).resolves.toEqual([]);

    await rm(driftedStorageRoot, { recursive: true, force: true });
  });

  it('rejects listing when a valid digest leaf is damaged instead of silently skipping it', async () => {
    const remoteA = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('C:\\Repo')
    );
    const remoteB = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('D:\\Other')
    );
    const remoteRootA = deriveAcpRemoteHostStateRoot(remoteA.collisionIdentity);
    const remoteRootB = deriveAcpRemoteHostStateRoot(remoteB.collisionIdentity);
    await ensureAcpRemoteHostStateRoot(remoteRootA);

    const namespace = path.dirname(remoteRootA);
    const damagedTarget = await mkdtemp(
      path.join(os.tmpdir(), 'blade-acp-remote-workspace-damaged-leaf-')
    );
    await symlink(damagedTarget, remoteRootB);

    await expect(listValidatedAcpRemoteStateScopes()).rejects.toThrow(
      /remote workspace/i
    );

    await rm(remoteRootB, { force: true });
    await rm(damagedTarget, { recursive: true, force: true });
    expect(namespace).toBe(path.join(storageRoot, 'acp-remote-workspaces'));
  });

  it('serializes ensure and validated gate entry for the same root and releases the gate afterward', async () => {
    const descriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('C:\\Repo')
    );
    const root = deriveAcpRemoteHostStateRoot(descriptor.collisionIdentity);
    const order: string[] = [];
    let releaseValidated: (() => void) | undefined;

    expect(__getAcpRemoteStateGateCountForTesting()).toBe(0);

    await ensureAcpRemoteHostStateRoot(root);

    const first = withValidatedAcpRemoteStateScope(root, async () => {
      order.push('validated-enter');
      await new Promise<void>((resolve) => {
        releaseValidated = () => resolve();
      });
      order.push('validated-exit');
    });

    const second = ensureAcpRemoteHostStateRoot(root).then(() => {
      order.push('ensure-after');
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toEqual(['validated-enter']);
    expect(__getAcpRemoteStateGateCountForTesting()).toBe(1);

    releaseValidated?.();
    await Promise.all([first, second]);

    await withValidatedAcpRemoteStateScope(root, async () => {
      order.push('validated-after');
      await writeFile(path.join(root, '.marker'), 'ok', 'utf8');
    });
    expect(order).toEqual([
      'validated-enter',
      'validated-exit',
      'ensure-after',
      'validated-after',
    ]);
    expect(__getAcpRemoteStateGateCountForTesting()).toBe(0);
  });

  it('fails fast on same-root reentry without poisoning the gate and still preserves external FIFO', async () => {
    const descriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('C:\\Repo')
    );
    const root = deriveAcpRemoteHostStateRoot(descriptor.collisionIdentity);
    await ensureAcpRemoteHostStateRoot(root);

    const order: string[] = [];
    let releaseOuter: (() => void) | undefined;

    const outer = withValidatedAcpRemoteStateScope(root, async () => {
      order.push('outer-enter');
      const reentryResult = await Promise.race([
        ensureAcpRemoteHostStateRoot(root).then(
          () => 'resolved',
          (error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            expect(message).toMatch(/remote workspace/i);
            expect(message).not.toContain(root);
            return 'rejected';
          }
        ),
        new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 50)),
      ]);

      expect(reentryResult).toBe('rejected');
      order.push('outer-reentry-rejected');
      expect(__getAcpRemoteStateGateCountForTesting()).toBe(1);

      await new Promise<void>((resolve) => {
        releaseOuter = resolve;
      });
      order.push('outer-exit');
    });

    const queued = ensureAcpRemoteHostStateRoot(root).then(() => {
      order.push('queued-after');
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toEqual(['outer-enter', 'outer-reentry-rejected']);
    expect(__getAcpRemoteStateGateCountForTesting()).toBe(1);

    releaseOuter?.();
    await Promise.all([outer, queued]);
    expect(order).toEqual([
      'outer-enter',
      'outer-reentry-rejected',
      'outer-exit',
      'queued-after',
    ]);
    expect(__getAcpRemoteStateGateCountForTesting()).toBe(0);

    await expect(ensureAcpRemoteHostStateRoot(root)).resolves.toBeUndefined();
    await expect(
      withValidatedAcpRemoteStateScope(root, async (scope) => {
        expect(String(scope)).toBe(root);
        return 'ok';
      })
    ).resolves.toBe('ok');
  });
});
