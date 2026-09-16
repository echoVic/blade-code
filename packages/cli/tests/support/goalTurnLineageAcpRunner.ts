import { type ChildProcess, spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import { ChildBackedRecordingAcpClient } from './acp/ChildBackedRecordingAcpClient.js';
import { waitForCondition as waitFor, waitForChildExit } from './asyncTestUtils.js';

interface RunnerInput {
  cliEntry: string;
  workspace: string;
  home: string;
  storageRoot: string;
  sessionId: string;
  secret: string;
}

function loadInput(): RunnerInput {
  const encoded = process.env.BLADE_GOAL_TURN_LINEAGE_ACP_INPUT;
  if (!encoded) throw new Error('Missing BLADE_GOAL_TURN_LINEAGE_ACP_INPUT');
  delete process.env.BLADE_GOAL_TURN_LINEAGE_ACP_INPUT;
  return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as RunnerInput;
}

function metadata(
  client: ChildBackedRecordingAcpClient,
  key: 'blade/goal' | 'blade/goalContinuation'
): Array<Record<string, unknown>> {
  return client.sessionUpdates.flatMap((notification) => {
    const value = notification.update._meta?.[key];
    return value && typeof value === 'object' && !Array.isArray(value)
      ? [value as Record<string, unknown>]
      : [];
  });
}

async function main(): Promise<void> {
  const input = loadInput();
  const child = spawn(process.execPath, [input.cliEntry, '--acp'], {
    cwd: input.workspace,
    env: {
      ...process.env,
      HOME: input.home,
      BLADE_STORAGE_ROOT: input.storageRoot,
      BLADE_AUTO_MEMORY: '0',
      BLADE_TELEMETRY_DISABLED: '1',
      BLADE_VERSION: '999.0.0',
      BLADE_API_KEY: input.secret,
      TERM: 'xterm-256color',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (!child.stdin || !child.stdout) {
    child.kill('SIGKILL');
    throw new Error('Goal turn lineage ACP stdio is unavailable');
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

  try {
    await connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { terminal: true },
    });
    await connection.loadSession({
      sessionId: input.sessionId,
      cwd: input.workspace,
      mcpServers: [],
    });
    await waitFor(
      () =>
        metadata(client, 'blade/goal').some(
          (goal) => goal.status !== 'active' && goal.status !== 'verifying'
        ) ||
        child.exitCode !== null ||
        child.signalCode !== null,
      'ACP did not observe a terminal Goal lineage',
      220_000
    );
    const continuations = metadata(client, 'blade/goalContinuation');
    const goals = metadata(client, 'blade/goal');
    if (!goals.some((goal) => goal.status === 'blocked')) {
      throw new Error(
        `ACP Goal ended without the expected blocked state: ${JSON.stringify({
          statuses: goals.map((goal) => goal.status),
          continuations: continuations.map((goal) => goal.continuation),
          exitCode: child.exitCode,
          signalCode: child.signalCode,
        })}`
      );
    }
    const serialized = JSON.stringify(client.sessionUpdates);
    if (serialized.includes(input.secret)) {
      throw new Error('ACP Goal turn lineage projection leaked a credential');
    }

    child.kill('SIGTERM');
    const exit = await waitForChildExit(child, 10_000);
    await connection.closed.catch(() => undefined);
    if (exit.signal || exit.code !== 0) {
      throw new Error(
        `Goal turn lineage ACP exited ${exit.code ?? exit.signal}: ${stderr.replaceAll(
          input.secret,
          '[redacted]'
        )}`
      );
    }
    process.stdout.write(
      JSON.stringify({
        success: true,
        continuationLineage: continuations.at(-1)?.turnLineage,
        goalLineage: goals.at(-1)?.turnLineage,
      })
    );
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
  } finally {
    await client.close().catch(() => undefined);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}

if (import.meta.main) await main();
