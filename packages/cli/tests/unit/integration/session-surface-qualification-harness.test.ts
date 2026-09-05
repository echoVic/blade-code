import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAcpRemotePathProfile } from '../../../src/acp/AcpRemotePath.js';
import {
  createAcpRemoteWorkspaceDescriptor,
  deriveAcpRemoteHostStateRoot,
} from '../../../src/acp/AcpRemoteWorkspace.js';
import { PersistentStore } from '../../../src/context/storage/PersistentStore.js';
import { createRemoteSessionStateStorage } from '../../../src/context/storage/SessionStateStorage.js';
import { SessionService } from '../../../src/services/SessionService.js';
import type { TestModelConfig } from '../../integration/real-api/testConfig.js';
import {
  createPairedAcpProductionFixture,
  type PairedAcpFixtureSeed,
  type PairedAcpFixtureSessionRef,
  type PairedAcpProductionFixture,
} from '../../support/acp/remoteFilesystemQualification.js';

const modelConfig: TestModelConfig = {
  id: 'deepseek',
  qualificationId: 'deepseek:deepseek-v4-flash',
  name: 'DeepSeek',
  provider: 'deepseek',
  model: 'deepseek-v4-flash',
  apiKey: 'fixture-secret-api-key',
  baseURL: 'https://example.test/v1',
};

function credentialEnvironmentSnapshot(): Map<string, string> {
  return new Map(
    Object.entries(process.env).flatMap(([name, value]) =>
      (name.startsWith('BLADE_MODEL_API_KEY_') ||
        name.startsWith('BLADE_REAL_API_PROVIDER_KEY_')) &&
      value !== undefined
        ? [[name, value]]
        : []
    )
  );
}

const deterministicSeed: PairedAcpFixtureSeed = async (context) => {
  const sessionId = 'acp_fixture_seed';
  const descriptor = createAcpRemoteWorkspaceDescriptor(
    createAcpRemotePathProfile(context.remoteWorkspacePath)
  );
  const projectPath = deriveAcpRemoteHostStateRoot(descriptor.collisionIdentity);
  await SessionService.createRemoteSessionMetadata(sessionId, projectPath, descriptor, {
    title: 'Remote qualification fixture',
    selectedModelId: context.model.model,
  });
  const persistent = new PersistentStore(
    projectPath,
    100,
    undefined,
    createRemoteSessionStateStorage(projectPath, descriptor)
  );
  await persistent.saveMessage(
    sessionId,
    'user',
    'Read the remote fixture once and confirm completion.'
  );
  await persistent.saveMessage(sessionId, 'assistant', 'REMOTE_HISTORY_READY');

  return {
    sessionId,
    projectPath,
    remoteWorkspace: descriptor,
    providerRequests: [{ pathname: '/chat/completions', bodyBytes: 256 }],
    remoteFilesystemRequests: [{ kind: 'read', path: context.remoteSourcePath }],
    acpTerminalCreateCount: 0,
    acpTerminalOutputCount: 0,
    notificationCount: 4,
    writeResultCount: 0,
    finalAssistantText: 'REMOTE_HISTORY_READY',
  };
};

async function createQualificationFixture(
  fixtureRoot: string,
  frameworkRetryBudget: number
): Promise<PairedAcpProductionFixture> {
  return createPairedAcpProductionFixture({
    model: modelConfig,
    frameworkRetryBudget,
    fixtureRoot,
    testOnly: { marker: 'unit-only', seed: deterministicSeed },
  });
}

async function createFixtureRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'blade-session-surface-fixture-'));
}

function expectSafeSerialization(value: unknown, forbidden: readonly string[]): void {
  const serialized = JSON.stringify(value);
  expect(serialized).not.toBeUndefined();
  for (const secret of forbidden) {
    if (!secret) continue;
    expect(serialized).not.toContain(secret);
  }
}

