import * as acp from '@agentclientprotocol/sdk';
import { ChildBackedRecordingAcpClient } from './acp/ChildBackedRecordingAcpClient.js';
import { createBladeAcpChildHarness } from './acp/createBladeAcpChildHarness.js';
import { waitForCondition as waitFor } from './asyncTestUtils.js';

interface RunnerInput {
  cliEntry: string;
  workspace: string;
  home: string;
  storageRoot: string;
  sessionId: string;
  secret: string;
}

function loadInput(): RunnerInput {
  const encoded = process.env.BLADE_GOAL_HOST_FAILURE_ACP_INPUT;
  if (!encoded) throw new Error('Missing BLADE_GOAL_HOST_FAILURE_ACP_INPUT');
  delete process.env.BLADE_GOAL_HOST_FAILURE_ACP_INPUT;
  return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as RunnerInput;
}

function goalMetadata(client: ChildBackedRecordingAcpClient) {
  return client.sessionUpdates.flatMap((notification) => {
    const metadata = notification.update._meta?.['blade/goal'];
    return metadata && typeof metadata === 'object' && !Array.isArray(metadata)
      ? [metadata as Record<string, unknown>]
      : [];
  });
}

async function main(): Promise<void> {
  const input = loadInput();
  const client = new ChildBackedRecordingAcpClient();
  const harness = createBladeAcpChildHarness({
    ...input,
    client,
    env: {
      BLADE_VERSION: '999.0.0',
      BLADE_API_KEY: input.secret,
    },
    stdioError: 'Goal host failure ACP stdio is unavailable',
  });
  const { connection } = harness;

  try {
    await connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { terminal: true },
    });
    await connection.loadSession({
      sessionId: input.sessionId,
      cwd: input.workspace,
      mcpServers: [],
    });
    await waitFor(
      () => goalMetadata(client).some((goal) => goal.status === 'blocked'),
      'ACP did not observe the blocked Goal'
    );
    const goals = goalMetadata(client);
    const serialized = JSON.stringify(client.sessionUpdates);
    if (serialized.includes(input.secret)) {
      throw new Error('ACP goal host failure projection leaked a credential');
    }
    if (client.activeTerminalCount() !== 0) {
      throw new Error('ACP goal host failure left an active terminal');
    }

    const exit = await harness.shutdown('SIGTERM', 10_000);
    if (exit.signal || exit.code !== 0) {
      throw new Error(
        `Goal host failure ACP exited ${
          exit.code ?? exit.signal
        }: ${harness.stderr.replaceAll(input.secret, '[redacted]')}`
      );
    }
    process.stdout.write(
      JSON.stringify({
        success: true,
        sessionId: input.sessionId,
        counts: goals.flatMap((goal) => {
          const failure = goal.executionHostFailure;
          return failure && typeof failure === 'object' && !Array.isArray(failure)
            ? [(failure as { consecutiveCount?: unknown }).consecutiveCount]
            : [];
        }),
        blocked: goals.some((goal) => goal.status === 'blocked'),
        continuations: client.sessionUpdates.filter(
          (notification) =>
            notification.update._meta?.['blade/goalContinuation'] !== undefined
        ).length,
        terminalReleaseCount: [...client.releaseCounts.values()].reduce(
          (sum, count) => sum + count,
          0
        ),
      })
    );
  } catch (error) {
    process.stdout.write(
      JSON.stringify({
        success: false,
        error: (error instanceof Error ? error.message : String(error)).replaceAll(
          input.secret,
          '[redacted]'
        ),
      })
    );
    process.exitCode = 1;
  } finally {
    await harness.close();
  }
}

if (import.meta.main) await main();
