import { readFile, writeFile } from 'node:fs/promises';
import * as acp from '@agentclientprotocol/sdk';
import { findSessionTranscript } from '../integration/real-api/sessionForkTrajectoryHarness.js';
import { ChildBackedRecordingAcpClient } from './acp/ChildBackedRecordingAcpClient.js';
import { createBladeAcpChildHarness } from './acp/createBladeAcpChildHarness.js';
import { waitForCondition as waitFor } from './asyncTestUtils.js';

interface RunnerInput {
  cliEntry: string;
  workspace: string;
  home: string;
  storageRoot: string;
  providerHoldPath: string;
  providerReleasePath: string;
  primaryMarker: string;
  rejectedMarker: string;
  queuedMarker: string;
  secret: string;
}

function loadInput(): RunnerInput {
  const encoded = process.env.BLADE_WEIGHTED_TASK_ACP_INPUT;
  if (!encoded) throw new Error('Missing BLADE_WEIGHTED_TASK_ACP_INPUT');
  return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as RunnerInput;
}

function taskMetadata(
  client: ChildBackedRecordingAcpClient,
  sessionId: string
): Array<Record<string, unknown>> {
  return client.sessionUpdates
    .filter(
      (notification) =>
        notification.sessionId === sessionId &&
        notification.update.sessionUpdate === 'session_info_update'
    )
    .flatMap((notification) =>
      notification.update.sessionUpdate === 'session_info_update' &&
      notification.update._meta
        ? [notification.update._meta as Record<string, unknown>]
        : []
    );
}

async function newTaskSession(
  connection: acp.ClientSideConnection,
  workspace: string,
  label: string
): Promise<string> {
  const session = await connection.newSession({
    cwd: workspace,
    mcpServers: [],
    _meta: {
      'blade/taskIsolation': 'local',
      'blade/taskPrompt': label,
    },
  });
  await connection.setSessionMode({
    sessionId: session.sessionId,
    modeId: 'yolo',
  });
  return session.sessionId;
}

function prompt(connection: acp.ClientSideConnection, sessionId: string, text: string) {
  return connection.prompt({
    sessionId,
    prompt: [{ type: 'text', text }],
  });
}

