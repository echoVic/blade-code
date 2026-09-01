import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAcpRemotePathProfile } from '../../src/acp/AcpRemotePath.js';
import {
  createAcpRemoteWorkspaceDescriptor,
  deriveAcpRemoteHostStateRoot,
  withValidatedAcpRemoteStateScope,
} from '../../src/acp/AcpRemoteWorkspace.js';
import { BladeAgent } from '../../src/acp/BladeAgent.js';
import { JSONLStore } from '../../src/context/storage/JSONLStore.js';
import { getAcpRemoteSessionFilePath } from '../../src/context/storage/pathUtils.js';
import { SessionService } from '../../src/services/SessionService.js';
import { getState, vanillaStore } from '../../src/store/vanilla.js';
import { worktreeManager } from '../../src/worktree/WorktreeManager.js';
import { ControlledFileClient } from '../support/acp/ControlledFileClient.js';
import { createDefaultMockConfig } from '../support/mocks/mockConfig.js';

class DeterministicClient implements acp.Client {
  async requestPermission(
    _params: acp.RequestPermissionRequest
  ): Promise<acp.RequestPermissionResponse> {
    return { outcome: { outcome: 'cancelled' } };
  }

  async sessionUpdate(_params: acp.SessionNotification): Promise<void> {
    // This deterministic fixture does not issue prompts, so no updates are expected.
  }
}

interface PairedAcpHarness {
  agent: BladeAgent;
  clientConnection: acp.ClientSideConnection;
  close(): Promise<void>;
}

function createHarness(
  client: acp.Client = new DeterministicClient()
): PairedAcpHarness {
  const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
  const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
  let agent: BladeAgent | undefined;
  let closePromise: Promise<void> | undefined;

  const clientConnection = new acp.ClientSideConnection(
    () => client,
    acp.ndJsonStream(clientToAgent.writable, agentToClient.readable)
  );
  const agentConnection = new acp.AgentSideConnection(
    (connection) => {
      agent = new BladeAgent(connection);
      return agent;
    },
    acp.ndJsonStream(agentToClient.writable, clientToAgent.readable)
  );
  if (!agent) throw new Error('ACP Agent was not created');
  const createdAgent = agent;

  return {
    agent: createdAgent,
    clientConnection,
    close: () => {
      closePromise ??= (async () => {
        let firstError: unknown;
        try {
          await createdAgent.destroy();
        } catch (error) {
          firstError = error;
        }

        try {
          const clientWriter = clientToAgent.writable.getWriter();
          const agentWriter = agentToClient.writable.getWriter();
          try {
            await Promise.all([clientWriter.close(), agentWriter.close()]);
          } finally {
            clientWriter.releaseLock();
            agentWriter.releaseLock();
          }
          await Promise.all([clientConnection.closed, agentConnection.closed]);
        } catch (error) {
          firstError ??= error;
        }

        if (firstError !== undefined) throw firstError;
      })();
      return closePromise;
    },
  };
}

async function initializeRemote(harness: PairedAcpHarness): Promise<void> {
  await harness.clientConnection.initialize({
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: {
      fs: {
        readTextFile: true,
        writeTextFile: true,
      },
    },
  });
}

async function readRemoteEvents(hostStateRoot: string, sessionId: string) {
  return withValidatedAcpRemoteStateScope(hostStateRoot, async (scope) =>
    new JSONLStore(getAcpRemoteSessionFilePath(scope, sessionId)).readAll()
  );
}

