import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import { findSessionTranscript } from '../integration/real-api/sessionForkTrajectoryHarness.js';
import { ChildBackedRecordingAcpClient } from './acp/ChildBackedRecordingAcpClient.js';
import { createBladeAcpChildHarness } from './acp/createBladeAcpChildHarness.js';
import { waitForCondition as waitFor } from './asyncTestUtils.js';
import {
  driveToolAdmissionFixture,
  TOOL_ADMISSION_CALL_IDS,
  waitForToolAdmissionSessionCompletion,
} from './toolAdmissionFixtureDriver.js';

interface RunnerInput {
  cliEntry: string;
  workspace: string;
  home: string;
  storageRoot: string;
  stateDir: string;
  prompt: string;
  marker: string;
  secret: string;
}

function loadInput(): RunnerInput {
  const encoded = process.env.BLADE_TOOL_ADMISSION_ACP_INPUT;
  if (!encoded) throw new Error('Missing BLADE_TOOL_ADMISSION_ACP_INPUT');
  return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as RunnerInput;
}

async function releaseAll(stateDir: string): Promise<void> {
  const releaseDir = path.join(stateDir, 'release');
  await mkdir(releaseDir, { recursive: true });
  await Promise.all(
    TOOL_ADMISSION_CALL_IDS.map((callId) =>
      writeFile(path.join(releaseDir, callId), 'release')
    )
  );
}

async function run(input: RunnerInput) {
  const client = new ChildBackedRecordingAcpClient();
  const harness = createBladeAcpChildHarness({
    ...input,
    client,
    stderrLimit: 32_000,
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
      prompt: [{ type: 'text', text: input.prompt }],
    });
    const drive = driveToolAdmissionFixture({
      storageRoot: input.storageRoot,
      sessionId,
      stateDir: input.stateDir,
      waitForQueuedEvidence: () =>
        waitFor(
          () =>
            JSON.stringify(client.sessionUpdates).split(
              'Waiting for tool execution capacity'
            ).length -
              1 >=
            2,
          'ACP did not project two queued tool calls',
          90_000
        ),
    });
    await Promise.race([
      drive,
      prompt.then((result) => {
        throw new Error(
          `ACP prompt ended before the admission barrier completed: ${result.stopReason}`
        );
      }),
    ]);
    const result = await prompt;
    if (result.stopReason !== 'end_turn') {
      throw new Error(`Unexpected ACP stop reason: ${result.stopReason}`);
    }
    await waitForToolAdmissionSessionCompletion(
      input.storageRoot,
      sessionId,
      input.marker
    );
    const transcript = await readFile(
      findSessionTranscript(input.storageRoot, sessionId),
      'utf8'
    );
    if (!transcript.includes(input.marker)) {
      throw new Error('ACP transcript did not contain the final admission marker');
    }
    const serializedUpdates = JSON.stringify(client.sessionUpdates);
    if (serializedUpdates.includes(input.secret)) {
      throw new Error('ACP admission traffic contained provider credentials');
    }

    const exit = await harness.shutdown();
    if (exit.signal || exit.code !== 0) {
      throw new Error(
        `ACP graceful exit was ${exit.code ?? exit.signal}: ${harness.stderr.replaceAll(
          input.secret,
          '[redacted]'
        )}`
      );
    }
    return {
      success: true,
      sessionId,
      output: serializedUpdates,
    };
  } finally {
    await releaseAll(input.stateDir).catch(() => undefined);
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