async function run(input: RunnerInput) {
  const client = new ChildBackedRecordingAcpClient();
  const harness = createBladeAcpChildHarness({
    ...input,
    client,
    stdioError: 'Weighted task ACP stdio was unavailable',
  });
  const { connection } = harness;
  let primarySessionId = '';
  let rejectedSessionId = '';
  let queuedSessionId = '';
  try {
    await connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { terminal: true },
    });
    primarySessionId = await newTaskSession(
      connection,
      input.workspace,
      'Weighted task primary control'
    );
    const primaryPrompt = prompt(
      connection,
      primarySessionId,
      `Reply with exactly ${input.primaryMarker} and no other text.`
    );

    await waitFor(async () => {
      try {
        await readFile(input.providerHoldPath);
        return true;
      } catch {
        return false;
      }
    }, 'Weighted task ACP primary request did not reach Provider hold');

    rejectedSessionId = await newTaskSession(
      connection,
      input.workspace,
      'Weighted task rejected control'
    );
    const rejectedOutcome = prompt(
      connection,
      rejectedSessionId,
      `${input.rejectedMarker} ${'界'.repeat(30_000)}`
    ).then(
      (result) => ({ kind: 'result' as const, result }),
      (error: unknown) => ({ kind: 'error' as const, error })
    );
    await waitFor(
      () =>
        taskMetadata(client, rejectedSessionId).some((metadata) => {
          const failure = metadata['blade/taskFailure'];
          return (
            metadata['blade/taskStatus'] === 'failed' &&
            failure !== null &&
            typeof failure === 'object' &&
            !Array.isArray(failure) &&
            (failure as Record<string, unknown>).code === 'capacity' &&
            (failure as Record<string, unknown>).resource === 'pending_bytes'
          );
        }),
      'Weighted task ACP did not project capacity/pending_bytes'
    );

    queuedSessionId = await newTaskSession(
      connection,
      input.workspace,
      'Weighted task queued control'
    );
    const queuedPrompt = prompt(
      connection,
      queuedSessionId,
      `Reply with exactly ${input.queuedMarker} and no other text.`
    );
    await waitFor(
      () =>
        taskMetadata(client, queuedSessionId).some(
          (metadata) =>
            metadata['blade/taskStatus'] === 'queued' &&
            metadata['blade/taskQueuePosition'] === 1
        ),
      'Weighted task ACP normal control did not queue'
    );
    await writeFile(input.providerReleasePath, 'release\n');

    const [primaryResult, rejectedResult, queuedResult] = await Promise.all([
      primaryPrompt,
      rejectedOutcome,
      queuedPrompt,
    ]);
    if (
      primaryResult.stopReason !== 'end_turn' ||
      queuedResult.stopReason !== 'end_turn'
    ) {
      throw new Error(
        `Unexpected weighted task ACP stop reasons: ${primaryResult.stopReason}/${queuedResult.stopReason}`
      );
    }
    if (rejectedResult.kind !== 'error') {
      throw new Error(
        `Weighted task ACP rejected prompt completed: ${rejectedResult.result.stopReason}`
      );
    }

    const listed = await connection.listSessions({
      cwd: input.workspace,
    });
    const rejectedListItem = listed.sessions.find(
      (session) => session.sessionId === rejectedSessionId
    );
    const listedFailure = rejectedListItem?._meta?.['blade/taskFailure'];
    if (
      !listedFailure ||
      typeof listedFailure !== 'object' ||
      Array.isArray(listedFailure) ||
      (listedFailure as Record<string, unknown>).code !== 'capacity' ||
      (listedFailure as Record<string, unknown>).resource !== 'pending_bytes'
    ) {
      throw new Error('Weighted task ACP session/list lost capacity ownership');
    }

    const primaryText = client.agentText(primarySessionId);
    const rejectedText = client.agentText(rejectedSessionId);
    const queuedText = client.agentText(queuedSessionId);
    if (
      !primaryText.includes(input.primaryMarker) ||
      !queuedText.includes(input.queuedMarker)
    ) {
      throw new Error('Weighted task ACP controls did not finish independently');
    }
    if (rejectedText.includes(input.rejectedMarker)) {
      throw new Error('Weighted task ACP rejection polluted assistant text');
    }

    const [primaryTranscript, rejectedTranscript, queuedTranscript] = await Promise.all(
      [
        readFile(findSessionTranscript(input.storageRoot, primarySessionId), 'utf8'),
        readFile(findSessionTranscript(input.storageRoot, rejectedSessionId), 'utf8'),
        readFile(findSessionTranscript(input.storageRoot, queuedSessionId), 'utf8'),
      ]
    );
    const serialized = JSON.stringify(client.sessionUpdates);
    for (const value of [
      primaryText,
      rejectedText,
      queuedText,
      primaryTranscript,
      rejectedTranscript,
      queuedTranscript,
      serialized,
    ]) {
      if (value.includes(input.secret)) {
        throw new Error('Weighted task ACP evidence exposed credentials');
      }
    }
    if (
      primaryTranscript.includes(input.rejectedMarker) ||
      rejectedTranscript.includes(input.rejectedMarker) ||
      queuedTranscript.includes(input.rejectedMarker)
    ) {
      throw new Error('Weighted task ACP persisted the rejected prompt');
    }

    const exit = await harness.shutdown();
    if (exit.signal || exit.code !== 0) {
      throw new Error(
        `Weighted task ACP exited ${
          exit.code ?? exit.signal
        }: ${harness.stderr.replaceAll(input.secret, '[redacted]')}`
      );
    }
    return {
      success: true,
      primarySessionId,
      rejectedSessionId,
      queuedSessionId,
      rejectedMetadata: taskMetadata(client, rejectedSessionId),
      queuedMetadata: taskMetadata(client, queuedSessionId),
      rejectedPromptFailed: true,
      output: serialized.slice(-256_000),
      processes: client.releasedProcesses,
    };
  } finally {
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
