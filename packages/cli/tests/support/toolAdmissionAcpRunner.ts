import { type ChildProcess, spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import { findSessionTranscript } from '../integration/real-api/sessionForkTrajectoryHarness.js';
import { ChildBackedRecordingAcpClient } from './acp/ChildBackedRecordingAcpClient.js';
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

function childEnvironment(input: RunnerInput): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: input.home,
    BLADE_STORAGE_ROOT: input.storageRoot,
    BLADE_AUTO_MEMORY: '0',
    BLADE_TELEMETRY_DISABLED: '1',
    TERM: 'xterm-256color',
  };
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
      reject(new Error('ACP child did not exit after SIGTERM'));
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
  timeoutMs = 90_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
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
  const child = spawn(process.execPath, [input.cliEntry, '--acp'], {
    cwd: input.workspace,
    env: childEnvironment(input),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (!child.stdin || !child.stdout) {
    child.kill('SIGKILL');
    throw new Error('ACP child stdio was unavailable');
  }
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer | string) => {
    stderr = `${stderr}${chunk.toString()}`.slice(-32_000);
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
          'ACP did not project two queued tool calls'
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

    child.kill('SIGTERM');
    const exit = await waitForChildExit(child);
    await connection.closed.catch(() => undefined);
    if (exit.signal || exit.code !== 0) {
      throw new Error(
        `ACP graceful exit was ${exit.code ?? exit.signal}: ${stderr.replaceAll(
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
    await client.close().catch(() => undefined);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
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
