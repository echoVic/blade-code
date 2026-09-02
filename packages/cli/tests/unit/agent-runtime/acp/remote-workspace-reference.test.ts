import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAcpRemotePathProfile } from '../../../../src/acp/AcpRemotePath.js';
import {
  createAcpRemoteWorkspaceDescriptor,
  deriveAcpRemoteHostStateRoot,
  ensureAcpRemoteHostStateRoot,
  withValidatedAcpRemoteStateScope,
} from '../../../../src/acp/AcpRemoteWorkspace.js';

async function loadReferenceModule() {
  return import('../../../../src/acp/AcpRemoteWorkspaceReference.js');
}

describe('AcpRemoteWorkspaceReference', () => {
  let storageRoot: string;
  let previousStorageRoot: string | undefined;

  beforeEach(async () => {
    previousStorageRoot = process.env.BLADE_STORAGE_ROOT;
    storageRoot = await mkdtemp(
      path.join(os.tmpdir(), 'blade-acp-remote-workspace-reference-test-')
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

  it('creates a stable random public ref sidecar with private storage bindings', async () => {
    const {
      getAcpRemoteWorkspaceReferenceDirectoryPath,
      getAcpRemoteWorkspaceReferenceFilePath,
      getOrCreateAcpRemoteWorkspaceReference,
      readAcpRemoteWorkspaceReference,
    } = await loadReferenceModule();
    const descriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('C:\\Repo\\Surface.ts')
    );
    const hostStateRoot = deriveAcpRemoteHostStateRoot(descriptor.collisionIdentity);
    await ensureAcpRemoteHostStateRoot(hostStateRoot);

    const firstRef = await getOrCreateAcpRemoteWorkspaceReference(
      hostStateRoot,
      descriptor
    );
    const secondRef = await getOrCreateAcpRemoteWorkspaceReference(
      hostStateRoot,
      descriptor
    );
    const readBack = await readAcpRemoteWorkspaceReference(hostStateRoot, descriptor);

    expect(firstRef).toMatch(/^acp-remote-workspace:[A-Za-z0-9_-]{43}$/);
    expect(secondRef).toBe(firstRef);
    expect(readBack).toBe(firstRef);
    expect(firstRef).not.toContain('Repo');
    expect(firstRef).not.toContain(descriptor.exactIdentity);
    expect(firstRef).not.toContain(descriptor.collisionIdentity);

    await withValidatedAcpRemoteStateScope(hostStateRoot, async (scope) => {
      const sidecarDir = getAcpRemoteWorkspaceReferenceDirectoryPath(scope);
      const sidecarPath = getAcpRemoteWorkspaceReferenceFilePath(scope, descriptor);
      const dirStat = await lstat(sidecarDir);
      const fileStat = await lstat(sidecarPath);
      const payload = JSON.parse(await readFile(sidecarPath, 'utf8')) as {
        exactIdentityDigest: string;
        version: number;
        workspaceRef: string;
      };

      expect(path.basename(sidecarDir)).toBe('surface-workspaces-v1');
      expect(path.basename(sidecarPath)).toMatch(/^[a-f0-9]{64}\.json$/);
      expect(path.basename(sidecarPath)).not.toContain(descriptor.exactIdentity);
      expect(Object.keys(payload).sort()).toEqual([
        'exactIdentityDigest',
        'version',
        'workspaceRef',
      ]);
      expect(payload).toEqual({
        version: 1,
        exactIdentityDigest: path.basename(sidecarPath, '.json'),
        workspaceRef: firstRef,
      });
      expect(dirStat.isSymbolicLink()).toBe(false);
      expect(fileStat.isSymbolicLink()).toBe(false);
      expect(fileStat.isFile()).toBe(true);
      if (process.platform !== 'win32') {
        expect(dirStat.mode & 0o777).toBe(0o700);
        expect(fileStat.mode & 0o777).toBe(0o600);
      }
    });
  });

  it('converges concurrent creators onto one stable sidecar winner', async () => {
    const { getOrCreateAcpRemoteWorkspaceReference } = await loadReferenceModule();
    const descriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('C:\\Repo\\Concurrent.ts')
    );
    const hostStateRoot = deriveAcpRemoteHostStateRoot(descriptor.collisionIdentity);
    await ensureAcpRemoteHostStateRoot(hostStateRoot);

    const refs = await Promise.all([
      getOrCreateAcpRemoteWorkspaceReference(hostStateRoot, descriptor),
      getOrCreateAcpRemoteWorkspaceReference(hostStateRoot, descriptor),
      getOrCreateAcpRemoteWorkspaceReference(hostStateRoot, descriptor),
    ]);

    expect(new Set(refs)).toEqual(new Set([refs[0]]));
  });

  it('keeps exact identities distinct inside the same collision scope', async () => {
    const {
      getAcpRemoteWorkspaceReferenceDirectoryPath,
      getOrCreateAcpRemoteWorkspaceReference,
    } = await loadReferenceModule();
    const firstDescriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('C:\\Repo\\Surface.ts')
    );
    const secondDescriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('c:\\repo\\surface.ts')
    );
    const hostStateRoot = deriveAcpRemoteHostStateRoot(
      firstDescriptor.collisionIdentity
    );
    expect(hostStateRoot).toBe(
      deriveAcpRemoteHostStateRoot(secondDescriptor.collisionIdentity)
    );
    await ensureAcpRemoteHostStateRoot(hostStateRoot);

    const firstRef = await getOrCreateAcpRemoteWorkspaceReference(
      hostStateRoot,
      firstDescriptor
    );
    const secondRef = await getOrCreateAcpRemoteWorkspaceReference(
      hostStateRoot,
      secondDescriptor
    );

    expect(firstRef).not.toBe(secondRef);
    await withValidatedAcpRemoteStateScope(hostStateRoot, async (scope) => {
      const sidecarDir = getAcpRemoteWorkspaceReferenceDirectoryPath(scope);
      expect(
        (await readdir(sidecarDir)).filter((entry) => entry.endsWith('.json'))
      ).toHaveLength(2);
    });
  });

  it('rotates on missing sidecar and treats the missing binding as not found before recreation', async () => {
    const {
      getAcpRemoteWorkspaceReferenceFilePath,
      getOrCreateAcpRemoteWorkspaceReference,
      readAcpRemoteWorkspaceReference,
    } = await loadReferenceModule();
    const descriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('C:\\Repo\\Rotate.ts')
    );
    const hostStateRoot = deriveAcpRemoteHostStateRoot(descriptor.collisionIdentity);
    await ensureAcpRemoteHostStateRoot(hostStateRoot);

    const firstRef = await getOrCreateAcpRemoteWorkspaceReference(
      hostStateRoot,
      descriptor
    );
    await withValidatedAcpRemoteStateScope(hostStateRoot, async (scope) => {
      await unlink(getAcpRemoteWorkspaceReferenceFilePath(scope, descriptor));
    });

    await expect(
      readAcpRemoteWorkspaceReference(hostStateRoot, descriptor)
    ).rejects.toMatchObject({
      code: 'session_surface_not_found',
      message: 'Session surface was not found',
      retryable: false,
    });

    const rotatedRef = await getOrCreateAcpRemoteWorkspaceReference(
      hostStateRoot,
      descriptor
    );
    expect(rotatedRef).not.toBe(firstRef);
  });

  it('fails closed for corrupt, transplanted, duplicate, wrong-mode, and symlinked sidecars with redacted errors', async () => {
    const {
      getAcpRemoteWorkspaceReferenceDirectoryPath,
      getAcpRemoteWorkspaceReferenceFilePath,
      getOrCreateAcpRemoteWorkspaceReference,
      readAcpRemoteWorkspaceReference,
    } = await loadReferenceModule();
    const descriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('C:\\Repo\\Broken.ts')
    );
    const otherDescriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('c:\\repo\\broken.ts')
    );
    const hostStateRoot = deriveAcpRemoteHostStateRoot(descriptor.collisionIdentity);
    await ensureAcpRemoteHostStateRoot(hostStateRoot);

    const stableRef = await getOrCreateAcpRemoteWorkspaceReference(
      hostStateRoot,
      descriptor
    );
    const scenarios: Array<{
      name: string;
      prepare: () => Promise<void>;
    }> = [
      {
        name: 'corrupt-json',
        prepare: async () => {
          await withValidatedAcpRemoteStateScope(hostStateRoot, async (scope) => {
            await mkdir(getAcpRemoteWorkspaceReferenceDirectoryPath(scope), {
              recursive: false,
              mode: 0o700,
            });
            await writeFile(
              getAcpRemoteWorkspaceReferenceFilePath(scope, descriptor),
              '{"version":1,"workspaceRef":"broken","unexpected":true}',
              {
                encoding: 'utf8',
                flag: 'wx',
                mode: 0o600,
              }
            );
          });
        },
      },
      {
        name: 'transplanted',
        prepare: async () => {
          await withValidatedAcpRemoteStateScope(hostStateRoot, async (scope) => {
            await mkdir(getAcpRemoteWorkspaceReferenceDirectoryPath(scope), {
              recursive: false,
              mode: 0o700,
            });
            await writeFile(
              getAcpRemoteWorkspaceReferenceFilePath(scope, descriptor),
              JSON.stringify({
                version: 1,
                exactIdentityDigest: '0'.repeat(64),
                workspaceRef: stableRef,
              }),
              {
                encoding: 'utf8',
                flag: 'wx',
                mode: 0o600,
              }
            );
          });
        },
      },
      {
        name: 'duplicate-ref',
        prepare: async () => {
          const currentRef = await getOrCreateAcpRemoteWorkspaceReference(
            hostStateRoot,
            descriptor
          );
          await withValidatedAcpRemoteStateScope(hostStateRoot, async (scope) => {
            await writeFile(
              getAcpRemoteWorkspaceReferenceFilePath(scope, otherDescriptor),
              JSON.stringify({
                version: 1,
                exactIdentityDigest: path.basename(
                  getAcpRemoteWorkspaceReferenceFilePath(scope, otherDescriptor),
                  '.json'
                ),
                workspaceRef: currentRef,
              }),
              {
                encoding: 'utf8',
                flag: 'wx',
                mode: 0o600,
              }
            );
          });
        },
      },
      {
        name: 'wrong-mode',
        prepare: async () => {
          await getOrCreateAcpRemoteWorkspaceReference(hostStateRoot, descriptor);
          if (process.platform !== 'win32') {
            await withValidatedAcpRemoteStateScope(hostStateRoot, async (scope) => {
              await chmod(
                getAcpRemoteWorkspaceReferenceFilePath(scope, descriptor),
                0o644
              );
            });
          }
        },
      },
      {
        name: 'symlinked-file',
        prepare: async () => {
          await withValidatedAcpRemoteStateScope(hostStateRoot, async (scope) => {
            const sidecarDir = getAcpRemoteWorkspaceReferenceDirectoryPath(scope);
            await mkdir(sidecarDir, { recursive: false, mode: 0o700 });
            const sidecarPath = getAcpRemoteWorkspaceReferenceFilePath(
              scope,
              descriptor
            );
            const target = path.join(sidecarDir, 'target.json');
            await writeFile(target, 'target', {
              encoding: 'utf8',
              flag: 'wx',
              mode: 0o600,
            });
            await rm(sidecarPath, { force: true });
            await symlink(target, sidecarPath);
          });
        },
      },
    ];

    for (const scenario of scenarios) {
      if (scenario.name === 'wrong-mode' && process.platform === 'win32') {
        continue;
      }
      await rm(hostStateRoot, { recursive: true, force: true });
      await ensureAcpRemoteHostStateRoot(hostStateRoot);
      await scenario.prepare();
      await expect(
        readAcpRemoteWorkspaceReference(hostStateRoot, descriptor)
      ).rejects.toMatchObject({
        code: 'session_surface_state_invalid',
        message: 'Session surface state is invalid',
        retryable: false,
      });
      try {
        await readAcpRemoteWorkspaceReference(hostStateRoot, descriptor);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        expect(message).not.toContain(hostStateRoot);
        expect(message).not.toContain(descriptor.wirePath);
        expect(message).not.toContain(descriptor.exactIdentity);
        expect(message).not.toContain(descriptor.collisionIdentity);
        expect(message).not.toContain(stableRef);
      }
    }
  });

  it('rejects creating the 1025th exact binding in one collision scope', async () => {
    const {
      getAcpRemoteWorkspaceReferenceDirectoryPath,
      getAcpRemoteWorkspaceReferenceFilePath,
      getOrCreateAcpRemoteWorkspaceReference,
    } = await loadReferenceModule();
    const createCaseVariantStem = (variant: number): string =>
      variant
        .toString(2)
        .padStart(11, '0')
        .split('')
        .map((bit, bitIndex) =>
          bit === '1'
            ? String.fromCharCode('A'.charCodeAt(0) + bitIndex)
            : String.fromCharCode('a'.charCodeAt(0) + bitIndex)
        )
        .join('');
    const rootDescriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile(`C:\\${createCaseVariantStem(0)}\\scope.ts`)
    );
    const hostStateRoot = deriveAcpRemoteHostStateRoot(
      rootDescriptor.collisionIdentity
    );
    await ensureAcpRemoteHostStateRoot(hostStateRoot);

    await withValidatedAcpRemoteStateScope(hostStateRoot, async (scope) => {
      const sidecarDir = getAcpRemoteWorkspaceReferenceDirectoryPath(scope);
      await mkdir(sidecarDir, { recursive: false, mode: 0o700 });
      for (let index = 0; index < 1024; index += 1) {
        const descriptor = createAcpRemoteWorkspaceDescriptor(
          createAcpRemotePathProfile(`C:\\${createCaseVariantStem(index)}\\scope.ts`)
        );
        const sidecarPath = getAcpRemoteWorkspaceReferenceFilePath(scope, descriptor);
        await writeFile(
          sidecarPath,
          JSON.stringify({
            version: 1,
            exactIdentityDigest: path.basename(sidecarPath, '.json'),
            workspaceRef: `acp-remote-workspace:${index
              .toString(36)
              .padStart(43, 'x')
              .slice(-43)}`,
          }),
          { encoding: 'utf8', mode: 0o600, flag: 'wx' }
        );
      }
    });

    const overflowDescriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile(`C:\\${createCaseVariantStem(1024)}\\scope.ts`)
    );
    expect(overflowDescriptor.collisionIdentity).toBe(rootDescriptor.collisionIdentity);
    await expect(
      getOrCreateAcpRemoteWorkspaceReference(hostStateRoot, overflowDescriptor)
    ).rejects.toMatchObject({
      code: 'session_surface_capacity',
      message: 'Session surface capacity is exhausted',
      retryable: true,
    });
  });
});
