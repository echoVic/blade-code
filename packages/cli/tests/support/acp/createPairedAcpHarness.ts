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

export interface PairedAcpAppHarness {
  clientConnection: acp.ClientConnection;
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
    await settleWithin(writer.close());
  } catch {
    // The paired connection may have already closed this transport direction.
  } finally {
    writer.releaseLock();
  }
}

function isBenignCloseError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return (
    error.name === 'TypeError' ||
    /already closed|already-closing|lock|locked|close requested|stream is closed/i.test(
      error.message
    )
  );
}

async function settleWithin(promise: Promise<unknown>, timeoutMs = 50): Promise<void> {
  await Promise.race([
    promise.then(
      () => undefined,
      () => undefined
    ),
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      timer.unref?.();
    }),
  ]);
}

function createClosableHarness<
  TClientConnection extends { closed: Promise<unknown> },
>(input: {
  clientConnection: TClientConnection;
  agentConnection: acp.AgentSideConnection;
  clientToAgent: TransformStream<Uint8Array, Uint8Array>;
  agentToClient: TransformStream<Uint8Array, Uint8Array>;
  closeClientConnection?: () => void;
  getClientCloseError?: () => unknown;
}): {
  clientConnection: TClientConnection;
  agentConnection: acp.AgentSideConnection;
  close(): Promise<void>;
} {
  let closePromise: Promise<void> | undefined;

  return {
    clientConnection: input.clientConnection,
    agentConnection: input.agentConnection,
    close: () => {
      closePromise ??= (async () => {
        const closeError = input.getClientCloseError?.();
        input.closeClientConnection?.();
        await Promise.all([
          closeWriter(input.clientToAgent.writable),
          closeWriter(input.agentToClient.writable),
        ]);
        await Promise.all([
          settleWithin(input.clientConnection.closed),
          settleWithin(input.agentConnection.closed),
        ]);
        if (closeError !== undefined && !isBenignCloseError(closeError)) {
          throw closeError;
        }
      })();
      return closePromise;
    },
  };
}

export function closePairedAcpHarness(
  harness: PairedAcpHarness | PairedAcpAppHarness
): Promise<void> {
  return harness.close();
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
  return createClosableHarness({
    clientConnection,
    agentConnection,
    clientToAgent,
    agentToClient,
  });
}

export function createPairedAcpAppHarness(
  clientApp: acp.ClientApp
): PairedAcpAppHarness {
  const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
  const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
  const clientConnection = clientApp.connect(
    acp.ndJsonStream(clientToAgent.writable, agentToClient.readable)
  );
  const agentConnection = new acp.AgentSideConnection(
    () => new MinimalAgent(),
    acp.ndJsonStream(agentToClient.writable, clientToAgent.readable)
  );
  return createClosableHarness({
    clientConnection,
    agentConnection,
    clientToAgent,
    agentToClient,
    closeClientConnection: () => {
      clientConnection.close();
    },
    getClientCloseError: () => clientConnection.signal.reason,
  });
}
