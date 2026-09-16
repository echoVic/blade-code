import { readFile } from 'node:fs/promises';
import * as acp from '@agentclientprotocol/sdk';
import {
  finalAssistantText,
  findSessionTranscript,
  readSessionEvents,
} from '../integration/real-api/sessionForkTrajectoryHarness.js';
import { ChildBackedRecordingAcpClient } from './acp/ChildBackedRecordingAcpClient.js';
import { createBladeAcpChildHarness } from './acp/createBladeAcpChildHarness.js';
import { waitForCondition as waitFor } from './asyncTestUtils.js';

interface RunnerInput {
  cliEntry: string;
  workspace: string;
  home: string;
  storageRoot: string;
  prompt: string;
  marker: string;
  secondaryPrompt?: string;
  secondaryMarker?: string;
  secret: string;
  privateMarker?: string;
  expectRateLimitCooldown?: boolean;
  expectTurnActivity?: boolean;
}

function loadInput(): RunnerInput {
  const encoded = process.env.BLADE_FOREGROUND_PROVIDER_RECOVERY_ACP_INPUT;
  if (!encoded) {
    throw new Error('Missing BLADE_FOREGROUND_PROVIDER_RECOVERY_ACP_INPUT');
  }
  return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as RunnerInput;
}

async function run(input: RunnerInput) {
  const client = new ChildBackedRecordingAcpClient();
  const harness = createBladeAcpChildHarness({
    ...input,
    client,
    env: {
      BLADE_API_KEY: input.secret,
    },
    stdioError: 'ACP Provider recovery stdio was unavailable',
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
    const primaryPrompt = connection.prompt({
      sessionId,
      prompt: [{ type: 'text', text: input.prompt }],
    });
    let secondarySessionId: string | undefined;
    let secondarySubmittedAt: number | undefined;
    let secondaryPrompt: ReturnType<typeof connection.prompt> | undefined;
    if (input.secondaryPrompt && input.secondaryMarker) {
      await waitFor(
        () =>
          client.sessionUpdates.some(
            (notification) =>
              notification.sessionId === sessionId &&
              JSON.stringify(notification).includes('blade/providerCircuit') &&
              JSON.stringify(notification).includes('"phase":"waiting"')
          ),
        'Primary ACP Session did not open the shared Provider circuit'
      );
      const secondary = await connection.newSession({
        cwd: input.workspace,
        mcpServers: [],
      });
      secondarySessionId = secondary.sessionId;
      await connection.setSessionMode({
        sessionId: secondarySessionId,
        modeId: 'yolo',
      });
      secondarySubmittedAt = Date.now();
      secondaryPrompt = connection.prompt({
        sessionId: secondarySessionId,
        prompt: [{ type: 'text', text: input.secondaryPrompt }],
      });
    }
    const [result, secondaryResult] = await Promise.all([
      primaryPrompt,
      secondaryPrompt,
    ]);
    if (result.stopReason !== 'end_turn') {
      throw new Error(
        `Unexpected ACP Provider recovery stop reason: ${result.stopReason}`
      );
    }
    if (secondaryResult && secondaryResult.stopReason !== 'end_turn') {
      throw new Error(
        `Unexpected secondary ACP Provider recovery stop reason: ${secondaryResult.stopReason}`
      );
    }

    const transcript = await readFile(
      findSessionTranscript(input.storageRoot, sessionId),
      'utf8'
    );
    if (!transcript.includes(input.marker)) {
      throw new Error('ACP transcript did not contain the recovery marker');
    }
    let secondaryTranscript = '';
    if (secondarySessionId && input.secondaryMarker) {
      const secondaryTranscriptPath = findSessionTranscript(
        input.storageRoot,
        secondarySessionId
      );
      secondaryTranscript = await readFile(secondaryTranscriptPath, 'utf8');
      if (
        finalAssistantText(readSessionEvents(secondaryTranscriptPath)) !==
        input.secondaryMarker
      ) {
        throw new Error(
          'Secondary ACP transcript did not contain the shared circuit marker'
        );
      }
    }
    const output = JSON.stringify(client.sessionUpdates);
    if (
      !output.includes('blade/providerRetry') ||
      !output.includes('bounded_foreground') ||
      !output.includes('recovered')
    ) {
      throw new Error('ACP did not project bounded Provider recovery metadata');
    }
    const requiredRecoveryActivities = input.expectRateLimitCooldown
      ? ['\"activity\":\"circuit_open\"', '\"activity\":\"circuit_probe\"']
      : ['\"activity\":\"retry_attempt\"', '\"activity\":\"circuit_open\"'];
    if (
      !output.includes('blade/providerRecovery') ||
      !output.includes('"generation"') ||
      !output.includes('"revision"') ||
      requiredRecoveryActivities.some((activity) => !output.includes(activity)) ||
      !output.includes('\"snapshot\":null')
    ) {
      throw new Error('ACP did not project unified Provider recovery metadata');
    }
    if (
      !output.includes('blade/providerCircuit') ||
      !output.includes('"phase":"waiting"') ||
      !output.includes('"phase":"probe"') ||
      !output.includes('"phase":"closed"')
    ) {
      throw new Error('ACP did not project shared Provider circuit metadata');
    }
    if (
      secondarySessionId &&
      !client.sessionUpdates.some(
        (notification) =>
          notification.sessionId === secondarySessionId &&
          JSON.stringify(notification).includes('blade/providerCircuit') &&
          JSON.stringify(notification).includes('"phase":"waiting"')
      )
    ) {
      throw new Error(
        'Secondary ACP Session did not wait on the shared Provider circuit'
      );
    }
    const activityUpdates = client.sessionUpdates.filter(
      (notification) =>
        notification.sessionId === sessionId &&
        notification.update._meta?.['blade/turnActivity'] !== undefined
    );
    const activityProjections = activityUpdates.flatMap((notification) => {
      const activity = notification.update._meta?.['blade/turnActivity'];
      return activity && typeof activity === 'object' && !Array.isArray(activity)
        ? [activity as { revision?: unknown; snapshot?: unknown }]
        : [];
    });
    const activityRevisions = activityProjections.flatMap((activity) =>
      typeof activity.revision === 'number' ? [activity.revision] : []
    );
    const activityRevisionsMonotonic = activityRevisions.every(
      (revision, index) => index === 0 || revision > activityRevisions[index - 1]!
    );
    const sawTurnActivity =
      activityProjections.some((activity) =>
        JSON.stringify(activity.snapshot).includes('executing_tools')
      ) && activityProjections.at(-1)?.snapshot === null;
    if (
      input.expectRateLimitCooldown &&
      (!output.includes('\"reason\":\"rate_limit\"') ||
        !output.includes('\"statusCode\":429'))
    ) {
      throw new Error('ACP did not project the authoritative rate-limit cooldown');
    }
    if (input.expectTurnActivity && (!sawTurnActivity || !activityRevisionsMonotonic)) {
      throw new Error('ACP did not project monotonic tool activity and terminal clear');
    }
    if (
      output.includes(input.secret) ||
      transcript.includes(input.secret) ||
      secondaryTranscript.includes(input.secret) ||
      (input.privateMarker !== undefined &&
        `${output}\n${transcript}\n${secondaryTranscript}`.includes(
          input.privateMarker
        ))
    ) {
      throw new Error('ACP Provider recovery evidence contained private data');
    }
    if (client.activeTerminalCount() !== 0) {
      throw new Error('ACP Provider recovery left an active terminal');
    }

    const exit = await harness.shutdown();
    if (exit.signal || exit.code !== 0) {
      throw new Error(
        `ACP Provider recovery exited ${
          exit.code ?? exit.signal
        }: ${harness.stderr.replaceAll(input.secret, '[redacted]')}`
      );
    }
    return {
      success: true,
      sessionId,
      secondarySessionId,
      secondarySubmittedAt,
      providerProbeCount: client.sessionUpdates.filter(
        (notification) =>
          JSON.stringify(notification).includes('blade/providerCircuit') &&
          JSON.stringify(notification).includes('"phase":"probe"')
      ).length,
      sawProviderRecovery: output.includes('blade/providerRecovery'),
      sawRateLimitCooldown: output.includes('\"reason\":\"rate_limit\"'),
      sawTurnActivity,
      activityRevisionsMonotonic,
      turnActivityTerminalClearSeen: activityProjections.at(-1)?.snapshot === null,
      output: output.slice(-256_000),
      terminalReleaseCount: [...client.releaseCounts.values()].reduce(
        (sum, count) => sum + count,
        0
      ),
      processes: client.releasedProcesses,
    };
  } catch (error) {
    const diagnostic =
      `${error instanceof Error ? error.message : String(error)}; ` +
      `updates=${JSON.stringify(client.sessionUpdates).slice(-16_000)}; ` +
      `stderr=${harness.stderr.slice(-8_000)}`;
    throw new Error(
      diagnostic
        .replaceAll(input.secret, '[redacted]')
        .replaceAll(
          input.privateMarker ?? '__NO_PRIVATE_MARKER_CONFIGURED__',
          '[redacted]'
        )
    );
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
        error: (error instanceof Error ? error.message : String(error))
          .replaceAll(input.secret, '[redacted]')
          .replaceAll(
            input.privateMarker ?? '__NO_PRIVATE_MARKER_CONFIGURED__',
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
