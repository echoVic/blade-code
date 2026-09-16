import type * as acp from '@agentclientprotocol/sdk';
import { BladeAgent } from '../../../src/acp/BladeAgent.js';
import { createPairedAcpHarness } from './createPairedAcpHarness.js';

export interface BladeAcpHarness<TClient extends acp.Client> {
  agent: BladeAgent;
  agentConnection: acp.AgentSideConnection;
  client: TClient;
  connection: acp.ClientSideConnection;
  close(): Promise<void>;
}

export interface BladeAcpHarnessOptions {
  prepareConnection?(connection: acp.AgentSideConnection): void;
  disposeClient?(): Promise<void>;
}

export function createBladeAcpHarness<TClient extends acp.Client>(
  client: TClient,
  options: BladeAcpHarnessOptions = {}
): BladeAcpHarness<TClient> {
  let bladeAgent: BladeAgent | undefined;
  const paired = createPairedAcpHarness(client, {
    createAgent: (connection) => {
      options.prepareConnection?.(connection);
      bladeAgent = new BladeAgent(connection);
      return bladeAgent;
    },
    disposeAgent: (agent) => agent.destroy(),
    disposeClient: options.disposeClient,
  });
  if (!bladeAgent) throw new Error('Blade ACP Agent was not created');
  return {
    agent: bladeAgent,
    agentConnection: paired.agentConnection,
    client,
    connection: paired.clientConnection,
    close: paired.close,
  };
}
