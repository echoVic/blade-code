import { type ChildProcess, spawn } from 'node:child_process';
import { access, writeFile } from 'node:fs/promises';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import { ChildBackedRecordingAcpClient } from './acp/ChildBackedRecordingAcpClient.js';

const CREDENTIAL_ENV_NAME =
  /(?:^|_)(?:API_?KEY|PRIVATE_KEY|AUTH_TOKEN|ACCESS_TOKEN|TOKEN|SECRET|PASSWORD|CREDENTIALS?)(?:_|$)/i;

interface RunnerInput {
  cliEntry: string;
  workspace: string;
  home: string;
  storageRoot: string;
  primaryPrompt: string;
  firstMarker: string;
  deletedMarker: string;
  movedMarker: string;
  expectedOutput: string;
  providerHoldFile: string;
  providerReleaseFile: string;
  secret: string;
}

interface QueueMetadata {
  version: string;
  pending: number;
  mutable: number;
  locked: number;
  internal: number;
}

const QUEUE_METADATA_KEYS = [
  'internal',
  'locked',
  'mutable',
  'pending',
  'version',
] as const;

function loadInput(): RunnerInput {
  const encoded = process.env.BLADE_FOLLOW_UP_ACP_INPUT;
  if (!encoded) throw new Error('Missing follow-up ACP runner input');
  delete process.env.BLADE_FOLLOW_UP_ACP_INPUT;
  return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as RunnerInput;
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

function queueMetadata(
  client: ChildBackedRecordingAcpClient,
  sessionId: string
): QueueMetadata[] {
  return client.sessionUpdates.flatMap((notification) => {
    if (
      notification.sessionId !== sessionId ||
      notification.update.sessionUpdate !== 'session_info_update'
    ) {
      return [];
    }
    const value = notification.update._meta?.['blade/followUpQueue'];
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    const metadata = value as Record<string, unknown>;
    if (
      JSON.stringify(Object.keys(metadata).sort()) !==
      JSON.stringify(QUEUE_METADATA_KEYS)
    ) {
      throw new Error('ACP queue metadata contains fields outside the allowlist');
    }
    return typeof metadata.version === 'string' &&
      /^[a-f0-9]{64}$/.test(metadata.version) &&
      typeof metadata.pending === 'number' &&
      typeof metadata.mutable === 'number' &&
      typeof metadata.locked === 'number' &&
      typeof metadata.internal === 'number'
      ? [
          {
            version: metadata.version,
            pending: metadata.pending,
            mutable: metadata.mutable,
            locked: metadata.locked,
            internal: metadata.internal,
          },
        ]
      : [];
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

function endChildInput(child: ChildProcess): Promise<void> {
  if (!child.stdin || child.stdin.destroyed || child.stdin.writableEnded) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    child.stdin!.once('error', reject);
    child.stdin!.end(resolve);
  });
}

async function run(input: RunnerInput) {
  const child = spawn(process.execPath, [input.cliEntry, '--acp'], {
    cwd: input.workspace,
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] =>
            typeof entry[1] === 'string' && !CREDENTIAL_ENV_NAME.test(entry[0])
        )
      ),
      HOME: input.home,
      BLADE_STORAGE_ROOT: input.storageRoot,
      BLADE_AUTO_MEMORY: '0',
      BLADE_TELEMETRY_DISABLED: '1',
      BLADE_API_KEY: input.secret,
      TERM: 'xterm-256color',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (!child.stdin || !child.stdout) {
    child.kill('SIGKILL');
    throw new Error('Follow-up ACP stdio was unavailable');
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
  const exitPromise = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  let sessionId = '';
  let closed = false;
  try {
    const initialized = await connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { terminal: true },
    });
    const capabilities = JSON.stringify(initialized.agentCapabilities);
    if (
      capabilities.includes('followUpQueue') ||
      capabilities.includes('queueMutation')
    ) {
      throw new Error('ACP advertised an unsupported queue mutation capability');
    }
    const created = await connection.newSession({
      cwd: input.workspace,
      mcpServers: [],
    });
    sessionId = created.sessionId;
    await connection.setSessionMode({ sessionId, modeId: 'yolo' });
    await waitFor(
      () => queueMetadata(client, sessionId).some((metadata) => metadata.pending === 0),
      'ACP did not project the initial empty queue',
      10_000
    );

    const primary = connection.prompt({
      sessionId,
      prompt: [{ type: 'text', text: input.primaryPrompt }],
    });
    await waitFor(
      () =>
        access(input.providerHoldFile).then(
          () => true,
          () => false
        ),
      'ACP primary request did not reach the Provider hold',
      30_000
    );
    for (const marker of [input.firstMarker, input.movedMarker]) {
      const queued = await connection.prompt({
        sessionId,
        prompt: [{ type: 'text', text: marker }],
      });
      if (queued.stopReason !== 'end_turn') {
        throw new Error(`ACP follow-up stopped with ${queued.stopReason}`);
      }
    }
    await waitFor(
      () => queueMetadata(client, sessionId).some((metadata) => metadata.pending === 2),
      'ACP did not project two pending follow-ups',
      10_000
    );

    await writeFile(input.providerReleaseFile, 'release\n', { mode: 0o600 });
    const primaryResult = await primary;
    if (primaryResult.stopReason !== 'end_turn') {
      throw new Error(`ACP queue trajectory stopped with ${primaryResult.stopReason}`);
    }
    await waitFor(
      () =>
        queueMetadata(client, sessionId).some((metadata) => metadata.locked > 0) &&
        queueMetadata(client, sessionId).at(-1)?.pending === 0 &&
        agentText(client, sessionId).includes(input.expectedOutput),
      `ACP queue did not transition through lock and acknowledgement: ${JSON.stringify({
        metadata: queueMetadata(client, sessionId),
        agentText: agentText(client, sessionId).slice(-2_000),
      })}`,
      180_000
    );
    const updateCountBeforeReload = client.sessionUpdates.length;
    await connection.loadSession({
      sessionId,
      cwd: input.workspace,
      mcpServers: [],
    });
    await connection.setSessionMode({ sessionId, modeId: 'yolo' });
    await waitFor(
      () =>
        client.sessionUpdates.length > updateCountBeforeReload &&
        queueMetadata(client, sessionId).at(-1)?.pending === 0,
      'ACP reload did not project the empty durable queue',
      10_000
    );
    await connection.cancel({ sessionId });
    const metadata = queueMetadata(client, sessionId);
    const serialized = JSON.stringify(metadata);
    if (JSON.stringify(client.sessionUpdates).includes(input.secret)) {
      throw new Error('ACP session updates leaked a credential');
    }
    if (stderr.includes(input.secret)) {
      throw new Error('ACP stderr leaked a credential');
    }
    for (const marker of [
      input.firstMarker,
      input.deletedMarker,
      input.movedMarker,
      input.secret,
    ]) {
      if (serialized.includes(marker))
        throw new Error('ACP queue metadata leaked content');
    }
    await connection.closeSession({ sessionId });
    closed = true;
    await endChildInput(child);
    const exit = await Promise.race([
      exitPromise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Follow-up ACP child did not exit')), 15_000)
      ),
    ]);
    if (exit.code !== 0 || exit.signal !== null) {
      throw new Error(`ACP child exited ${exit.code ?? exit.signal}`);
    }
    return {
      success: true,
      sessionId,
      initialProjected: true,
      pendingProjected: true,
      cancelPreservedQueue: true,
      reloadProjected: true,
      lockedProjected: metadata.some((entry) => entry.locked > 0),
      emptyProjected: true,
      capabilityAbsent: true,
      cancelNotificationAccepted: true,
      normalEof: true,
      cleanupComplete: client.activeTerminalCount() === 0,
      leakedSecrets: [],
    };
  } finally {
    if (!closed && sessionId) {
      await connection.closeSession({ sessionId }).catch(() => undefined);
    }
    await client.close().catch(() => undefined);
    if (!child.stdin.destroyed && !child.stdin.writableEnded) {
      await endChildInput(child).catch(() => undefined);
    }
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await Promise.race([
        exitPromise.catch(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
      ]);
    }
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}

async function main(): Promise<void> {
  const input = loadInput();
  try {
    process.stdout.write(JSON.stringify(await run(input)));
  } catch (error) {
    const detail =
      error instanceof Error &&
      'stdout' in error &&
      typeof (error as { stdout?: unknown }).stdout === 'string'
        ? (error as { stdout: string }).stdout
        : '';
    process.stdout.write(
      JSON.stringify({
        success: false,
        error: `${error instanceof Error ? error.message : String(error)}${
          detail ? `; ${detail}` : ''
        }`.replaceAll(input.secret, '[redacted]'),
      })
    );
    process.exitCode = 1;
  }
}

if (import.meta.main) await main();
