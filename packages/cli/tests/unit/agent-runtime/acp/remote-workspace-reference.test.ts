import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAcpRemotePathProfile } from '../../../../src/acp/AcpRemotePath.js';
import {
  createAcpRemoteWorkspaceDescriptor,
  deriveAcpRemoteHostStateRoot,
  ensureAcpRemoteHostStateRoot,
  withValidatedAcpRemoteStateScope,
} from '../../../../src/acp/AcpRemoteWorkspace.js';

vi.unmock('child_process');
vi.unmock('node:child_process');

async function loadReferenceModule() {
  return import('../../../../src/acp/AcpRemoteWorkspaceReference.js');
}

const REFERENCE_MODULE_URL = pathToFileURL(
  path.resolve(
    import.meta.dirname,
    '../../../../src/acp/AcpRemoteWorkspaceReference.ts'
  )
).href;
const CHILD_TIMEOUT_MS = 20_000;

type ReferenceOutcome =
  | { readonly type: 'result'; readonly workspaceRef: string }
  | {
      readonly type: 'error';
      readonly code?: string;
      readonly message: string;
      readonly retryable?: boolean;
    };

interface ReferenceTestHooks {
  readonly afterPublish?: (context: {
    readonly finalPath: string;
    readonly referenceDirectoryPath: string;
    readonly tempPath: string;
  }) => Promise<void>;
  readonly afterCapacityLockAcquired?: () => Promise<void>;
  readonly beforeCapacityLockAttempt?: () => Promise<void>;
  readonly beforePublish?: (context: {
    readonly finalPath: string;
    readonly referenceDirectoryPath: string;
    readonly tempPath: string;
  }) => Promise<void>;
  readonly syncDirectory?: (directoryPath: string) => Promise<void>;
}

interface ReferenceTestSeams {
  readonly setHooks: (hooks: ReferenceTestHooks | undefined) => void;
  readonly shouldSyncDirectory: (platform: NodeJS.Platform) => boolean;
}

function requireReferenceTestSeams(module: object): ReferenceTestSeams {
  if (
    !('__setAcpRemoteWorkspaceReferenceHooksForTesting' in module) ||
    typeof module.__setAcpRemoteWorkspaceReferenceHooksForTesting !== 'function' ||
    !('__shouldSyncAcpRemoteWorkspaceReferenceDirectoryForTesting' in module) ||
    typeof module.__shouldSyncAcpRemoteWorkspaceReferenceDirectoryForTesting !==
      'function'
  ) {
    throw new Error('AcpRemoteWorkspaceReference test seams are unavailable');
  }
  const setHooks = module.__setAcpRemoteWorkspaceReferenceHooksForTesting;
  const shouldSyncDirectory =
    module.__shouldSyncAcpRemoteWorkspaceReferenceDirectoryForTesting;
  return {
    setHooks: (hooks) => setHooks(hooks),
    shouldSyncDirectory: (platform) => shouldSyncDirectory(platform),
  };
}

function createCaseVariantStem(variant: number): string {
  return variant
    .toString(2)
    .padStart(11, '0')
    .split('')
    .map((bit, bitIndex) =>
      bit === '1'
        ? String.fromCharCode('A'.charCodeAt(0) + bitIndex)
        : String.fromCharCode('a'.charCodeAt(0) + bitIndex)
    )
    .join('');
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function waitForFile(filePath: string): Promise<void> {
  const deadline = Date.now() + CHILD_TIMEOUT_MS;
  while (!(await fileExists(filePath))) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for child-process barrier');
    }
    await delay(10);
  }
}