describe('ACP session list and durable fork NDJSON integration', () => {
  let previousStorageRoot: string | undefined;
  let fixtureRoot: string;
  let storageRoot: string;
  let workspaceA: string;
  let workspaceB: string;
  let harness: PairedAcpHarness;
  let previousConfig: ReturnType<typeof getState>['config']['config'];
  let staleWorktreeCleanupSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    previousStorageRoot = process.env.BLADE_STORAGE_ROOT;
    previousConfig = getState().config.config;
    fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'blade-acp-fork-'));
    storageRoot = await mkdtemp(path.join(fixtureRoot, 'storage-'));
    workspaceA = await mkdtemp(path.join(fixtureRoot, 'workspace-a-'));
    workspaceB = await mkdtemp(path.join(fixtureRoot, 'workspace-b-'));
    process.env.BLADE_STORAGE_ROOT = storageRoot;
    getState().config.actions.setConfig(
      createDefaultMockConfig({
        agentTeamsEnabled: false,
        disableAllHooks: true,
        lspServers: {},
        mcpEnabled: false,
        mcpServers: {},
      })
    );
    staleWorktreeCleanupSpy = vi
      .spyOn(worktreeManager, 'cleanupStaleAgentWorktrees')
      .mockResolvedValue({
        scanned: 0,
        removed: 0,
        preserved: 0,
        skipped: 0,
        errors: [],
      });
    await SessionService.createSessionMetadata('source-session', workspaceA, {
      title: 'Source session',
    });
    harness = createHarness();

    await harness.clientConnection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
    });
  });

  afterEach(async () => {
    try {
      await harness.close();
    } finally {
      if (previousConfig) {
        getState().config.actions.setConfig(previousConfig);
      } else {
        vanillaStore.setState((state) => ({
          ...state,
          config: { ...state.config, config: null },
        }));
      }
      staleWorktreeCleanupSpy.mockRestore();
      if (previousStorageRoot === undefined) {
        delete process.env.BLADE_STORAGE_ROOT;
      } else {
        process.env.BLADE_STORAGE_ROOT = previousStorageRoot;
      }
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  async function expectValidListAfterFailure(): Promise<void> {
    const listed = await harness.clientConnection.listSessions({
      cwd: workspaceA,
    });
    expect(listed.sessions).toContainEqual(
      expect.objectContaining({
        sessionId: 'source-session',
        cwd: workspaceA,
        title: 'Source session',
      })
    );
  }

  it('keeps paired SDK connections usable after list and fork JSON-RPC errors', async () => {
    await expect(
      harness.clientConnection.listSessions({
        cwd: workspaceA,
        cursor: 'not-base64url-json',
      })
    ).rejects.toMatchObject({
      code: -32603,
      data: { details: 'Invalid session cursor' },
    });
    await expectValidListAfterFailure();

    await expect(
      harness.clientConnection.unstable_forkSession({
        sessionId: 'source-session',
        cwd: workspaceB,
        mcpServers: [],
      })
    ).rejects.toMatchObject({ code: -32603 });
    await expectValidListAfterFailure();

    await expect(
      harness.clientConnection.unstable_forkSession({
        sessionId: 'missing-session',
        cwd: workspaceA,
        mcpServers: [],
      })
    ).rejects.toMatchObject({ code: -32603 });
    await expectValidListAfterFailure();
  });

  it('keeps a Windows remote session durable across fresh ACP connections', async () => {
    await harness.close();

    const requestedCwd = 'c:/Repo/./Project';
    const profile = createAcpRemotePathProfile(requestedCwd);
    const descriptor = createAcpRemoteWorkspaceDescriptor(profile);
    const wirePath = descriptor.wirePath;
    const hostStateRoot = deriveAcpRemoteHostStateRoot(descriptor.collisionIdentity);

    const firstClient = new ControlledFileClient();
    const firstHarness = createHarness(firstClient);
    harness = firstHarness;
    await initializeRemote(firstHarness);

    const parent = await firstHarness.clientConnection.newSession({
      cwd: requestedCwd,
      mcpServers: [],
    });
    expect(parent._meta).toBeUndefined();
    expect(JSON.stringify(parent)).not.toContain(hostStateRoot);

    const parentEvents = await readRemoteEvents(hostStateRoot, parent.sessionId);
    const parentCreated = parentEvents[0];
    expect(parentCreated?.type).toBe('session_created');
    if (parentCreated?.type !== 'session_created') {
      throw new Error('Remote parent has no authoritative session_created event');
    }
    expect(parentCreated.cwd).toBe(hostStateRoot);
    expect(parentCreated.projectPath).toBe(hostStateRoot);
    expect(parentCreated.data.remoteWorkspace).toEqual(descriptor);

    await firstHarness.close();

    const secondClient = new ControlledFileClient();
    const secondHarness = createHarness(secondClient);
    harness = secondHarness;
    await initializeRemote(secondHarness);

    const listedBeforeLoad = await secondHarness.clientConnection.listSessions({
      cwd: wirePath,
    });
    expect(listedBeforeLoad.sessions).toContainEqual(
      expect.objectContaining({
        sessionId: parent.sessionId,
        cwd: wirePath,
      })
    );
    expect(listedBeforeLoad.sessions.some((item) => item.cwd === hostStateRoot)).toBe(
      false
    );

    await secondHarness.clientConnection.loadSession({
      sessionId: parent.sessionId,
      cwd: wirePath,
      mcpServers: [],
    });

    const collisionAlias = wirePath.toLowerCase();
    const aliasDescriptor = createAcpRemoteWorkspaceDescriptor(
      createAcpRemotePathProfile(collisionAlias)
    );
    expect(deriveAcpRemoteHostStateRoot(aliasDescriptor.collisionIdentity)).toBe(
      hostStateRoot
    );
    expect(aliasDescriptor.exactIdentity).not.toBe(descriptor.exactIdentity);

    await expect(
      secondHarness.clientConnection.loadSession({
        sessionId: parent.sessionId,
        cwd: collisionAlias,
        mcpServers: [],
      })
    ).rejects.toMatchObject({
      code: -32602,
      data: {
        code: 'acp_remote_workspace_mismatch',
        reason: 'exact-identity-mismatch',
      },
    });
    await expect(
      secondHarness.clientConnection.setSessionMode({
        sessionId: parent.sessionId,
        modeId: 'default',
      })
    ).resolves.toBeDefined();

    const child = await secondHarness.clientConnection.unstable_forkSession({
      sessionId: parent.sessionId,
      cwd: wirePath,
      mcpServers: [],
    });
    expect(child._meta).toBeUndefined();
    expect(JSON.stringify(child)).not.toContain(hostStateRoot);

    const childEvents = await readRemoteEvents(hostStateRoot, child.sessionId);
    const childCreated = childEvents[0];
    expect(childCreated?.type).toBe('session_created');
    if (childCreated?.type !== 'session_created') {
      throw new Error('Remote child has no authoritative session_created event');
    }
    expect(childCreated.cwd).toBe(hostStateRoot);
    expect(childCreated.projectPath).toBe(hostStateRoot);
    expect(childCreated.data.remoteWorkspace).toEqual(descriptor);
    expect(childCreated.data.parentId).toBe(parent.sessionId);

    const listedAfterFork = await secondHarness.clientConnection.listSessions({
      cwd: wirePath,
    });
    expect(listedAfterFork.sessions).toContainEqual(
      expect.objectContaining({ sessionId: parent.sessionId, cwd: wirePath })
    );
    expect(listedAfterFork.sessions).toContainEqual(
      expect.objectContaining({ sessionId: child.sessionId, cwd: wirePath })
    );
    expect(firstClient.requests).toEqual([]);
    expect(secondClient.requests).toEqual([]);
  });
});
