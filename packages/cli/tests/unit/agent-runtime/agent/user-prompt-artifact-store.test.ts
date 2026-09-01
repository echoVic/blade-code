import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAcpRemotePathProfile } from '../../../../src/acp/AcpRemotePath.js';
import {
  createAcpRemoteWorkspaceDescriptor,
  deriveAcpRemoteHostStateRoot,
  ensureAcpRemoteHostStateRoot,
} from '../../../../src/acp/AcpRemoteWorkspace.js';
import {
  collectUserPromptArtifactIds,
  getUserPromptArtifactReference,
  MAX_USER_PROMPT_ARTIFACT_READ_BYTES,
  MAX_USER_PROMPT_ARTIFACTS_PER_SESSION,
  UserPromptArtifactStore,
} from '../../../../src/agent/runtime/UserPromptArtifactStore.js';
import {
  MAX_INLINE_USER_MESSAGE_TEXT_BYTES,
  MAX_USER_MESSAGE_TEXT_BYTES,
  MAX_USER_MESSAGE_TEXT_CHARS,
} from '../../../../src/api/attachmentLimits.js';
import { createRemoteSessionStateStorage } from '../../../../src/context/storage/SessionStateStorage.js';

describe('UserPromptArtifactStore', () => {
  let storageRoot: string;
  let workspaceRoot: string;
  let store: UserPromptArtifactStore;

  beforeEach(() => {
    storageRoot = mkdtempSync(path.join(os.tmpdir(), 'blade-prompt-artifact-'));
    workspaceRoot = path.join(storageRoot, 'workspace');
    vi.stubEnv('BLADE_STORAGE_ROOT', storageRoot);
    store = new UserPromptArtifactStore(workspaceRoot, 'session-1', {
      storageRoot,
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(storageRoot, { recursive: true, force: true });
  });

  it('keeps small prompts inline without creating storage', async () => {
    await expect(store.materialize('small request')).resolves.toEqual({
      content: 'small request',
      metadata: undefined,
      offloaded: false,
    });
    expect(readdirSync(storageRoot)).toEqual([]);
  });

  it('stores an oversized prompt privately and reconstructs it by UTF-8 chunks', async () => {
    const full = `HEAD_${'界'.repeat(12_000)}_MIDDLE_${'z'.repeat(20_000)}_TAIL`;
    const materialized = await store.materialize(full);
    const reference = getUserPromptArtifactReference(materialized.metadata);

    expect(materialized.offloaded).toBe(true);
    expect(reference).toMatchObject({
      version: 1,
      id: expect.stringMatching(/^[a-f0-9]{64}$/),
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      sizeBytes: Buffer.byteLength(full),
      textChars: full.length,
    });
    expect(Buffer.byteLength(String(materialized.content))).toBeLessThanOrEqual(
      MAX_INLINE_USER_MESSAGE_TEXT_BYTES
    );
    expect(String(materialized.content)).toContain('HEAD_');
    expect(String(materialized.content)).toContain('_TAIL');
    expect(String(materialized.content)).not.toContain('_MIDDLE_');
    expect(String(materialized.content)).toContain('ReadPromptArtifact');

    let restored = '';
    let offset = 0;
    while (offset < reference!.sizeBytes) {
      const chunk = await store.read(
        reference!.id,
        offset,
        MAX_USER_PROMPT_ARTIFACT_READ_BYTES
      );
      restored += chunk.content;
      const nextOffset = chunk.nextOffset ?? reference!.sizeBytes;
      expect(nextOffset).toBeGreaterThan(offset);
      offset = nextOffset;
    }
    expect(restored).toBe(full);
    await expect(store.read(reference!.id, 6, 4)).resolves.toMatchObject({
      offset: 5,
      returnedBytes: 3,
      content: '界',
      nextOffset: 8,
    });
    await expect(
      store.restore(materialized.content, materialized.metadata)
    ).resolves.toBe(full);

    const artifactFiles = readdirSync(storageRoot, {
      recursive: true,
      withFileTypes: true,
    }).filter((entry) => entry.isFile());
    expect(artifactFiles).toHaveLength(1);
    const artifactPath = path.join(
      artifactFiles[0]!.parentPath,
      artifactFiles[0]!.name
    );
    if (process.platform !== 'win32') {
      expect(statSync(artifactPath).mode & 0o777).toBe(0o600);
      expect(statSync(path.dirname(artifactPath)).mode & 0o777).toBe(0o700);
    }
  });

  it('stores remote prompt artifacts below the authorized host state root', async () => {
    const descriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('C:\\Remote\\Blade')
    );
    const hostStateRoot = deriveAcpRemoteHostStateRoot(descriptor.collisionIdentity);
    const remoteStorage = createRemoteSessionStateStorage(hostStateRoot, descriptor);
    await ensureAcpRemoteHostStateRoot(hostStateRoot);
    const remoteStore = new UserPromptArtifactStore(
      hostStateRoot,
      'remote-prompt-session',
      { storageRoot: hostStateRoot, stateStorage: remoteStorage }
    );
    const full = `${'remote'.repeat(8_000)}_TAIL`;

    const materialized = await remoteStore.materialize(full);
    const reference = getUserPromptArtifactReference(materialized.metadata)!;
    await expect(
      remoteStore.read(reference.id, 0, MAX_USER_PROMPT_ARTIFACT_READ_BYTES)
    ).resolves.toMatchObject({
      content: full,
    });

    const artifactFiles = readdirSync(hostStateRoot, {
      recursive: true,
      withFileTypes: true,
    }).filter((entry) => entry.isFile() && entry.name.endsWith('.txt'));
    expect(artifactFiles).toHaveLength(1);
    expect(artifactFiles[0]!.parentPath).toContain(
      path.join(hostStateRoot, 'prompt-artifacts')
    );
    expect(existsSync(path.join(storageRoot, 'projects'))).toBe(false);
  });

  it('revalidates the remote state scope before prompt artifact I/O', async () => {
    if (process.platform === 'win32') return;

    const descriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile('/remote/blade')
    );
    const hostStateRoot = deriveAcpRemoteHostStateRoot(descriptor.collisionIdentity);
    const remoteStorage = createRemoteSessionStateStorage(hostStateRoot, descriptor);
    await ensureAcpRemoteHostStateRoot(hostStateRoot);
    const remoteStore = new UserPromptArtifactStore(
      hostStateRoot,
      'remote-prompt-gate',
      { storageRoot: hostStateRoot, stateStorage: remoteStorage }
    );
    const materialized = await remoteStore.materialize(`${'guard'.repeat(8_000)}_TAIL`);
    const reference = getUserPromptArtifactReference(materialized.metadata)!;

    chmodSync(hostStateRoot, 0o755);
    await expect(remoteStore.read(reference.id)).rejects.toThrow(
      'Prompt artifact is unavailable or invalid'
    );
    await expect(remoteStore.removeAll()).rejects.toThrow(
      'Prompt artifact cleanup failed'
    );
    chmodSync(hostStateRoot, 0o700);
  });

  it('preserves inline images while offloading the complete text sequence', async () => {
    const head = 'a'.repeat(MAX_INLINE_USER_MESSAGE_TEXT_BYTES);
    const content = [
      {
        type: 'image_url' as const,
        image_url: { url: 'data:image/png;base64,first' },
      },
      { type: 'text' as const, text: head },
      {
        type: 'image_url' as const,
        image_url: { url: 'data:image/png;base64,second' },
      },
      { type: 'text' as const, text: 'TAIL_REQUIREMENT' },
    ];
    const materialized = await store.materialize(content);
    expect(Array.isArray(materialized.content)).toBe(true);
    const projected = materialized.content as typeof content;
    expect(projected[0]).toEqual(content[0]);
    expect(projected.filter((part) => part.type === 'image_url')).toEqual([
      content[0],
      content[2],
    ]);
    expect(
      projected.findIndex(
        (part) =>
          part.type === 'image_url' &&
          part.image_url.url === 'data:image/png;base64,second'
      )
    ).toBeGreaterThan(
      projected.findIndex(
        (part) =>
          part.type === 'text' && part.text.includes('read the private prompt artifact')
      )
    );
    const restored = await store.restore(materialized.content, materialized.metadata);
    expect(restored).toEqual(content);
  });

  it('fails closed for oversized, missing, and tampered artifacts', async () => {
    await expect(
      store.materialize('x'.repeat(MAX_USER_MESSAGE_TEXT_CHARS + 1))
    ).rejects.toThrow('character durable input limit');
    await expect(
      store.materialize('x'.repeat(MAX_USER_MESSAGE_TEXT_BYTES + 1))
    ).rejects.toThrow('durable input limit');
    await expect(store.read('0'.repeat(64))).rejects.toThrow(
      'Prompt artifact is unavailable or invalid'
    );

    const full = `${'x'.repeat(MAX_INLINE_USER_MESSAGE_TEXT_BYTES)}tail`;
    const materialized = await store.materialize(full);
    const reference = getUserPromptArtifactReference(materialized.metadata)!;
    const artifactFiles = readdirSync(storageRoot, {
      recursive: true,
      withFileTypes: true,
    }).filter((entry) => entry.isFile());
    const artifactPath = path.join(
      artifactFiles[0]!.parentPath,
      artifactFiles[0]!.name
    );
    writeFileSync(artifactPath, 'tampered', { mode: 0o600 });

    await expect(store.read(reference.id)).rejects.toThrow(
      'Prompt artifact content hash does not match its identity'
    );
    await expect(
      store.restore(materialized.content, materialized.metadata)
    ).rejects.toThrow();
  });

  it('preserves only a retryable errno when sanitizing artifact failures', async () => {
    const readVerified = vi
      .spyOn(
        store as unknown as {
          readVerified(id: string, expectedSize?: number): Promise<Buffer>;
        },
        'readVerified'
      )
      .mockRejectedValueOnce(
        Object.assign(new Error(`EMFILE: ${storageRoot}/private.txt`), {
          code: 'EMFILE',
        })
      );

    await expect(store.read('0'.repeat(64))).rejects.toMatchObject({
      message: 'Prompt artifact is unavailable or invalid',
      code: 'EMFILE',
    });
    expect(readVerified).toHaveBeenCalledOnce();
  });

  it('does not retain a rejected initialization attempt', async () => {
    const internals = store as unknown as {
      initialize(): Promise<void>;
      scan(): Promise<void>;
    };
    const scan = vi
      .spyOn(internals, 'scan')
      .mockRejectedValueOnce(
        Object.assign(new Error('resource temporarily unavailable'), {
          code: 'EAGAIN',
        })
      )
      .mockResolvedValueOnce();

    await expect(internals.initialize()).rejects.toMatchObject({ code: 'EAGAIN' });
    await expect(internals.initialize()).resolves.toBeUndefined();
    expect(scan).toHaveBeenCalledTimes(2);
  });

  it('rejects malformed artifact metadata instead of treating a preview as complete', async () => {
    const metadata = {
      userPromptArtifact: {
        version: 1,
        id: 'not-an-artifact-id',
      },
    };

    await expect(store.materialize('bounded preview', metadata)).rejects.toThrow(
      'reference is invalid'
    );
    await expect(store.restore('bounded preview', metadata)).rejects.toThrow(
      'reference is invalid'
    );
    expect(() => collectUserPromptArtifactIds([metadata])).toThrow(
      'reference is invalid'
    );
  });

  it('copies only referenced artifacts into a fork and removes them on cleanup', async () => {
    const first = await store.materialize(`${'first'.repeat(7_000)}_FIRST_ARTIFACT`);
    await store.materialize(`${'second'.repeat(7_000)}_SECOND_ARTIFACT`);
    const firstReference = getUserPromptArtifactReference(first.metadata)!;
    const target = new UserPromptArtifactStore(workspaceRoot, 'session-2', {
      storageRoot,
    });

    await store.copyReferencedTo(
      collectUserPromptArtifactIds([first.metadata, first.metadata]),
      target
    );
    await expect(target.restore(first.content, first.metadata)).resolves.toContain(
      '_FIRST_ARTIFACT'
    );
    await expect(target.read('f'.repeat(64))).rejects.toThrow();

    await target.removeAll();
    await expect(target.read(firstReference.id)).rejects.toThrow();
  });

  it('serializes concurrent writes and enforces the per-Session artifact quota', async () => {
    const prompts = Array.from(
      { length: MAX_USER_PROMPT_ARTIFACTS_PER_SESSION + 1 },
      (_, index) =>
        `${String(index).padStart(3, '0')}:${'x'.repeat(
          MAX_INLINE_USER_MESSAGE_TEXT_BYTES
        )}`
    );

    const results = await Promise.allSettled(
      prompts.map((prompt) => store.materialize(prompt))
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(
      MAX_USER_PROMPT_ARTIFACTS_PER_SESSION
    );
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    await expect(store.materialize(prompts[0]!)).resolves.toMatchObject({
      offloaded: true,
    });
  });
});