function startReferenceChild(input: {
  readonly descriptor: ReturnType<typeof createAcpRemoteWorkspaceDescriptor>;
  readonly hostStateRoot: string;
  readonly readyPath?: string;
  readonly releasePath?: string;
  readonly storageRoot: string;
  readonly waitAfterLockPath?: string;
}): {
  readonly child: ChildProcessWithoutNullStreams;
  readonly outcome: Promise<ReferenceOutcome>;
} {
  const childSource = [
    "import { writeFile } from 'node:fs/promises';",
    "import { setTimeout as delay } from 'node:timers/promises';",
    'const rawInput = process.env.BLADE_REFERENCE_WORKER_INPUT;',
    'const moduleUrl = process.env.BLADE_REFERENCE_MODULE_URL;',
    "if (!rawInput || !moduleUrl) throw new Error('Reference child input is missing');",
    'const input = JSON.parse(rawInput);',
    'process.env.BLADE_STORAGE_ROOT = input.storageRoot;',
    'const module = await import(moduleUrl);',
    'if (input.readyPath && input.releasePath) {',
    'module.__setAcpRemoteWorkspaceReferenceHooksForTesting({',
    'beforeCapacityLockAttempt: async () => {',
    "await writeFile(input.readyPath, 'ready', 'utf8');",
    'while (!(await Bun.file(input.releasePath).exists())) await delay(5);',
    '},',
    '});',
    '}',
    'if (input.waitAfterLockPath) {',
    'module.__setAcpRemoteWorkspaceReferenceHooksForTesting({',
    'afterPublish: async () => {',
    "await writeFile(input.waitAfterLockPath, 'locked', 'utf8');",
    'await new Promise(() => undefined);',
    '},',
    '});',
    '}',
    'try {',
    'const workspaceRef = await module.getOrCreateAcpRemoteWorkspaceReference(input.hostStateRoot, input.descriptor);',
    "process.stdout.write(JSON.stringify({ type: 'result', workspaceRef }) + '\\n');",
    '} catch (error) {',
    "process.stdout.write(JSON.stringify({ type: 'error', code: error && typeof error === 'object' && typeof error.code === 'string' ? error.code : undefined, message: error instanceof Error ? error.message : String(error), retryable: error && typeof error === 'object' && typeof error.retryable === 'boolean' ? error.retryable : undefined }) + '\\n');",
    '}',
  ].join('\n');
  const child = spawn('bun', ['-e', childSource], {
    cwd: path.resolve(import.meta.dirname, '../../../..'),
    env: {
      ...process.env,
      BLADE_REFERENCE_MODULE_URL: REFERENCE_MODULE_URL,
      BLADE_REFERENCE_WORKER_INPUT: JSON.stringify(input),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const outcome = new Promise<ReferenceOutcome>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Reference child timed out'));
    }, CHILD_TIMEOUT_MS);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      const line = stdout
        .split('\n')
        .map((entry) => entry.trim())
        .findLast((entry) => entry.startsWith('{'));
      if (code !== 0 || signal || !line) {
        reject(new Error(`Reference child failed (${code ?? signal}): ${stderr}`));
        return;
      }
      resolve(JSON.parse(line) as ReferenceOutcome);
    });
  });
  return { child, outcome };
}

