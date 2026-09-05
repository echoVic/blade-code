import { type ChildProcess, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import {
  finalAssistantText,
  findSessionTranscript,
  readSessionEvents,
} from '../integration/real-api/sessionForkTrajectoryHarness.js';
import { ChildBackedRecordingAcpClient } from './acp/ChildBackedRecordingAcpClient.js';

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
}

function loadInput(): RunnerInput {
  const encoded = process.env.BLADE_FOREGROUND_PROVIDER_RECOVERY_ACP_INPUT;
  if (!encoded) {
    throw new Error('Missing BLADE_FOREGROUND_PROVIDER_RECOVERY_ACP_INPUT');
  }
  return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as RunnerInput;
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
      reject(new Error('ACP Provider recovery child did not exit'));
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

async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 60_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
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
    throw new Error('ACP Provider recovery stdio was unavailable');
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
    if (
      !output.includes('blade/providerRecovery') ||
      !output.includes('"generation"') ||
      !output.includes('"revision"') ||
      !output.includes('\"activity\":\"retry_wait\"') ||
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
    if (
      output.includes(input.secret) ||
      transcript.includes(input.secret) ||
      secondaryTranscript.includes(input.secret)
    ) {
      throw new Error('ACP Provider recovery evidence contained credentials');
    }
    if (client.activeTerminalCount() !== 0) {
      throw new Error('ACP Provider recovery left an active terminal');
    }

    child.kill('SIGTERM');
    const exit = await waitForChildExit(child);
    await connection.closed.catch(() => undefined);
    if (exit.signal || exit.code !== 0) {
      throw new Error(
        `ACP Provider recovery exited ${
          exit.code ?? exit.signal
        }: ${stderr.replaceAll(input.secret, '[redacted]')}`
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
      output: output.slice(-256_000),
      terminalReleaseCount: [...client.releaseCounts.values()].reduce(
        (sum, count) => sum + count,
        0
      ),
      processes: client.releasedProcesses,
    };
  } finally {
    await client.close().catch(() => undefined);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
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
