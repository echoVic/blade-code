import { spawn } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import { findSessionTranscript } from '../integration/real-api/sessionForkTrajectoryHarness.js';
import { ChildBackedRecordingAcpClient } from './acp/ChildBackedRecordingAcpClient.js';
import { waitForCondition as waitFor, waitForChildExit } from './asyncTestUtils.js';

interface RunnerInput {
  scenario: keyof typeof SCENARIOS;
  cliEntry: string;
  workspace: string;
  home: string;
  storageRoot: string;
  barrierPath: string;
  primaryMarker: string;
  secondaryMarker: string;
  secret: string;
}

function loadInput(): RunnerInput {
  const encoded = process.env.BLADE_PROVIDER_ADMISSION_ACP_INPUT;
  if (!encoded) throw new Error('Missing BLADE_PROVIDER_ADMISSION_ACP_INPUT');
  return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as RunnerInput;
}

type PromptOutcome =
  | { kind: 'result'; result: acp.PromptResponse }
  | { kind: 'error'; error: unknown };

interface ScenarioContext {
  connection: acp.ClientSideConnection;
  input: RunnerInput;
  primary: acp.PromptResponse;
  secondary: PromptOutcome;
  secondarySessionId: string;
}

const SCENARIOS = {
  queued: {
    label: 'ACP Provider admission',
    secondaryPrompt: (input: RunnerInput) =>
      `Reply with exactly ${input.secondaryMarker} and no other text.`,
    matchesMetadata: (value: Record<string, unknown>) => value.phase === 'queued',
    metadataMessage: 'secondary Session did not project Provider admission queue',
    verify: async ({ primary, secondary }: ScenarioContext) => {
      if (
        primary.stopReason !== 'end_turn' ||
        secondary.kind !== 'result' ||
        secondary.result.stopReason !== 'end_turn'
      ) {
        const secondaryReason =
          secondary.kind === 'result' ? secondary.result.stopReason : 'rejected';
        throw new Error(
          `unexpected stop reasons: ${primary.stopReason}/${secondaryReason}`
        );
      }
    },
    requiresSecondaryMarker: true,
    secondaryRejected: false,
  },
  pending_bytes_rejected: {
    label: 'Weighted ACP admission',
    secondaryPrompt: (input: RunnerInput) =>
      `This request must be rejected before Provider traffic. ${input.secondaryMarker}`,
    matchesMetadata: (value: Record<string, unknown>) =>
      value.phase === 'rejected' &&
      value.resource === 'pending_bytes' &&
      value.reason === 'queue_full',
    metadataMessage: 'secondary Session did not project pending-byte rejection',
    verify: async ({
      connection,
      input,
      primary,
      secondary,
      secondarySessionId,
    }: ScenarioContext) => {
      if (primary.stopReason !== 'end_turn') {
        throw new Error(`unexpected primary stop reason: ${primary.stopReason}`);
      }
      if (secondary.kind !== 'error') {
        throw new Error(
          `secondary unexpectedly completed: ${secondary.result.stopReason}`
        );
      }
      await connection.loadSession({
        sessionId: secondarySessionId,
        cwd: input.workspace,
        mcpServers: [],
      });
      await new Promise((resolve) => setTimeout(resolve, 500));
    },
    requiresSecondaryMarker: false,
    secondaryRejected: true,
  },
} as const;

function agentText(client: ChildBackedRecordingAcpClient, sessionId: string): string {
  return client.sessionUpdates
    .filter((notification) => notification.sessionId === sessionId)
    .flatMap((notification) =>
      notification.update.sessionUpdate === 'agent_message_chunk' &&
      notification.update.content.type === 'text'
        ? [notification.update.content.text]
        : []
    )
    .join('');
}

function admissionMetadata(
  client: ChildBackedRecordingAcpClient,
  sessionId: string
): unknown[] {
  return client.sessionUpdates
    .filter(
      (notification) =>
        notification.sessionId === sessionId &&
        notification.update.sessionUpdate === 'session_info_update' &&
        Object.hasOwn(notification.update._meta ?? {}, 'blade/providerAdmission')
    )
    .map((notification) =>
      notification.update.sessionUpdate === 'session_info_update'
        ? (notification.update._meta?.['blade/providerAdmission'] ?? null)
        : null
    );
}

