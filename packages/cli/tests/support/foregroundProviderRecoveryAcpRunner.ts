import { type ChildProcess, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import { findSessionTranscript } from '../integration/real-api/sessionForkTrajectoryHarness.js';
import { ChildBackedRecordingAcpClient } from './acp/ChildBackedRecordingAcpClient.js';

interface RunnerInput {
  cliEntry: string;
  workspace: string;
  home: string;
  storageRoot: string;
  prompt: string;
  marker: string;
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
    const result = await connection.prompt({
      sessionId,
      prompt: [{ type: 'text', text: input.prompt }],
    });
    if (result.stopReason !== 'end_turn') {
      throw new Error(
        `Unexpected ACP Provider recovery stop reason: ${result.stopReason}`
      );
    }

    const transcript = await readFile(
      findSessionTranscript(input.storageRoot, sessionId),
      'utf8'
    );
    if (!transcript.includes(input.marker)) {
      throw new Error('ACP transcript did not contain the recovery marker');
    }
    const output = JSON.stringify(client.sessionUpdates);
    if (
      !output.includes('blade/providerRetry') ||
      !output.includes('bounded_foreground') ||
      !output.includes('recovered')
    ) {
      throw new Error('ACP did not project bounded Provider recovery metadata');
    }
    if (output.includes(input.secret) || transcript.includes(input.secret)) {
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