describe('session surface qualification harness', () => {
  const cleanupRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanupRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
    );
  });

  it('keeps compaction memory qualification on every production surface', async () => {
    const integrationPath = path.resolve(
      import.meta.dirname,
      '../../integration/compaction-memory-consolidation.test.ts'
    );
    const acpRunnerPath = path.resolve(
      import.meta.dirname,
      '../../support/memoryConsolidationAcpRunner.ts'
    );
    const ptyRunnerPath = path.resolve(
      import.meta.dirname,
      '../../support/memoryConsolidationPtyRunner.ts'
    );
    const [integration, acpRunner, ptyRunner] = await Promise.all([
      readFile(integrationPath, 'utf8'),
      readFile(acpRunnerPath, 'utf8'),
      readFile(ptyRunnerPath, 'utf8'),
    ]);

    expect(integration).toContain("import { chromium } from 'playwright'");
    expect(integration).toContain('../../dist/blade.js');
    expect(integration).toContain('compaction.started');
    expect(integration).toContain('compaction.completed');
    expect(integration).toContain('conventions.md');
    expect(integration).toContain('MEMORY.md');
    expect(integration).toContain('page.reload');
    expect(integration).toContain('BLADE_STORAGE_ROOT');
    expect(integration).toContain('HOME');
    expect(acpRunner).toContain("[input.cliEntry, '--acp']");
    expect(acpRunner).toContain('blade/compaction');
    expect(ptyRunner).toContain("import { spawn } from 'bun-pty'");
    expect(ptyRunner).toContain('正在压缩上下文');
    expect(ptyRunner).toContain('Saved 1 project memories');
  });

  it('creates a disconnected production ACP fixture with redacted evidence and temporary session refs', async () => {
    const fixtureRoot = await createFixtureRoot();
    cleanupRoots.push(fixtureRoot);
    const fixture = await createQualificationFixture(fixtureRoot, 0);

    try {
      expect(fixture.ownerDisconnected).toBe(true);
      expect(fixture.serializableEvidence.providerRequestCount).toBeGreaterThan(0);
      expect(fixture.serializableEvidence.acpFileReadCount).toBeGreaterThan(0);
      expect(fixture.serializableEvidence.acpTerminalCreateCount).toBe(0);
      expect(fixture.serializableEvidence.acpTerminalOutputCount).toBe(0);
      expect(fixture.serializableEvidence.notificationCount).toBeGreaterThan(0);
      expect(fixture.serializableEvidence.writeResultCount).toBeGreaterThanOrEqual(0);
      expect(fixture.serializableEvidence.providerRequestDigest).toMatch(
        /^[a-f0-9]{64}$/
      );
      expect(fixture.serializableEvidence.remoteFilesystemEvidenceDigest).toMatch(
        /^[a-f0-9]{64}$/
      );
      expect(fixture.serializableEvidence.finalAssistantTextDigest).toMatch(
        /^[a-f0-9]{64}$/
      );
      expect(fixture.serializableEvidence.transcriptDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(fixture.serializableCoordinates.sessionIdDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(fixture.serializableCoordinates.projectPathDigest).toMatch(
        /^[a-f0-9]{64}$/
      );
      expect(fixture.serializableCoordinates.remoteWorkspaceDigest).toMatch(
        /^[a-f0-9]{64}$/
      );

      expectSafeSerialization(fixture, [
        modelConfig.apiKey,
        fixtureRoot,
        '/workspace',
        '/storage',
        '/home',
        'REMOTE_SOURCE_',
        'HOST_CANARY_',
        'exactIdentity',
      ]);

      let observedRef:
        | { sessionId: string; projectPath: string; remoteWorkspace: string }
        | undefined;
      await fixture.withSessionRef(async (ref) => {
        const metadata = await ref.readMetadata();
        if (!metadata?.remoteWorkspace) {
          throw new Error('Expected remote metadata in scoped access');
        }
        for (const forbiddenValue of ref.forbiddenSurfaceValues) {
          expect(ref.remoteWorkspacePath).not.toBe(forbiddenValue);
          expect(ref.remoteWorkspacePath.startsWith(forbiddenValue + path.sep)).toBe(
            false
          );
        }
        observedRef = {
          sessionId: ref.sessionId,
          projectPath: ref.projectPath,
          remoteWorkspace: metadata.remoteWorkspace.exactIdentity,
        };
        expect(metadata?.sessionId).toBe(ref.sessionId);
        expect(metadata?.projectPath).toBe(ref.projectPath);
        return undefined;
      });
      expect(observedRef).toBeDefined();
      if (!observedRef) {
        throw new Error('Expected withSessionRef to expose the durable session ref');
      }
      expect(observedRef.sessionId).toMatch(/^acp_/);
      expect(observedRef.projectPath).toMatch(/^\/.+/);
      expect(observedRef.remoteWorkspace).toBeTruthy();

      expectSafeSerialization(fixture.serializableCoordinates, [
        observedRef.sessionId,
        observedRef.projectPath,
        observedRef.remoteWorkspace,
      ]);
    } finally {
      await fixture.cleanup();
    }
  }, 180_000);

  it('builds isolated launch env and cleanup is idempotent', async () => {
    const fixtureRoot = await createFixtureRoot();
    cleanupRoots.push(fixtureRoot);
    const fixture = await createQualificationFixture(fixtureRoot, 1);

    try {
      let storageRoot: string | undefined;
      await fixture.withSessionRef(async (ref) => {
        const env = ref.buildLaunchEnv({
          HOME: '/should/not/leak',
          BLADE_STORAGE_ROOT: '/should/not/leak-either',
          PATH: process.env.PATH,
        });
        expect(env.HOME).toBe(ref.home);
        expect(env.BLADE_STORAGE_ROOT).toBe(ref.storageRoot);
        storageRoot = ref.storageRoot;
        return undefined;
      });
      if (!storageRoot) throw new Error('Expected private fixture storage access');

      const storageBefore = await stat(storageRoot);
      expect(storageBefore.isDirectory()).toBe(true);
      await fixture.cleanup();
      await fixture.cleanup();
      await expect(stat(storageRoot)).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await expect(readdir(fixtureRoot)).resolves.toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects serializing live session accessors', async () => {
    const fixtureRoot = await createFixtureRoot();
    cleanupRoots.push(fixtureRoot);
    const fixture: PairedAcpProductionFixture = await createQualificationFixture(
      fixtureRoot,
      0
    );

    try {
      expect(typeof fixture.withSessionRef).toBe('function');
      expect(typeof fixture.cleanup).toBe('function');
      expect(JSON.stringify(fixture.serializableEvidence)).toBeTruthy();
      expect(JSON.stringify(fixture.serializableCoordinates)).toBeTruthy();
      let escapedReference: PairedAcpFixtureSessionRef | undefined;
      const callbackResult = await fixture.withSessionRef((reference) => {
        escapedReference = reference;
        return undefined;
      });
      expect(callbackResult).toBeUndefined();
      if (!escapedReference) throw new Error('Expected temporary reference');
      const expiredReference = escapedReference;
      expect(() => expiredReference.sessionId).toThrow(
        'Paired ACP fixture session reference has expired'
      );
      await expect(expiredReference.readTranscript()).rejects.toThrow(
        'Paired ACP fixture session reference has expired'
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('restores Provider credential environment after construction and callback use', async () => {
    const fixtureRoot = await createFixtureRoot();
    cleanupRoots.push(fixtureRoot);
    const credentialsBefore = credentialEnvironmentSnapshot();
    const fixture = await createQualificationFixture(fixtureRoot, 0);
    try {
      expect(credentialEnvironmentSnapshot()).toEqual(credentialsBefore);
      await fixture.withSessionRef(async () => {
        expect(credentialEnvironmentSnapshot()).toEqual(credentialsBefore);
        return undefined;
      });
      expect(credentialEnvironmentSnapshot()).toEqual(credentialsBefore);
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects deterministic seeds when real qualification is enabled', async () => {
    const fixtureRoot = await createFixtureRoot();
    cleanupRoots.push(fixtureRoot);
    const originalRealApi = process.env.REAL_API_TEST;
    process.env.REAL_API_TEST = '1';
    try {
      await expect(createQualificationFixture(fixtureRoot, 0)).rejects.toThrow(
        'Deterministic paired ACP seed is unavailable in real API runs'
      );
    } finally {
      if (originalRealApi === undefined) delete process.env.REAL_API_TEST;
      else process.env.REAL_API_TEST = originalRealApi;
    }
  });

  it('rejects non-zero framework retries on the production path before networking', async () => {
    const fixtureRoot = await createFixtureRoot();
    cleanupRoots.push(fixtureRoot);
    const originalRealApi = process.env.REAL_API_TEST;
    process.env.REAL_API_TEST = '1';
    try {
      await expect(
        createPairedAcpProductionFixture({
          model: modelConfig,
          frameworkRetryBudget: 1,
          fixtureRoot,
        })
      ).rejects.toThrow('Production paired ACP fixture requires framework retry 0');
    } finally {
      if (originalRealApi === undefined) delete process.env.REAL_API_TEST;
      else process.env.REAL_API_TEST = originalRealApi;
    }
  });

  it('waits for active session access before cleanup and rejects later access', async () => {
    const fixtureRoot = await createFixtureRoot();
    cleanupRoots.push(fixtureRoot);
    const fixture = await createQualificationFixture(fixtureRoot, 0);
    let releaseAccess!: () => void;
    const accessBarrier = new Promise<void>((resolve) => {
      releaseAccess = resolve;
    });
    let accessStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      accessStarted = resolve;
    });
    const activeAccess = fixture.withSessionRef(async (reference) => {
      expect(reference.sessionId).toBeTruthy();
      accessStarted();
      await accessBarrier;
      return undefined;
    });
    await started;
    const cleanup = fixture.cleanup();
    let cleaned = false;
    void cleanup.then(() => {
      cleaned = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(cleaned).toBe(false);
    releaseAccess();
    await Promise.all([activeAccess, cleanup]);
    expect(cleaned).toBe(true);
    await expect(fixture.withSessionRef(async () => undefined)).rejects.toThrow(
      'Paired ACP fixture has been cleaned up'
    );
  });

  it('rejects returning a scoped reference value and revokes the handle', async () => {
    const fixtureRoot = await createFixtureRoot();
    cleanupRoots.push(fixtureRoot);
    const fixture = await createQualificationFixture(fixtureRoot, 0);
    let escapedReference: PairedAcpFixtureSessionRef | undefined;
    try {
      await expect(
        fixture.withSessionRef((reference) => {
          escapedReference = reference;
          return reference as unknown as undefined;
        })
      ).rejects.toThrow('Paired ACP fixture session callbacks cannot return a value');
      if (!escapedReference) throw new Error('Expected escaped reference probe');
      const expiredReference = escapedReference;
      expect(() => expiredReference.projectPath).toThrow(
        'Paired ACP fixture session reference has expired'
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('fails fast when scoped operations try to re-enter the same fixture', async () => {
    const fixtureRoot = await createFixtureRoot();
    cleanupRoots.push(fixtureRoot);
    const fixture = await createQualificationFixture(fixtureRoot, 0);
    try {
      await fixture.withSessionRef(async () => {
        await expect(fixture.withSessionRef(async () => undefined)).rejects.toThrow(
          'Paired ACP fixture operations cannot be nested'
        );
        await expect(fixture.cleanup()).rejects.toThrow(
          'Paired ACP fixture operations cannot be nested'
        );
        return undefined;
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects cross-fixture re-entry without poisoning a later detached acquisition', async () => {
    const firstRoot = await createFixtureRoot();
    const secondRoot = await createFixtureRoot();
    cleanupRoots.push(firstRoot, secondRoot);
    const first = await createQualificationFixture(firstRoot, 0);
    const second = await createQualificationFixture(secondRoot, 0);
    let runDetached!: () => void;
    const detached = new Promise<void>((resolve, reject) => {
      void first
        .withSessionRef(async () => {
          await expect(second.withSessionRef(async () => undefined)).rejects.toThrow(
            'Paired ACP fixture operations cannot be nested'
          );
          await expect(second.cleanup()).rejects.toThrow(
            'Paired ACP fixture operations cannot be nested'
          );
          runDetached = () => {
            void second
              .withSessionRef(async (reference) => {
                expect(reference.sessionId).toBeTruthy();
                return undefined;
              })
              .then(resolve, reject);
          };
          return undefined;
        })
        .then(() => runDetached(), reject);
    });

    try {
      await detached;
    } finally {
      await Promise.all([first.cleanup(), second.cleanup()]);
    }
  });
});
