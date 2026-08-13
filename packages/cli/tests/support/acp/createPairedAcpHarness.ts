import * as acp from '@agentclientprotocol/sdk';

class MinimalAgent implements acp.Agent {
  async initialize(_params: acp.InitializeRequest): Promise<acp.InitializeResponse> {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {},
    };
  }

  async newSession(_params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
    return { sessionId: 'paired-harness-session' };
  }

  async authenticate(
    _params: acp.AuthenticateRequest
  ): Promise<acp.AuthenticateResponse> {
    // Authentication is intentionally unsupported by this harness agent.
    return {};
  }

  async prompt(_params: acp.PromptRequest): Promise<acp.PromptResponse> {
    return { stopReason: 'end_turn' };
  }

  async cancel(_params: acp.CancelNotification): Promise<void> {
    // The harness has no active prompt work to cancel.
  }
}

export interface PairedAcpHarness {
  clientConnection: acp.ClientSideConnection;
  agentConnection: acp.AgentSideConnection;
  close(): Promise<void>;
}

async function closeWriter(writable: WritableStream<Uint8Array>): Promise<void> {
  let writer: WritableStreamDefaultWriter<Uint8Array>;
  try {
    writer = writable.getWriter();
  } catch {
    return;
  }
  try {
    await writer.close();
  } catch {
    // The paired connection may have already closed this transport direction.
  } finally {
    writer.releaseLock();
  }
}

export function createPairedAcpHarness(client: acp.Client): PairedAcpHarness {
  const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
  const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
  const clientConnection = new acp.ClientSideConnection(
    () => client,
    acp.ndJsonStream(clientToAgent.writable, agentToClient.readable)
  );
  const agentConnection = new acp.AgentSideConnection(
    () => new MinimalAgent(),
    acp.ndJsonStream(agentToClient.writable, clientToAgent.readable)
  );
  let closePromise: Promise<void> | undefined;

  return {
    clientConnection,
    agentConnection,
    close: () => {
      closePromise ??= (async () => {
        await Promise.all([
          closeWriter(clientToAgent.writable),
          closeWriter(agentToClient.writable),
        ]);
        await Promise.all([
          clientConnection.closed.catch(() => undefined),
          agentConnection.closed.catch(() => undefined),
        ]);
      })();
      return closePromise;
    },
  };
}
