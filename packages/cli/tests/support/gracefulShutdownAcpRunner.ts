import { type ChildProcess, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import { ChildBackedRecordingAcpClient } from './acp/ChildBackedRecordingAcpClient.js';

interface RunnerInput {
  cliEntry: string;
  workspace: string;
  home: string;
  storageRoot: string;
  prompt: string;
  rootPidFile: string;
  secret: string;
}

interface RunnerEvidence {
  success: true;
  sessionId: string;
  output: string;
  rootPid: number;
  commandStartedAt: number;
}

function loadInput(): RunnerInput {
  const encoded = process.env.BLADE_GRACEFUL_ACP_INPUT;
  if (!encoded) throw new Error('Missing BLADE_GRACEFUL_ACP_INPUT');
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

async function waitForRootPid(filePath: string): Promise<number> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      const value = Number.parseInt(await readFile(filePath, 'utf8'), 10);
      if (Number.isSafeInteger(value) && value > 1) {
        process.kill(value, 0);
        return value;
      }
    } catch {
      // The model has not launched the fixture yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for ACP foreground process');
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

function updateShape(
  updates: readonly acp.SessionNotification[]
): Array<{ kind: string; title?: string; status?: string }> {
  return updates.map((notification) => {
    const update = notification.update;
    return {
      kind: update.sessionUpdate,
      ...('title' in update && typeof update.title === 'string'
        ? { title: update.title }
        : {}),
      ...('status' in update && typeof update.status === 'string'
        ? { status: update.status }
        : {}),
    };
  });
}

async function run(input: RunnerInput): Promise<RunnerEvidence> {
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
    stderr = `${stderr}${chunk.toString()}`.slice(-16_000);
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
    const rootPid = await Promise.race([
      waitForRootPid(input.rootPidFile),
      prompt.then(
        (result) => {
          throw new Error(
            `ACP prompt ended before Bash started: ${
              result.stopReason
            }; updates=${JSON.stringify(updateShape(client.sessionUpdates))}`
          );
        },
        (error) => {
          throw new Error(
            `ACP prompt failed before Bash started: ${
              error instanceof Error ? error.message : String(error)
            }; updates=${JSON.stringify(
              updateShape(client.sessionUpdates)
            )}; stderr=${stderr.replaceAll(input.secret, '[redacted]')}`
          );
        }
      ),
    ]);
    const commandStartedAt = Date.now();
    child.kill('SIGTERM');
    const exit = await waitForChildExit(child);
    await prompt.catch(() => undefined);
    await connection.closed.catch(() => undefined);
    if (exit.signal || exit.code !== 0) {
      throw new Error(
        `ACP graceful exit was ${exit.code ?? exit.signal}: ${stderr.replaceAll(
          input.secret,
          '[redacted]'
        )}`
      );
    }
    const serializedUpdates = JSON.stringify(client.sessionUpdates);
    if (serializedUpdates.includes(input.secret)) {
      throw new Error('ACP shutdown traffic contained provider credentials');
    }
    return {
      success: true,
      sessionId,
      output: JSON.stringify(updateShape(client.sessionUpdates)),
      rootPid,
      commandStartedAt,
    };
  } finally {
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
        error:
          error instanceof Error
            ? error.message.replaceAll(input.secret, '[redacted]')
            : String(error).replaceAll(input.secret, '[redacted]'),
      })
    );
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await main();
}
