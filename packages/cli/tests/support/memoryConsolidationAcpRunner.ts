import { type ChildProcess, spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import { ChildBackedRecordingAcpClient } from './acp/ChildBackedRecordingAcpClient.js';

interface RunnerInput {
  cliEntry: string;
  workspace: string;
  home: string;
  storageRoot: string;
  sessionId: string;
  prompt: string;
  marker: string;
  discoveryPrompt: string;
  discoveryMarker: string;
  secret: string;
}

function loadInput(): RunnerInput {
  const encoded = process.env.BLADE_MEMORY_CONSOLIDATION_ACP_INPUT;
  if (!encoded) throw new Error('Missing BLADE_MEMORY_CONSOLIDATION_ACP_INPUT');
  delete process.env.BLADE_MEMORY_CONSOLIDATION_ACP_INPUT;
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
      reject(new Error('Memory consolidation ACP child did not exit'));
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

async function run(input: RunnerInput) {
  const child = spawn(process.execPath, [input.cliEntry, '--acp'], {
    cwd: input.workspace,
    env: {
      ...process.env,
      HOME: input.home,
      BLADE_STORAGE_ROOT: input.storageRoot,
      BLADE_AUTO_MEMORY: '1',
      BLADE_TELEMETRY_DISABLED: '1',
      BLADE_VERSION: '999.0.0',
      BLADE_API_KEY: input.secret,
      TERM: 'xterm-256color',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (!child.stdin || !child.stdout) {
    child.kill('SIGKILL');
    throw new Error('Memory consolidation ACP stdio is unavailable');
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
    await connection.loadSession({
      sessionId: input.sessionId,
      cwd: input.workspace,
      mcpServers: [],
    });
    sessionId = input.sessionId;
    await connection.setSessionMode({ sessionId, modeId: 'yolo' });
    const result = await connection.prompt({
      sessionId,
      prompt: [{ type: 'text', text: input.prompt }],
    });
    if (result.stopReason !== 'end_turn') {
      throw new Error(`Unexpected memory ACP stop reason: ${result.stopReason}`);
    }
    const serialized = JSON.stringify(client.sessionUpdates);
    const compactions = client.sessionUpdates.flatMap((notification) => {
      const metadata = notification.update._meta?.['blade/compaction'];
      return metadata && typeof metadata === 'object' && !Array.isArray(metadata)
        ? [metadata]
        : [];
    });
    if (serialized.includes(input.secret)) {
      throw new Error('Memory consolidation ACP updates leaked a credential');
    }
    if (stderr.includes(input.secret)) {
      throw new Error('Memory consolidation ACP stderr leaked a credential');
    }
    const discovery = await connection.newSession({
      cwd: input.workspace,
      mcpServers: [],
    });
    await connection.setSessionMode({
      sessionId: discovery.sessionId,
      modeId: 'yolo',
    });
    const discoveryResult = await connection.prompt({
      sessionId: discovery.sessionId,
      prompt: [{ type: 'text', text: input.discoveryPrompt }],
    });
    if (discoveryResult.stopReason !== 'end_turn') {
      throw new Error(
        `Unexpected memory discovery ACP stop reason: ${discoveryResult.stopReason}`
      );
    }

    child.kill('SIGTERM');
    const exit = await waitForChildExit(child);
    await connection.closed.catch(() => undefined);
    if (exit.signal || exit.code !== 0) {
      throw new Error(`Memory consolidation ACP exited ${exit.code ?? exit.signal}`);
    }
    return {
      success: true,
      sessionId,
      finalMarkerSeen: agentText(client, sessionId).includes(input.marker),
      discoveryMarkerSeen: agentText(client, discovery.sessionId).includes(
        input.discoveryMarker
      ),
      compactions,
      updateCount: client.sessionUpdates.length,
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
        error: (error instanceof Error ? error.message : String(error)).replaceAll(
          input.secret,
          '[redacted]'
        ),
      })
    );
    process.exitCode = 1;
  }
}

if (import.meta.main) await main();
