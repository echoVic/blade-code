import { readFile } from 'node:fs/promises';
import * as acp from '@agentclientprotocol/sdk';
import { findSessionTranscript } from '../integration/real-api/sessionForkTrajectoryHarness.js';
import { ChildBackedRecordingAcpClient } from './acp/ChildBackedRecordingAcpClient.js';
import { createBladeAcpChildHarness } from './acp/createBladeAcpChildHarness.js';
import { waitForCondition as waitFor } from './asyncTestUtils.js';
import {
  driveForegroundCommandHandoffFixture,
  type ForegroundCommandHandoffFixture,
  releaseForegroundCommandHandoffFixture,
} from './foregroundCommandHandoffFixtureDriver.js';

interface RunnerInput {
  cliEntry: string;
  workspace: string;
  home: string;
  storageRoot: string;
  fixture: ForegroundCommandHandoffFixture;
  secret: string;
}

function loadInput(): RunnerInput {
  const encoded = process.env.BLADE_FOREGROUND_HANDOFF_ACP_INPUT;
  if (!encoded) throw new Error('Missing BLADE_FOREGROUND_HANDOFF_ACP_INPUT');
  return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as RunnerInput;
}

async function run(input: RunnerInput) {
  const client = new ChildBackedRecordingAcpClient();
  const harness = createBladeAcpChildHarness({
    ...input,
    client,
    stderrLimit: 32_000,
    stdioError: 'ACP handoff child stdio was unavailable',
  });
  const { connection } = harness;
  let sessionId = '';
  try {
    await connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { terminal: true },
    });
    const created = await connection.newSession({
      cwd: input.workspace,
      mcpServers: [],
    });
    sessionId = created.sessionId;
    await connection.setSessionMode({ sessionId, modeId: 'yolo' });
    const prompt = connection.prompt({
      sessionId,
      prompt: [{ type: 'text', text: input.fixture.prompt }],
    });
    const drive = driveForegroundCommandHandoffFixture({
      storageRoot: input.storageRoot,
      sessionId,
      fixture: input.fixture,
      waitForSurfaceHandoff: async (shellId) => {
        await waitFor(
          () => {
            const serialized = JSON.stringify(client.sessionUpdates);
            return (
              serialized.includes(shellId) &&
              serialized.toLowerCase().includes('background')
            );
          },
          'ACP did not project the foreground handoff result',
          90_000
        );
        if (client.releaseCounts.size !== 0) {
          throw new Error('ACP terminal was released before host barrier completion');
        }
      },
    });
    const [result] = await Promise.all([prompt, drive]);
    if (result.stopReason !== 'end_turn') {
      throw new Error(`Unexpected ACP handoff stop reason: ${result.stopReason}`);
    }
    const transcript = await readFile(
      findSessionTranscript(input.storageRoot, sessionId),
      'utf8'
    );
    if (!transcript.includes(input.fixture.marker)) {
      throw new Error('ACP transcript did not contain the handoff marker');
    }
    const terminalReleaseCount = [...client.releaseCounts.values()].reduce(
      (sum, count) => sum + count,
      0
    );
    if (terminalReleaseCount !== 1 || client.activeTerminalCount() !== 0) {
      throw new Error('ACP handoff terminal was not released exactly once');
    }
    const serializedUpdates = JSON.stringify(client.sessionUpdates);
    if (serializedUpdates.includes(input.secret)) {
      throw new Error('ACP handoff traffic contained provider credentials');
    }

    const exit = await harness.shutdown();
    if (exit.signal || exit.code !== 0) {
      throw new Error(
        `ACP handoff graceful exit was ${
          exit.code ?? exit.signal
        }: ${harness.stderr.replaceAll(input.secret, '[redacted]')}`
      );
    }
    return {
      success: true,
      sessionId,
      output: serializedUpdates.slice(-128_000),
      terminalReleaseCount,
      processes: client.releasedProcesses,
    };
  } finally {
    await releaseForegroundCommandHandoffFixture(input.fixture).catch(() => undefined);
    await harness.close();
  }
}

async function main(): Promise<void> {
  const input = loadInput();
  try {
    process.stdout.write(JSON.stringify(await run(input)));
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
  }
}

if (import.meta.main) {
  await main();
}
