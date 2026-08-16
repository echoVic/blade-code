import { type ChildProcess, spawn } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import { findSessionTranscript } from '../integration/real-api/sessionForkTrajectoryHarness.js';
import { ChildBackedRecordingAcpClient } from './acp/ChildBackedRecordingAcpClient.js';

interface RunnerInput {
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

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs = 60_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

function waitForChildExit(
  child: ChildProcess,
  timeoutMs = 30_000
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('ACP Provider admission child did not exit'));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      child.off('error', onError);
      child.off('exit', onExit);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      resolve({ code, signal });
    };
    child.once('error', onError);
    child.once('exit', onExit);
  });
}

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
    throw new Error('ACP Provider admission stdio was unavailable');
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
    }, 'ACP primary request did not reach the Provider hold barrier');

    const secondary = await connection.newSession({
      cwd: input.workspace,
      mcpServers: [],
    });
    secondarySessionId = secondary.sessionId;
    await connection.setSessionMode({
      sessionId: secondarySessionId,
      modeId: 'yolo',
    });
    const secondaryPrompt = connection.prompt({
      sessionId: secondarySessionId,
      prompt: [
        {
          type: 'text',
          text: `Reply with exactly ${input.secondaryMarker} and no other text.`,
        },
      ],
    });

    await waitFor(
      () =>
        admissionMetadata(client, secondarySessionId).some(
          (value) =>
            value !== null &&
            typeof value === 'object' &&
            !Array.isArray(value) &&
            (value as Record<string, unknown>).phase === 'queued'
        ),
      'ACP secondary Session did not project Provider admission queue'
    );
    const [primaryResult, secondaryResult] = await Promise.all([
      primaryPrompt,
      secondaryPrompt,
    ]);
    if (
      primaryResult.stopReason !== 'end_turn' ||
      secondaryResult.stopReason !== 'end_turn'
    ) {
      throw new Error(
        `Unexpected ACP Provider admission stop reasons: ${primaryResult.stopReason}/${secondaryResult.stopReason}`
      );
    }

    const metadata = admissionMetadata(client, secondarySessionId);
    if (!metadata.includes(null)) {
      throw new Error('ACP Provider admission metadata was not cleared');
    }
    const primaryText = agentText(client, primarySessionId);
    const secondaryText = agentText(client, secondarySessionId);
    if (
      !primaryText.includes(input.primaryMarker) ||
      !secondaryText.includes(input.secondaryMarker)
    ) {
      throw new Error('ACP Provider admission Sessions did not finish independently');
    }
    if (
      primaryText.includes('providerAdmission') ||
      secondaryText.includes('providerAdmission')
    ) {
      throw new Error('ACP Provider admission metadata polluted assistant text');
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
        throw new Error('ACP Provider admission evidence exposed credentials');
      }
    }

    child.kill('SIGTERM');
    const exit = await waitForChildExit(child);
    await connection.closed.catch(() => undefined);
    if (exit.signal || exit.code !== 0) {
      throw new Error(
        `ACP Provider admission exited ${
          exit.code ?? exit.signal
        }: ${stderr.replaceAll(input.secret, '[redacted]')}`
      );
    }
    return {
      success: true,
      primarySessionId,
      secondarySessionId,
      metadata,
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