async function run(input: RunnerInput) {
  const scenario = SCENARIOS[input.scenario];
  if (!scenario) throw new Error(`Unknown admission scenario: ${input.scenario}`);
  const child = spawn(process.execPath, [input.cliEntry, '--acp'], {
    cwd: input.workspace,
    env: {
      ...process.env,
      HOME: input.home,
      BLADE_STORAGE_ROOT: input.storageRoot,
      BLADE_AUTO_MEMORY: '0',
      BLADE_TELEMETRY_DISABLED: '1',
      TERM: 'xterm-256color',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (!child.stdin || !child.stdout) {
    child.kill('SIGKILL');
    throw new Error(`${scenario.label} stdio was unavailable`);
  }
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer | string) => {
    stderr = `${stderr}${chunk.toString()}`.slice(-64_000);
  });
  const client = new ChildBackedRecordingAcpClient();
  const connection = new acp.ClientSideConnection(
    () => client,
    acp.ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>
    )
  );
  let primarySessionId = '';
  let secondarySessionId = '';
  try {
    await connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { terminal: true },
    });
    const primary = await connection.newSession({
      cwd: input.workspace,
      mcpServers: [],
    });
    primarySessionId = primary.sessionId;
    await connection.setSessionMode({
      sessionId: primarySessionId,
      modeId: 'yolo',
    });
    const primaryPrompt = connection.prompt({
      sessionId: primarySessionId,
      prompt: [
        {
          type: 'text',
          text: `Reply with exactly ${input.primaryMarker} and no other text.`,
        },
      ],
    });

    await waitFor(async () => {
      try {
        await access(input.barrierPath);
        return true;
      } catch {
        return false;
      }
    }, `${scenario.label} primary request did not reach the Provider hold barrier`);

    const secondary = await connection.newSession({
      cwd: input.workspace,
      mcpServers: [],
    });
    secondarySessionId = secondary.sessionId;
    await connection.setSessionMode({
      sessionId: secondarySessionId,
      modeId: 'yolo',
    });
    const secondaryPrompt = connection
      .prompt({
        sessionId: secondarySessionId,
        prompt: [{ type: 'text', text: scenario.secondaryPrompt(input) }],
      })
      .then(
        (result) => ({ kind: 'result' as const, result }),
        (error: unknown) => ({ kind: 'error' as const, error })
      );

    await waitFor(
      () =>
        admissionMetadata(client, secondarySessionId).some(
          (value) =>
            value !== null &&
            typeof value === 'object' &&
            !Array.isArray(value) &&
            scenario.matchesMetadata(value as Record<string, unknown>)
        ),
      `${scenario.label} ${scenario.metadataMessage}`
    );
    const [primaryResult, secondaryResult] = await Promise.all([
      primaryPrompt,
      secondaryPrompt,
    ]);
    await scenario.verify({
      connection,
      input,
      primary: primaryResult,
      secondary: secondaryResult,
      secondarySessionId,
    });

    const metadata = admissionMetadata(client, secondarySessionId);
    if (!metadata.includes(null)) {
      throw new Error(`${scenario.label} metadata was not cleared`);
    }
    const primaryText = agentText(client, primarySessionId);
    const secondaryText = agentText(client, secondarySessionId);
    if (
      !primaryText.includes(input.primaryMarker) ||
      (scenario.requiresSecondaryMarker &&
        !secondaryText.includes(input.secondaryMarker))
    ) {
      throw new Error(`${scenario.label} Sessions did not finish independently`);
    }
    if (
      primaryText.includes('providerAdmission') ||
      secondaryText.includes('providerAdmission')
    ) {
      throw new Error(`${scenario.label} metadata polluted assistant text`);
    }
    const [primaryTranscript, secondaryTranscript] = await Promise.all([
      readFile(findSessionTranscript(input.storageRoot, primarySessionId), 'utf8'),
      readFile(findSessionTranscript(input.storageRoot, secondarySessionId), 'utf8'),
    ]);
    const serialized = JSON.stringify(client.sessionUpdates);
    for (const value of [
      primaryText,
      secondaryText,
      primaryTranscript,
      secondaryTranscript,
      serialized,
    ]) {
      if (value.includes(input.secret)) {
        throw new Error(`${scenario.label} evidence exposed credentials`);
      }
    }

    child.kill('SIGTERM');
    const exit = await waitForChildExit(child);
    await connection.closed.catch(() => undefined);
    if (exit.signal || exit.code !== 0) {
      throw new Error(
        `${scenario.label} exited ${
          exit.code ?? exit.signal
        }: ${stderr.replaceAll(input.secret, '[redacted]')}`
      );
    }
    return {
      success: true,
      primarySessionId,
      secondarySessionId,
      metadata,
      secondaryRejected: scenario.secondaryRejected,
      output: serialized.slice(-256_000),
      processes: client.releasedProcesses,
    };
  } finally {
    await client.close().catch(() => undefined);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await waitForChildExit(child, 10_000).catch(() => undefined);
    }
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
