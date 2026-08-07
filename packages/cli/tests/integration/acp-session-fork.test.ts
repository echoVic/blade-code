import * as acp from '@agentclientprotocol/sdk';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BladeAgent } from '../../src/acp/BladeAgent.js';
import { SessionService } from '../../src/services/SessionService.js';

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

function createHarness(): PairedAcpHarness {
  const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
  const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
  const client = new DeterministicClient();
  let agent: BladeAgent | undefined;

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

  return {
    agent,
    clientConnection,
    close: async () => {
      let firstError: unknown;
      try {
        await agent?.destroy();
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
    },
  };
}

describe('ACP session list and durable fork NDJSON integration', () => {
  let previousStorageRoot: string | undefined;
  let fixtureRoot: string;
  let workspaceA: string;
  let workspaceB: string;
  let harness: PairedAcpHarness;

  beforeEach(async () => {
    previousStorageRoot = process.env.BLADE_STORAGE_ROOT;
    fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'blade-acp-fork-'));
    workspaceA = await mkdtemp(path.join(fixtureRoot, 'workspace-a-'));
    workspaceB = await mkdtemp(path.join(fixtureRoot, 'workspace-b-'));
    process.env.BLADE_STORAGE_ROOT = path.join(fixtureRoot, 'storage');
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
});