async function syncDirectoryForFixture(directoryPath: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(directoryPath, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

describe('AcpRemoteWorkspaceReference', () => {
  let storageRoot: string;
  let previousStorageRoot: string | undefined;
  let children: Set<ChildProcessWithoutNullStreams>;

  beforeEach(async () => {
    children = new Set();
    previousStorageRoot = process.env.BLADE_STORAGE_ROOT;
    storageRoot = await mkdtemp(
      path.join(os.tmpdir(), 'blade-acp-remote-workspace-reference-test-')
    );
    process.env.BLADE_STORAGE_ROOT = storageRoot;
  });

  afterEach(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    children.clear();
    const module = await loadReferenceModule();
    if ('__setAcpRemoteWorkspaceReferenceHooksForTesting' in module) {
      module.__setAcpRemoteWorkspaceReferenceHooksForTesting(undefined);
    }
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

  it('publishes only a complete synced sidecar and reads an EEXIST winner without reentering the scope gate', async () => {
    const module = await loadReferenceModule();
    const seams = requireReferenceTestSeams(module);
    const descriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('C:\\Repo\\Atomic.ts')
    );
    const hostStateRoot = deriveAcpRemoteHostStateRoot(descriptor.collisionIdentity);
    await ensureAcpRemoteHostStateRoot(hostStateRoot);
    let releasePublish: (() => void) | undefined;
    const release = new Promise<void>((resolve) => {
      releasePublish = resolve;
    });
    let publishContext:
      | {
          readonly finalPath: string;
          readonly referenceDirectoryPath: string;
          readonly tempPath: string;
        }
      | undefined;
    let markReady: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      markReady = resolve;
    });
    seams.setHooks({
      beforePublish: async (context) => {
        publishContext = context;
        markReady?.();
        await release;
      },
    });

    const pending = module.getOrCreateAcpRemoteWorkspaceReference(
      hostStateRoot,
      descriptor
    );
    await ready;
    if (!publishContext) throw new Error('Publish context was not captured');

    await expect(lstat(publishContext.finalPath)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    const stagedPayload = JSON.parse(
      await readFile(publishContext.tempPath, 'utf8')
    ) as Record<string, unknown>;
    expect(stagedPayload).toMatchObject({
      version: 1,
      exactIdentityDigest: path.basename(publishContext.finalPath, '.json'),
    });
    expect(stagedPayload.workspaceRef).toMatch(
      /^acp-remote-workspace:[A-Za-z0-9_-]{43}$/
    );

    const winnerRef = `acp-remote-workspace:${'w'.repeat(43)}`;
    const winnerHandle = await open(publishContext.finalPath, 'wx', 0o600);
    try {
      await winnerHandle.writeFile(
        JSON.stringify({
          version: 1,
          exactIdentityDigest: path.basename(publishContext.finalPath, '.json'),
          workspaceRef: winnerRef,
        }),
        'utf8'
      );
      await winnerHandle.sync();
    } finally {
      await winnerHandle.close();
    }
    await syncDirectoryForFixture(publishContext.referenceDirectoryPath);
    releasePublish?.();

    await expect(pending).resolves.toBe(winnerRef);
    expect(await fileExists(publishContext.tempPath)).toBe(false);
    seams.setHooks(undefined);
  });

  it('uses platform policy to avoid opening directories for fsync on win32', async () => {
    const seams = requireReferenceTestSeams(await loadReferenceModule());
    expect(seams.shouldSyncDirectory('win32')).toBe(false);
    expect(seams.shouldSyncDirectory('darwin')).toBe(true);
    expect(seams.shouldSyncDirectory('linux')).toBe(true);
  });

  it('cleans abandoned private temp sidecars before creating a binding', async () => {
    const {
      getAcpRemoteWorkspaceReferenceDirectoryPath,
      getOrCreateAcpRemoteWorkspaceReference,
    } = await loadReferenceModule();
    const descriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('C:\\Repo\\CrashTemp.ts')
    );
    const hostStateRoot = deriveAcpRemoteHostStateRoot(descriptor.collisionIdentity);
    await ensureAcpRemoteHostStateRoot(hostStateRoot);
    let tempPath = '';
    await withValidatedAcpRemoteStateScope(hostStateRoot, async (scope) => {
      const directoryPath = getAcpRemoteWorkspaceReferenceDirectoryPath(scope);
      await mkdir(directoryPath, { recursive: false, mode: 0o700 });
      tempPath = path.join(
        directoryPath,
        '.tmp-acp-remote-workspace-99999999-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.pending'
      );
      await writeFile(tempPath, '{', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    });

    await expect(
      getOrCreateAcpRemoteWorkspaceReference(hostStateRoot, descriptor)
    ).resolves.toMatch(/^acp-remote-workspace:[A-Za-z0-9_-]{43}$/);
    expect(await fileExists(tempPath)).toBe(false);
  });

  it('fails closed when the private capacity coordinator is a symlink', async () => {
    const {
      getAcpRemoteWorkspaceReferenceDirectoryPath,
      getOrCreateAcpRemoteWorkspaceReference,
    } = await loadReferenceModule();
    const descriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('C:\\Repo\\CoordinatorSymlink.ts')
    );
    const hostStateRoot = deriveAcpRemoteHostStateRoot(descriptor.collisionIdentity);
    await ensureAcpRemoteHostStateRoot(hostStateRoot);
    await withValidatedAcpRemoteStateScope(hostStateRoot, async (scope) => {
      const directoryPath = getAcpRemoteWorkspaceReferenceDirectoryPath(scope);
      await mkdir(directoryPath, { recursive: false, mode: 0o700 });
      const targetPath = path.join(directoryPath, 'outside.sqlite');
      await writeFile(targetPath, '', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      await symlink(
        targetPath,
        path.join(directoryPath, '.surface-workspaces-v1.capacity.sqlite')
      );
    });

    await expect(
      getOrCreateAcpRemoteWorkspaceReference(hostStateRoot, descriptor)
    ).rejects.toMatchObject({
      code: 'session_surface_state_invalid',
      message: 'Session surface state is invalid',
      retryable: false,
    });
  });

  it.runIf(process.platform !== 'win32')(
    'fails closed when the private capacity coordinator has a public mode',
    async () => {
      const {
        getAcpRemoteWorkspaceReferenceDirectoryPath,
        getOrCreateAcpRemoteWorkspaceReference,
      } = await loadReferenceModule();
      const descriptor = createAcpRemoteWorkspaceDescriptor(
        createAcpRemotePathProfile('C:\\Repo\\CoordinatorMode.ts')
      );
      const hostStateRoot = deriveAcpRemoteHostStateRoot(descriptor.collisionIdentity);
      await ensureAcpRemoteHostStateRoot(hostStateRoot);
      await withValidatedAcpRemoteStateScope(hostStateRoot, async (scope) => {
        const directoryPath = getAcpRemoteWorkspaceReferenceDirectoryPath(scope);
        await mkdir(directoryPath, { recursive: false, mode: 0o700 });
        await writeFile(
          path.join(directoryPath, '.surface-workspaces-v1.capacity.sqlite'),
          '',
          { encoding: 'utf8', flag: 'wx', mode: 0o644 }
        );
      });

      await expect(
        getOrCreateAcpRemoteWorkspaceReference(hostStateRoot, descriptor)
      ).rejects.toMatchObject({
        code: 'session_surface_state_invalid',
        message: 'Session surface state is invalid',
        retryable: false,
      });
    }
  );

  it('maps directory sync failures to a redacted state error', async () => {
    const module = await loadReferenceModule();
    const seams = requireReferenceTestSeams(module);
    const descriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('C:\\Repo\\SyncFailure.ts')
    );
    const hostStateRoot = deriveAcpRemoteHostStateRoot(descriptor.collisionIdentity);
    await ensureAcpRemoteHostStateRoot(hostStateRoot);
    seams.setHooks({
      syncDirectory: async (directoryPath) => {
        throw new Error(`private path ${directoryPath}`);
      },
    });

    await expect(
      module.getOrCreateAcpRemoteWorkspaceReference(hostStateRoot, descriptor)
    ).rejects.toMatchObject({
      code: 'session_surface_state_invalid',
      message: 'Session surface state is invalid',
      retryable: false,
    });
  });

  it.runIf(process.platform !== 'win32')(
    'keeps an already committed binding authoritative when post-commit cleanup fails',
    async () => {
      const module = await loadReferenceModule();
      const seams = requireReferenceTestSeams(module);
      const descriptor = createAcpRemoteWorkspaceDescriptor(
        createAcpRemotePathProfile('C:\\Repo\\CommittedCleanup.ts')
      );
      const hostStateRoot = deriveAcpRemoteHostStateRoot(descriptor.collisionIdentity);
      await ensureAcpRemoteHostStateRoot(hostStateRoot);
      let obstructedTempPath = '';
      seams.setHooks({
        afterPublish: async ({ tempPath }) => {
          obstructedTempPath = tempPath;
          await unlink(tempPath);
          await mkdir(tempPath, { mode: 0o700 });
        },
      });

      const workspaceRef = await module.getOrCreateAcpRemoteWorkspaceReference(
        hostStateRoot,
        descriptor
      );
      expect(workspaceRef).toMatch(/^acp-remote-workspace:[A-Za-z0-9_-]{43}$/);
      if (!obstructedTempPath) throw new Error('Temp cleanup was not obstructed');
      await rm(obstructedTempPath, { recursive: true, force: true });
      await expect(
        module.readAcpRemoteWorkspaceReference(hostStateRoot, descriptor)
      ).resolves.toBe(workspaceRef);
    }
  );

  it('releases the cross-process coordinator after its owner is killed', async () => {
    const { getOrCreateAcpRemoteWorkspaceReference } = await loadReferenceModule();
    const firstDescriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('C:\\Repo\\CrashLock.ts')
    );
    const secondDescriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('C:\\Repo\\crashlock.ts')
    );
    const hostStateRoot = deriveAcpRemoteHostStateRoot(
      firstDescriptor.collisionIdentity
    );
    expect(secondDescriptor.collisionIdentity).toBe(firstDescriptor.collisionIdentity);
    await ensureAcpRemoteHostStateRoot(hostStateRoot);
    const lockedPath = path.join(storageRoot, 'coordinator-locked');
    const holder = startReferenceChild({
      descriptor: firstDescriptor,
      hostStateRoot,
      storageRoot,
      waitAfterLockPath: lockedPath,
    });
    children.add(holder.child);
    await Promise.race([
      waitForFile(lockedPath),
      holder.outcome.then((outcome) => {
        throw new Error(
          `Reference child exited before acquiring the lock: ${JSON.stringify(outcome)}`
        );
      }),
    ]);
    holder.child.kill('SIGKILL');
    await new Promise<void>((resolve) => holder.child.once('exit', () => resolve()));

    await expect(
      getOrCreateAcpRemoteWorkspaceReference(hostStateRoot, secondDescriptor)
    ).resolves.toMatch(/^acp-remote-workspace:[A-Za-z0-9_-]{43}$/);
  }, 30_000);

  it('keeps exactly one free capacity slot across two real Bun processes', async () => {
    const {
      getAcpRemoteWorkspaceReferenceDirectoryPath,
      getAcpRemoteWorkspaceReferenceFilePath,
      getOrCreateAcpRemoteWorkspaceReference,
    } = await loadReferenceModule();
    const rootDescriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile(`C:\\${createCaseVariantStem(0)}\\race.ts`)
    );
    const hostStateRoot = deriveAcpRemoteHostStateRoot(
      rootDescriptor.collisionIdentity
    );
    await ensureAcpRemoteHostStateRoot(hostStateRoot);
    await getOrCreateAcpRemoteWorkspaceReference(hostStateRoot, rootDescriptor);
    let referenceDirectoryPath = '';
    await withValidatedAcpRemoteStateScope(hostStateRoot, async (scope) => {
      referenceDirectoryPath = getAcpRemoteWorkspaceReferenceDirectoryPath(scope);
      for (let index = 1; index < 1023; index += 1) {
        const descriptor = createAcpRemoteWorkspaceDescriptor(
          createAcpRemotePathProfile(`C:\\${createCaseVariantStem(index)}\\race.ts`)
        );
        const sidecarPath = getAcpRemoteWorkspaceReferenceFilePath(scope, descriptor);
        await writeFile(
          sidecarPath,
          JSON.stringify({
            version: 1,
            exactIdentityDigest: path.basename(sidecarPath, '.json'),
            workspaceRef: `acp-remote-workspace:B${index
              .toString(36)
              .padStart(42, 'A')
              .slice(-42)}`,
          }),
          { encoding: 'utf8', flag: 'wx', mode: 0o600 }
        );
      }
      await syncDirectoryForFixture(referenceDirectoryPath);
    });

    const contenderA = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile(`C:\\${createCaseVariantStem(1023)}\\race.ts`)
    );
    const contenderB = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile(`C:\\${createCaseVariantStem(1024)}\\race.ts`)
    );
    expect(contenderA.collisionIdentity).toBe(rootDescriptor.collisionIdentity);
    expect(contenderB.collisionIdentity).toBe(rootDescriptor.collisionIdentity);

    const readyA = path.join(storageRoot, 'ready-a');
    const readyB = path.join(storageRoot, 'ready-b');
    const releasePath = path.join(storageRoot, 'release');
    const workerA = startReferenceChild({
      descriptor: contenderA,
      hostStateRoot,
      readyPath: readyA,
      releasePath,
      storageRoot,
    });
    children.add(workerA.child);
    const workerB = startReferenceChild({
      descriptor: contenderB,
      hostStateRoot,
      readyPath: readyB,
      releasePath,
      storageRoot,
    });
    children.add(workerB.child);
    await Promise.race([
      Promise.all([waitForFile(readyA), waitForFile(readyB)]),
      workerA.outcome.then((outcome) => {
        throw new Error(
          `Reference child A exited before the barrier: ${JSON.stringify(outcome)}`
        );
      }),
      workerB.outcome.then((outcome) => {
        throw new Error(
          `Reference child B exited before the barrier: ${JSON.stringify(outcome)}`
        );
      }),
    ]);
    await writeFile(releasePath, 'go', 'utf8');
    const outcomes = await Promise.all([workerA.outcome, workerB.outcome]);
    expect(outcomes, JSON.stringify(outcomes)).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'result' })])
    );
    expect(outcomes.filter((outcome) => outcome.type === 'result')).toHaveLength(1);
    expect(
      outcomes.filter(
        (outcome) =>
          outcome.type === 'error' &&
          outcome.code === 'session_surface_capacity' &&
          outcome.retryable === true
      )
    ).toHaveLength(1);
    expect(
      (await readdir(referenceDirectoryPath)).filter((entry) => entry.endsWith('.json'))
    ).toHaveLength(1024);
  }, 30_000);
});
